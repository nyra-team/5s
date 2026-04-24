/**
 * Wrapper entry point for the integration suite. We do NOT load tests in this
 * process; instead we:
 *
 *   1. Make sure a cached "template" Postgres database exists with the current
 *      `@workspace/db` schema applied. We hash the drizzle schema source and
 *      only re-run `drizzle-kit push` when the hash has drifted from what's
 *      stamped in the template DB. On a warm cache this step is a single
 *      cheap `SELECT` against an existing database.
 *   2. Mint a brand-new Postgres database for THIS test run by cloning the
 *      template via `CREATE DATABASE ... TEMPLATE`. Cloning is essentially
 *      an `O(template-size)` file copy inside Postgres and on a tiny test
 *      schema completes in well under a second.
 *   3. Spawn the actual `tsx --test` process with `DATABASE_URL` pointing at
 *      that fresh database.
 *   4. Wait for it to finish, then drop the per-run database (NOT the
 *      template) and forward the exit code.
 *
 * Why a wrapper process rather than top-level-await in the test entry?
 *
 * ECMAScript modules with top-level await are async modules. While they
 * await, sibling modules in the import graph are still allowed to evaluate
 * synchronously. That means if we set `process.env.DATABASE_URL` from inside
 * a top-level await in the test entry, `@workspace/db`'s connection pool
 * (constructed at module init from `process.env.DATABASE_URL`) can race
 * ahead and bind to the OLD url before our setup completes. Spawning a
 * subprocess sidesteps the race entirely: by the time the test process
 * starts, the env is already correct and the database already exists.
 *
 * Why per-run isolation at all?
 *
 * Previously every test inserted uniquely-tagged rows into the shared dev
 * database and tried to clean them up at the end. That works for a single
 * sequential run but not when:
 *
 *   - The suite is run with `--test-concurrency` > 1 (rows from one test
 *     leak into endpoints like `GET /api/shift/live` that aggregate across
 *     ALL areas in the current shift).
 *   - Two `pnpm test` invocations run at the same time on CI.
 *   - Tests run while the dev server is up — they briefly pollute the dev
 *     UI and a crashing test leaves orphan rows.
 *
 * A per-run dedicated database eliminates all of those.
 *
 * Override knob: if `TEST_DATABASE_URL` is set, we use it as the admin
 * connection (used to issue `CREATE DATABASE`/`DROP DATABASE`) so CI can
 * keep the blast radius off the production cluster. Otherwise we fall back
 * to `DATABASE_URL`.
 */
import pg from "pg";
import { execSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!adminUrl) {
  throw new Error(
    "DATABASE_URL (or TEST_DATABASE_URL) must be set to run the integration tests",
  );
}

const parsed = new URL(adminUrl);
const baseDbName =
  decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres";
const suffix = randomBytes(4).toString("hex");
const testDbName = `${baseDbName}_test_${suffix}`;
const templateDbName = `${baseDbName}_test_template`;

// Stable advisory-lock id derived from the template name. Postgres advisory
// locks are session-scoped, so any crash automatically releases it. We use a
// 32-bit signed integer so it serializes cleanly via the pg driver.
const TEMPLATE_LOCK_ID = (() => {
  const digest = createHash("sha256")
    .update(`api-server-test-template:${templateDbName}`)
    .digest();
  return digest.readInt32BE(0);
})();

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildUrl(dbName: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
}

const dbPkgDir = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../lib/db");
})();

/**
 * Hash everything that can change what `pnpm push-force` produces:
 *   - every `.ts` file under the drizzle schema directory (recursively, so
 *     nested schema folders added later are still picked up),
 *   - the drizzle config (which points at them),
 *   - the prepare-push script that runs first.
 *
 * Anything outside this set won't invalidate the cached template.
 */
function collectSchemaFiles(dir: string, prefix: string): Array<{
  label: string;
  abs: string;
}> {
  const out: Array<{ label: string; abs: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const abs = path.join(dir, entry.name);
    const label = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectSchemaFiles(abs, label));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push({ label, abs });
    }
  }
  return out;
}

function computeSchemaHash(): string {
  const inputs: Array<{ label: string; abs: string }> = [];

  const schemaDir = path.join(dbPkgDir, "src/schema");
  inputs.push(...collectSchemaFiles(schemaDir, "schema"));
  inputs.push({
    label: "drizzle.config.ts",
    abs: path.join(dbPkgDir, "drizzle.config.ts"),
  });
  inputs.push({
    label: "scripts/prepare-push.mjs",
    abs: path.join(dbPkgDir, "scripts/prepare-push.mjs"),
  });

  const hash = createHash("sha256");
  for (const { label, abs } of inputs) {
    hash.update(label);
    hash.update("\0");
    hash.update(fs.readFileSync(abs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function withAdmin<T>(
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readTemplateHash(): Promise<string | null> {
  const client = new pg.Client({ connectionString: buildUrl(templateDbName) });
  await client.connect();
  try {
    // First check whether the metadata table exists at all. A template that
    // predates this caching layer (or one that crashed mid-rebuild before
    // we got to write the stamp) won't have it yet — that's the only
    // expected "no hash" case. Any other failure should bubble up so we
    // don't silently force a rebuild on top of a real DB problem.
    const present = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('public._test_schema_meta') IS NOT NULL AS exists`,
    );
    if (!present.rows[0]?.exists) return null;

    const r = await client.query<{ hash: string }>(
      `SELECT hash FROM _test_schema_meta LIMIT 1`,
    );
    return r.rows[0]?.hash ?? null;
  } finally {
    await client.end();
  }
}

async function writeTemplateHash(hash: string): Promise<void> {
  const client = new pg.Client({ connectionString: buildUrl(templateDbName) });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _test_schema_meta (hash text PRIMARY KEY)`,
    );
    await client.query(`DELETE FROM _test_schema_meta`);
    await client.query(`INSERT INTO _test_schema_meta (hash) VALUES ($1)`, [
      hash,
    ]);
  } finally {
    await client.end();
  }
}

function pushSchema(targetUrl: string): void {
  execSync("pnpm push-force", {
    cwd: dbPkgDir,
    env: { ...process.env, DATABASE_URL: targetUrl },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/**
 * Make sure the template database exists and matches `schemaHash`. Refresh it
 * (drop + recreate + push) only if the hash has drifted or the DB is missing.
 *
 * The whole check-and-maybe-refresh runs while holding a Postgres advisory
 * lock so two concurrent test runs can't both decide to rebuild the template.
 */
async function ensureTemplate(schemaHash: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_ID]);
    try {
      const exists = await admin.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
        [templateDbName],
      );
      if (exists.rows[0]?.exists) {
        const stored = await readTemplateHash();
        if (stored === schemaHash) {
          return;
        }
        // Stale (or never stamped). Force-disconnect anything still attached
        // and drop so we can rebuild from scratch.
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [templateDbName],
        );
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(templateDbName)}`,
        );
      }

      await admin.query(`CREATE DATABASE ${quoteIdent(templateDbName)}`);
      pushSchema(buildUrl(templateDbName));
      await writeTemplateHash(schemaHash);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_ID]);
    }
  });
}

async function createTestDatabase(): Promise<void> {
  // Hold the template lock briefly during the clone so it can't race with a
  // concurrent run that's mid-refresh of the template (Postgres refuses to
  // CREATE DATABASE ... TEMPLATE when other sessions are connected to the
  // template, and refuses to drop the template if anyone is cloning from it).
  await withAdmin(async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK_ID]);
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [templateDbName],
      );
      await admin.query(
        `CREATE DATABASE ${quoteIdent(testDbName)} TEMPLATE ${quoteIdent(
          templateDbName,
        )}`,
      );
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK_ID]);
    }
  });
}

async function dropTestDatabase(): Promise<void> {
  await withAdmin(async (admin) => {
    // Force-disconnect anything still attached so the DROP doesn't block.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [testDbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(testDbName)}`);
  });
}

function runTests(testUrl: string): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runEntry = path.join(here, "run.ts");
  // Use the same node binary that's executing this wrapper so we don't pick
  // up a different version from PATH. tsx is invoked via `pnpm exec` so it
  // resolves through the workspace's installed copy.
  const child = spawn(
    "pnpm",
    ["exec", "tsx", "--test", "--test-reporter=spec", runEntry],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: testUrl },
    },
  );
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else if (signal) resolve(1);
      else resolve(1);
    });
  });
}

const schemaHash = computeSchemaHash();
await ensureTemplate(schemaHash);
await createTestDatabase();
const testUrl = buildUrl(testDbName);
let exitCode = 1;
try {
  exitCode = await runTests(testUrl);
} finally {
  await dropTestDatabase().catch((err) => {
    // Surface the failure but don't mask the test exit code.
    console.error(`[test-setup] failed to drop ${testDbName}:`, err);
  });
}
process.exit(exitCode);
