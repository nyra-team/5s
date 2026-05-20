import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Hosted Supabase requires SSL but presents a cert chain that node's bundled
// CA roots flag as self-signed. We trust the connection because we initiated
// it to a known host. The pg driver short-circuits our Pool `ssl` option
// when the connection string already carries `sslmode=require`, so we strip
// that parameter from the URL via the WHATWG URL API (which preserves all
// other params like `options=-c search_path=…`) and pass
// `ssl: { rejectUnauthorized: false }` directly instead. Local plaintext
// URLs (no `sslmode`) fall through with `ssl: false`.
const rawUrl = process.env.DATABASE_URL;
const parsed = new URL(rawUrl);
const sslmode = parsed.searchParams.get("sslmode");
const wantsSsl = !!sslmode && /^(require|verify-ca|verify-full)$/i.test(sslmode);
if (sslmode) parsed.searchParams.delete("sslmode");
const url = parsed.toString();
const ssl = wantsSsl ? { rejectUnauthorized: false } : false;
export const pool = new Pool({ connectionString: url, ssl });
export const db = drizzle(pool, { schema });

export * from "./schema";
