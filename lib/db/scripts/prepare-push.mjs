import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set; cannot prepare schema push.");
  process.exit(1);
}

const LEGACY_TABLES = ["ideal_photos"];

const LEGACY_COLUMNS = [
  { table: "submissions", column: "similarity_to_ideal" },
];

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();

  for (const table of LEGACY_TABLES) {
    const { rows } = await client.query(
      "SELECT to_regclass($1) AS oid",
      [`public.${table}`],
    );
    if (rows[0]?.oid) {
      console.log(`[prepare-push] Dropping legacy table "public.${table}"...`);
      await client.query(`DROP TABLE "public"."${table}" CASCADE`);
    }
  }

  for (const { table, column } of LEGACY_COLUMNS) {
    const { rows } = await client.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = $2`,
      [table, column],
    );
    if (rows.length > 0) {
      console.log(
        `[prepare-push] Dropping legacy column "public.${table}"."${column}"...`,
      );
      await client.query(
        `ALTER TABLE "public"."${table}" DROP COLUMN "${column}"`,
      );
    }
  }
} catch (err) {
  console.error("[prepare-push] Failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
