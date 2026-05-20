import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set; cannot apply migrations.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../migrations");
const journalPath = path.join(migrationsFolder, "meta", "_journal.json");

/**
 * Drizzle's migrator stamps each applied migration in
 * `drizzle.__drizzle_migrations` with the SHA256 of the migration's SQL file
 * and the `when` timestamp from `_journal.json`. When this repo predates the
 * migrations workflow, the dev/prod database already contains every table from
 * the baseline migration but the journal table is empty, so a naive `migrate`
 * call would replay `0000_baseline.sql` and crash on the first
 * `CREATE TABLE` / FK constraint that already exists.
 *
 * To bring those existing databases to the migration baseline without data
 * loss we stamp the baseline migration as already applied iff:
 *   1. `drizzle.__drizzle_migrations` is empty (no migration has ever run), and
 *   2. ALL of the sentinel tables from the baseline are already present in
 *      `public`. We require multiple core tables (not just one) so a
 *      partially-provisioned database — e.g. one where only `users` was
 *      created by hand — doesn't get incorrectly stamped as "fully at
 *      baseline" and then skip the rest of the baseline DDL.
 *
 * Brand-new databases skip the stamp (none of the sentinel tables exist) and
 * let drizzle apply the baseline normally.
 */
const BASELINE_SENTINEL_TABLES = [
  "users",
  "areas",
  "submissions",
  "labels",
  "facility_settings",
];
async function stampBaselineIfPreExisting(pool) {
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const baseline = journal.entries?.[0];
  if (!baseline) return;

  const baselineSqlPath = path.join(migrationsFolder, `${baseline.tag}.sql`);
  const baselineSql = readFileSync(baselineSqlPath, "utf8");
  const baselineHash = createHash("sha256").update(baselineSql).digest("hex");

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
         id SERIAL PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       )`,
    );

    const { rows: journalRows } = await client.query(
      `SELECT 1 FROM "drizzle"."__drizzle_migrations" LIMIT 1`,
    );
    if (journalRows.length > 0) return;

    const { rows: presenceRows } = await client.query(
      `SELECT
         tname,
         to_regclass('public.' || quote_ident(tname)) IS NOT NULL AS present
       FROM unnest($1::text[]) AS tname`,
      [BASELINE_SENTINEL_TABLES],
    );
    const present = presenceRows
      .filter((r) => r.present)
      .map((r) => r.tname);
    const missing = presenceRows
      .filter((r) => !r.present)
      .map((r) => r.tname);

    if (present.length === 0) return;

    if (missing.length > 0) {
      throw new Error(
        `[migrate] Refusing to stamp baseline: database is partially provisioned. ` +
          `Found tables: [${present.join(", ")}]; missing tables: [${missing.join(", ")}]. ` +
          `Either restore the missing tables, or drop the existing ones and re-run so the baseline migration can apply cleanly.`,
      );
    }

    await client.query(
      `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
       VALUES ($1, $2)`,
      [baselineHash, baseline.when],
    );
    console.log(
      `[migrate] Stamped baseline migration "${baseline.tag}" as already applied (existing schema detected).`,
    );
  } finally {
    client.release();
  }
}

// Hosted Supabase requires SSL but its pooler presents a cert chain that
// node's bundled CA roots flag as self-signed. We trust the connection
// because we initiated it to a known host. The pg driver short-circuits
// our Pool `ssl` option when the connection string already carries
// `sslmode=require`, so we use the WHATWG URL API to drop just that one
// query param (preserving siblings like `options=-c search_path=…`) and
// pass `ssl: { rejectUnauthorized: false }` directly instead. Local
// plaintext URLs (no `sslmode`) fall through with `ssl: false`.
const rawUrl = process.env.DATABASE_URL ?? "";
const parsed = new URL(rawUrl);
const sslmode = parsed.searchParams.get("sslmode");
const wantsSsl = !!sslmode && /^(require|verify-ca|verify-full)$/i.test(sslmode);
if (sslmode) parsed.searchParams.delete("sslmode");
const url = parsed.toString();
const ssl = wantsSsl ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: url, ssl });

try {
  await stampBaselineIfPreExisting(pool);
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] Migrations applied successfully.");
} catch (err) {
  console.error("[migrate] Failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
