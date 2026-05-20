import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Lazy-initialized Supabase client for the browser. We use it only for
 * the password-reset email flow:
 *   - `supabase.auth.resetPasswordForEmail(email, { redirectTo })`
 *     triggers Supabase's hosted email service to send a recovery email.
 *   - `supabase.auth.exchangeCodeForSession(code)` on the reset-password
 *     page exchanges the magic-link code for a Supabase session so the
 *     user can call `supabase.auth.updateUser({ password })` to rotate
 *     the credential on auth.users.
 *
 * Returns `null` when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY aren't
 * set — callers must check and fall back to the dev-link flow.
 *
 * The client is created at module init (top-level) rather than lazily so
 * Supabase's session-detection on page-load picks up any `?code=` query
 * string from a recovery redirect before our React tree mounts.
 */

let _client: SupabaseClient | null = null;

const url = (import.meta as any).env?.VITE_SUPABASE_URL ?? "";
const anonKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? "";

if (url && anonKey) {
  _client = createClient(url, anonKey, {
    auth: {
      // Our app uses its own JWT — Supabase's session is only used during
      // the password-reset round-trip. Disable persistence so a recovery
      // session doesn't linger across reloads.
      persistSession: false,
      autoRefreshToken: false,
      // Detect `?code=…` and `?token_hash=…` on the URL automatically so
      // the reset-password page can immediately call getSession() without
      // hand-rolling the exchange.
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

export function getSupabase(): SupabaseClient | null {
  return _client;
}

export function isSupabaseAuthConfigured(): boolean {
  return _client !== null;
}
