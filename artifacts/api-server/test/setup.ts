/**
 * Wrapper entry point for the integration suite. We do NOT load tests in this
 * process; instead we:
 *
 *   1. Mint a brand-new Postgres database for THIS test run.
 *   2. Apply the current `@workspace/db` schema to it (drizzle push).
 *   3. Spawn the actual `tsx --test` process with `DATABASE_URL` pointing at
 *      that fresh database.
 *   4. Wait for it to finish, then drop the database (and forward the exit
 *      code).
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
import { randomBytes } from "node:crypto";
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

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildTestUrl(): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${encodeURIComponent(testDbName)}`;
  return u.toString();
}

async function createTestDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(testDbName)}`);
  } finally {
    await client.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // Force-disconnect anything still attached so the DROP doesn't block.
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [testDbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(testDbName)}`);
  } finally {
    await client.end();
  }
}

function pushSchema(testUrl: string): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbPkg = path.resolve(here, "../../../lib/db");
  execSync("pnpm push-force", {
    cwd: dbPkg,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: ["ignore", "inherit", "inherit"],
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

await createTestDatabase();
const testUrl = buildTestUrl();
let exitCode = 1;
try {
  pushSchema(testUrl);
  exitCode = await runTests(testUrl);
} finally {
  await dropTestDatabase().catch((err) => {
    // Surface the failure but don't mask the test exit code.
    console.error(`[test-setup] failed to drop ${testDbName}:`, err);
  });
}
process.exit(exitCode);
