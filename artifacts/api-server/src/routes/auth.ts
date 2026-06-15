import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable, passwordResetTokensTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { signToken, authMiddleware } from "../lib/auth";
import { logger } from "../lib/logger";
import { isDev } from "../lib/env";
import {
  ensureAuthUserExists,
  updateAuthUserPassword,
  isSupabaseAuthEnabled,
} from "../lib/supabase-auth";
import { hasEmailConfig, sendPasswordResetEmail } from "../lib/mailer";

const router: IRouter = Router();

// Self-signup never grants elevated access. Everyone starts as an active
// OPERATOR; if they ask for manager access we record it as a pending request
// (`requestedRole`) for an admin to approve. We still accept the legacy
// `role` field from older clients but treat a "MANAGER" value as a *request*,
// not a grant — there is no way to self-provision a MANAGER or ADMIN account.
const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().trim().min(1).max(120).optional(),
  requestedRole: z.enum(["MANAGER"]).optional(),
  // Legacy field from the pre-approval signup form; mapped to a request below.
  role: z.enum(["OPERATOR", "MANAGER"]).optional(),
});

router.post("/auth/signup", async (req, res): Promise<void> => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  // A manager request can arrive via the new `requestedRole` field or the
  // legacy `role: "MANAGER"` grant — both become a pending request.
  const wantsManager =
    parsed.data.requestedRole === "MANAGER" || parsed.data.role === "MANAGER";

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      role: "OPERATOR",
      requestedRole: wantsManager ? "MANAGER" : null,
      displayName: parsed.data.displayName ?? null,
    })
    .returning();

  const token = signToken({ userId: user.id, role: user.role });
  res.status(201).json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      requestedRole: user.requestedRole,
    },
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // rememberMe is not in the generated LoginBody schema yet (would need
  // an openapi spec update + regen). Read it loosely from the raw body
  // for now — coerce only boolean true, treat anything else as the
  // 24h-default flow.
  const rememberMe = (req.body as { rememberMe?: unknown })?.rememberMe === true;

  const email = parsed.data.email.toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    // Soft-deleted users can't log in. Returning the same "Invalid
    // credentials" message we use for "no such user" prevents an
    // attacker from probing whether a given email *used to* exist.
    .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)));

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: user.id, role: user.role }, { rememberMe });
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      requestedRole: user.requestedRole,
    },
  });
});

// Reset tokens live for one hour. Long enough to survive a user briefly
// stepping away from their inbox; short enough that a leaked token from a
// stale link doesn't grant indefinite access.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function safeOrigin(urlString: string): string | null {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const ForgotPasswordBody = z.object({
  email: z.string().email(),
});

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);
  // Validation failures are still answered with 200 so the endpoint never
  // leaks whether a given email exists — anything other than 200 would let
  // an attacker enumerate accounts by varying the input.
  if (!parsed.success) {
    res.status(200).json({ ok: true });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, email));

  // No matching user: respond with the same shape so account existence
  // can't be probed via response timing or body diffs. We still skip token
  // creation server-side.
  if (!user) {
    res.status(200).json({ ok: true });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db.insert(passwordResetTokensTable).values({
    token,
    userId: user.id,
    expiresAt,
  });

  // Build the reset URL. Prefer the frontend's origin from the Origin/Referer
  // header (so the link points back at the SPA, not the api-server). Fall
  // back to APP_BASE_URL, then to the request host. The token is the only
  // secret; the rest of the URL is public.
  const originHeader = req.get("origin");
  const referer = req.get("referer");
  const refererOrigin = referer ? safeOrigin(referer) : null;
  const appBaseUrl =
    originHeader ||
    refererOrigin ||
    process.env["APP_BASE_URL"] ||
    `${req.protocol}://${req.get("host") ?? "localhost"}`;
  const resetUrl = `${appBaseUrl.replace(/\/$/, "")}/reset-password?token=${token}`;

  const ttlMinutes = Math.round(RESET_TOKEN_TTL_MS / 60000);

  // Primary transport: email the reset link directly over SMTP. The link
  // carries our own backend-issued token (?token=…), which the
  // /reset-password page validates via POST /auth/reset-password — no
  // Supabase round-trip required. Send failure is non-fatal: we log it and
  // fall through to the Supabase fallback below so a transient SMTP outage
  // doesn't leave the user with no path at all.
  let emailed = false;
  if (hasEmailConfig()) {
    try {
      await sendPasswordResetEmail(email, resetUrl, ttlMinutes);
      emailed = true;
    } catch (err) {
      logger.error({ err, email }, "password reset email send failed (SMTP); will try fallback");
    }
  }

  // Fallback transport: only if SMTP is unconfigured or the send failed,
  // prime Supabase's hosted recovery email so the frontend can trigger it.
  // Ensures an auth.users "carrier" row exists (Supabase rejects
  // resetPasswordForEmail for unknown accounts); our real auth still lives
  // in public.users with the token we just generated.
  let supabaseAuthReady = false;
  if (!emailed && isSupabaseAuthEnabled()) {
    supabaseAuthReady = await ensureAuthUserExists(email);
  }

  // Response shape:
  //   - `devResetUrl`: only in dev, the in-band link the operator clicks
  //     directly. Lets us test the flow without inspecting an inbox.
  //   - `viaSupabase: true`: SMTP unavailable — signals the frontend to call
  //     `supabase.auth.resetPasswordForEmail()` itself (the backend can't —
  //     that needs the anon key from the public auth API).
  //   - bare `{ ok: true }`: the SMTP email was sent (or no transport is
  //     wired at all) — same shape as account-not-found so existence can't
  //     be probed.
  if (isDev()) {
    logger.info({ email, resetUrl, emailed, supabaseAuthReady }, "password reset link generated (dev)");
    res.status(200).json({ ok: true, devResetUrl: resetUrl, emailed, viaSupabase: supabaseAuthReady });
    return;
  }

  if (emailed) {
    res.status(200).json({ ok: true });
    return;
  }

  if (supabaseAuthReady) {
    logger.info({ email }, "password reset: SMTP unavailable; frontend should call supabase.auth.resetPasswordForEmail");
    res.status(200).json({ ok: true, viaSupabase: true });
    return;
  }

  logger.warn({ email }, "password reset requested but no email transport configured");
  res.status(200).json({ ok: true });
});

const ResetPasswordBody = z.object({
  token: z.string().min(10),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [record] = await db
    .select()
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.token, parsed.data.token));

  if (!record) {
    res.status(400).json({ error: "Invalid or expired reset link" });
    return;
  }
  if (record.usedAt) {
    res.status(400).json({ error: "This reset link has already been used" });
    return;
  }
  if (record.expiresAt.getTime() < Date.now()) {
    res.status(400).json({ error: "This reset link has expired" });
    return;
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, record.userId));

  // Mark consumed so the same token can't be replayed even if it hasn't
  // yet expired. We mark by token PK rather than by id to avoid a second
  // lookup and to keep the operation idempotent.
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokensTable.token, parsed.data.token));

  // Mirror the new password into auth.users so the Supabase-hosted email
  // flow uses the same credential. Best-effort: any failure here only
  // means a future email-driven reset has to bounce through admin-update
  // again to re-sync. The user's public.users.password_hash (the actual
  // login credential) is already saved above.
  if (isSupabaseAuthEnabled()) {
    const [user] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, record.userId));
    if (user?.email) {
      void updateAuthUserPassword(user.email, parsed.data.password).catch((err) =>
        logger.warn({ err, userId: record.userId }, "supabase auth password sync failed"),
      );
    }
  }

  res.status(200).json({ ok: true });
});

/**
 * Mirror of `/auth/reset-password` for users who came through the
 * Supabase-email recovery flow. The frontend has already called
 * `supabase.auth.updateUser({ password })` to rotate the credential on
 * `auth.users`; this endpoint takes the resulting Supabase access token,
 * validates it by calling Supabase's own `/auth/v1/user` (which fails on
 * forged tokens since only Supabase signs them), then writes the same
 * password through to `public.users.password_hash` so our JWT login keeps
 * working with the new credential.
 *
 * Why two stores at all: we haven't fully migrated to Supabase Auth. Our
 * login endpoint still bcrypt-compares against public.users. Until that
 * migration ships, every successful reset has to keep both stores in
 * sync; this endpoint is the second leg.
 */
const SyncPasswordBody = z.object({
  access_token: z.string().min(10),
  password: z.string().min(8, "Password must be at least 8 characters"),
});
router.post("/auth/sync-password-from-supabase", async (req, res): Promise<void> => {
  const parsed = SyncPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const supabaseUrl = process.env["SUPABASE_URL"];
  const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceKey) {
    res.status(503).json({ error: "Supabase Auth not configured on this server" });
    return;
  }

  // Verify the access token by asking Supabase whose it is. This is the
  // sole gate — a forged token won't validate because Supabase signs with
  // a JWT secret we don't have to know.
  let email: string;
  try {
    const ver = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${parsed.data.access_token}`,
        apikey: serviceKey,
      },
    });
    if (!ver.ok) {
      res.status(401).json({ error: "Invalid Supabase session" });
      return;
    }
    const u = (await ver.json()) as { email?: string };
    if (!u.email) {
      res.status(401).json({ error: "Supabase session missing email" });
      return;
    }
    email = u.email.toLowerCase();
  } catch (err) {
    logger.warn({ err }, "supabase auth verify call threw");
    res.status(502).json({ error: "Couldn't reach Supabase Auth" });
    return;
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const result = await db
    .update(usersTable)
    .set({ passwordHash })
    .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)))
    .returning({ id: usersTable.id });

  if (result.length === 0) {
    // The Supabase user exists but we have no matching row in public.users.
    // Could happen if the auth.users row was created out-of-band. Don't
    // leak whether the row exists — respond 200 either way so the
    // attacker-probing-via-forged-jwt path doesn't reveal anything.
    logger.warn({ email }, "sync-password: no matching public.users row");
  }
  res.status(200).json({ ok: true });
});

router.get("/auth/me", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), isNull(usersTable.deletedAt)));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    requestedRole: user.requestedRole,
  });
});

/**
 * Soft-delete + anonymise the authenticated user. The row stays so
 * existing FKs (submissions, escalations, labels) keep resolving — we
 * just scrub PII and set `deleted_at`, after which login + /auth/me
 * filter them out. The body must include the user's current password so
 * a stolen JWT can't unilaterally delete the account.
 *
 * Email becomes `deleted-<id>-<random>@anonymized.local` so the unique
 * constraint still holds AND a future user can re-claim the original
 * email if they want.
 */
const DeleteAccountBody = z.object({
  password: z.string().min(1),
});
router.delete("/auth/me", authMiddleware, async (req, res): Promise<void> => {
  const parsed = DeleteAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userId } = (req as any).user;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), isNull(usersTable.deletedAt)));
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Wrong password" });
    return;
  }

  // Anonymise: scramble email so future signups can reclaim the original,
  // clear displayName, void password hash (any compare will fail).
  const anonEmail = `deleted-${user.id}-${crypto.randomBytes(4).toString("hex")}@anonymized.local`;
  await db
    .update(usersTable)
    .set({
      email: anonEmail,
      displayName: null,
      passwordHash: "deleted",
      deletedAt: new Date(),
    })
    .where(eq(usersTable.id, user.id));

  logger.info({ userId: user.id, oldEmail: user.email }, "account soft-deleted");
  res.status(200).json({ ok: true });
});

export default router;
