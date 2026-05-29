// Promote (or demote) a user's role by email. Primary use: bootstrap the very
// first ADMIN, since the app has no way to self-provision one — every signup
// is an OPERATOR and only an existing admin can grant elevated roles.
//
// Usage:
//   DATABASE_URL=... node lib/db/scripts/promote-admin.mjs <email> [ROLE]
//
// ROLE defaults to ADMIN; OPERATOR / MANAGER / ADMIN are accepted. The lookup
// is case-insensitive and ignores soft-deleted accounts.

import pg from "pg";

const { Pool } = pg;

const email = (process.argv[2] ?? "").trim().toLowerCase();
const role = (process.argv[3] ?? "ADMIN").trim().toUpperCase();

if (!email) {
  console.error("Usage: node promote-admin.mjs <email> [OPERATOR|MANAGER|ADMIN]");
  process.exit(1);
}
if (!["OPERATOR", "MANAGER", "ADMIN"].includes(role)) {
  console.error(`Invalid role "${role}". Must be OPERATOR, MANAGER, or ADMIN.`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// Mirror migrate.mjs's SSL handling: Supabase's pooler cert trips node's CA
// check, and pg short-circuits the `ssl` option when sslmode is in the URL —
// so strip sslmode and pass rejectUnauthorized:false explicitly.
const parsed = new URL(process.env.DATABASE_URL);
const sslmode = parsed.searchParams.get("sslmode");
const wantsSsl = !!sslmode && /^(require|verify-ca|verify-full)$/i.test(sslmode);
if (sslmode) parsed.searchParams.delete("sslmode");
const pool = new Pool({
  connectionString: parsed.toString(),
  ssl: wantsSsl ? { rejectUnauthorized: false } : false,
});

try {
  const { rows } = await pool.query(
    `UPDATE users
        SET role = $2, requested_role = NULL
      WHERE lower(email) = $1 AND deleted_at IS NULL
      RETURNING id, email, role`,
    [email, role],
  );
  if (rows.length === 0) {
    console.error(`No active user found with email "${email}".`);
    process.exitCode = 1;
  } else {
    const u = rows[0];
    console.log(`✓ ${u.email} (id ${u.id}) is now ${u.role}.`);
  }
} catch (err) {
  console.error("Failed:", err.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
