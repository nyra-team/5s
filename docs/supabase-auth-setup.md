# Supabase Auth — email transport setup

The api-server can send password-reset emails through Supabase's hosted
email service. This document covers the one-time dashboard configuration
that has to happen on Supabase's side before emails actually go out — the
code paths are wired but Supabase needs SMTP credentials and redirect URL
allow-lists configured in the dashboard.

## How the flow works

1. User submits an email on `/login` → "Forgot password?".
2. Backend `POST /api/auth/forgot-password`:
   - Looks up the email in `public.users` (our domain users).
   - If present, ensures a matching row exists in `auth.users` (Supabase's
     auth table) — creates one with a random throwaway password if missing.
     This row exists purely as a "carrier" so Supabase will accept a
     `resetPasswordForEmail` call for it.
   - Returns `{ ok: true, viaSupabase: true, devResetUrl?: string }`.
3. Frontend, if `viaSupabase` is true AND `VITE_SUPABASE_ANON_KEY` is set,
   calls `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/reset-password })`.
   This triggers Supabase to send the recovery email from their hosted
   template, with a link back to our `/reset-password` page that carries a
   one-time PKCE code.
4. User clicks the link → lands on `/reset-password?code=…`.
5. supabase-js (with `detectSessionInUrl: true`) exchanges the code for a
   Supabase session. The page reads `supabase.auth.getSession()`.
6. User types new password and submits:
   - Frontend calls `supabase.auth.updateUser({ password })` → rotates the
     password on `auth.users`.
   - Frontend calls our backend `POST /api/auth/sync-password-from-supabase`
     with the Supabase access token + new password.
   - Backend verifies the token by hitting `/auth/v1/user` (Supabase
     rejects forged tokens because only Supabase signs them), then
     bcrypt-hashes the password into `public.users.password_hash`.
7. User is signed out of the Supabase recovery session and redirected to
   `/login` with the new credential active in both stores.

## Dashboard configuration (one-time)

These steps live in the [Supabase Dashboard](https://supabase.com/dashboard),
not in code:

### 1. SMTP provider

**Project Settings → Authentication → SMTP Settings.**

Supabase's free tier limits outbound email to a few per hour from their
default SMTP — fine for testing, not for production. Plug in your own SMTP
credentials (Resend, SendGrid, Postmark, AWS SES, etc.) so emails actually
reach operators.

Required fields:

- Sender email
- Sender name
- Host / port / username / password (from the SMTP provider)
- Minimum-interval-between-emails (defaults to 60 s; safe to lower)

### 2. Email template

**Project Settings → Authentication → Email Templates → "Reset Password".**

The default template works but feels like a stock Supabase email. Customize
the subject line + HTML body to mention Granules / 5S Compliance.

The template's reset link uses `{{ .ConfirmationURL }}` which is the
short-lived magic-link URL Supabase generates; don't replace this with a
direct link to our page.

### 3. Site URL + redirect allow-list

**Project Settings → Authentication → URL Configuration.**

- **Site URL**: `https://your-prod-host` (or `http://localhost:3000` for
  local dev). Supabase falls back to this when no explicit `redirectTo`
  is provided.
- **Additional Redirect URLs**: add every host the SPA might be served
  from:
  - `http://localhost:3000/reset-password`
  - `http://172.30.101.2:3000/reset-password` (or your LAN IP for
    same-network phone testing)
  - `https://your-prod-host/reset-password`

Supabase rejects any `redirectTo` that doesn't match an entry on this
list, so missing a host means the recovery email's link goes to a
Supabase error page instead of our SPA.

### 4. Auth user creation policy

By default, anyone can call `POST /auth/v1/admin/users` with the
`service_role` key. That's fine because our api-server is the only
holder of the service-role key — we use it server-side to ensure
`auth.users` rows exist on demand.

You do NOT need to enable "Allow new users to sign up" for our flow —
the api-server's admin call bypasses that gate.

## Local development without Supabase email

If `VITE_SUPABASE_ANON_KEY` is empty (the default), the frontend skips the
Supabase email call entirely. The backend still ensures `auth.users` rows
exist (because `SUPABASE_SERVICE_ROLE_KEY` IS set), so the prep work
happens silently — you just don't see a real email get sent.

In that mode, the dev-mode `devResetUrl` is surfaced inline on the success
card, and clicking it walks you through our backend-token reset flow
(`?token=…` on `/reset-password`). Identical user experience apart from
"copy this link" vs "open your inbox".

## Turning it on in prod

1. Paste the project's `anon` key into `.env` as `VITE_SUPABASE_ANON_KEY`.
2. Configure SMTP in the Supabase Dashboard (step 1 above).
3. Add your prod host to the redirect URL allow-list (step 3).
4. `NODE_ENV=production` (so `devResetUrl` stops leaking in the response
   body — gated by `isDev()`).
5. Restart the api-server: `./stop.sh && ./start.sh`.

Operators now receive a real Supabase-templated email when they hit
"Forgot password?".
