/**
 * Supabase Auth Admin helpers — REST wrappers around /auth/v1/admin/*.
 *
 * We use these to back the password-reset email flow without fully
 * migrating our user system to Supabase Auth. Pattern:
 *
 *   1. Users continue to live in `public.users` (custom JWT-signed sessions).
 *   2. When a password reset is requested, we ensure an `auth.users` row
 *      exists for that email — using a long random throwaway password.
 *      The auth.users row is purely a "carrier" so Supabase will accept
 *      `resetPasswordForEmail` and send a recovery email from its hosted
 *      template.
 *   3. The reset link the user clicks comes back to our /reset-password
 *      page with a code; the frontend exchanges that for a Supabase
 *      session, sets the new password on auth.users (via supabase-js
 *      updateUser), AND calls our backend so we update the bcrypt hash
 *      in `public.users` to match.
 *
 * Same skip-if-unconfigured pattern as supabase-storage.ts: missing
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY short-circuits every export to
 * a no-op so local-only dev keeps working without any Supabase setup.
 */
import crypto from "node:crypto";
import { logger } from "./logger.js";

let _url = "";
let _key = "";
let _enabled = false;

function init(): void {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) {
    _enabled = false;
    return;
  }
  _url = url.replace(/\/+$/, "");
  _key = key;
  _enabled = true;
}

init();

export function isSupabaseAuthEnabled(): boolean {
  return _enabled;
}

interface AdminUserShape {
  id: string;
  email: string;
}

/**
 * Look up an auth.users row by email. Returns the row if it exists,
 * `null` if Supabase says it doesn't, or `null` on any error (caller
 * treats absence and error the same — fall through to creating one).
 */
async function findAuthUserByEmail(email: string): Promise<AdminUserShape | null> {
  if (!_enabled) return null;
  try {
    // The list endpoint supports `email` as a filter param — single result
    // for an exact match, or empty `users` array.
    const res = await fetch(
      `${_url}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${_key}`,
          apikey: _key,
        },
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, email }, "supabase admin list-users failed");
      return null;
    }
    const data = (await res.json()) as { users?: AdminUserShape[] };
    const u = data.users?.[0];
    return u ?? null;
  } catch (err) {
    logger.warn({ err, email }, "supabase admin list-users threw");
    return null;
  }
}

/**
 * Ensure an auth.users row exists for `email`. If absent, creates one
 * with a 32-byte random throwaway password and `email_confirm: true`
 * (so Supabase doesn't try to send a confirmation email for the throwaway
 * — that confirmation would refer to a password the user never set).
 *
 * Returns true if the row exists at the end (created or pre-existing),
 * false on any failure. Callers should treat false as "skip the Supabase
 * email flow and surface the dev fallback instead".
 */
export async function ensureAuthUserExists(email: string): Promise<boolean> {
  if (!_enabled) return false;
  const existing = await findAuthUserByEmail(email);
  if (existing) return true;

  try {
    const res = await fetch(`${_url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${_key}`,
        apikey: _key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        // Throwaway — the user never logs into Supabase Auth directly.
        // The recovery flow rotates this on first reset anyway.
        password: crypto.randomBytes(32).toString("hex"),
        email_confirm: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Some Supabase versions return 422 when an email is already
      // registered — treat that as success (idempotent path).
      if (res.status === 422 && body.includes("already")) return true;
      logger.warn({ status: res.status, body: body.slice(0, 200), email }, "supabase admin create-user failed");
      return false;
    }
    logger.info({ email }, "auth.users row created for password-reset email carrier");
    return true;
  } catch (err) {
    logger.warn({ err, email }, "supabase admin create-user threw");
    return false;
  }
}

/**
 * Update an auth.users row's password. Called from our /auth/reset-password
 * endpoint after the user finishes the Supabase-redirected flow so both
 * password stores stay in sync — the bcrypt hash in public.users (what our
 * JWT login uses) and the Supabase-hashed password in auth.users (what
 * Supabase's email flow uses for future resets).
 */
export async function updateAuthUserPassword(email: string, newPassword: string): Promise<boolean> {
  if (!_enabled) return false;
  const u = await findAuthUserByEmail(email);
  if (!u) return false;
  try {
    const res = await fetch(`${_url}/auth/v1/admin/users/${u.id}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${_key}`,
        apikey: _key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body: body.slice(0, 200), email }, "supabase admin update-user failed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, email }, "supabase admin update-user threw");
    return false;
  }
}
