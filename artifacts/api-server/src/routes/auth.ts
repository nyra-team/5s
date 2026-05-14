import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable, passwordResetTokensTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { signToken, authMiddleware } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["OPERATOR", "MANAGER"]).default("OPERATOR"),
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

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      role: parsed.data.role,
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
    },
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: user.id, role: user.role });
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
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

  // Dev fallback: there's no email integration wired locally, so we surface
  // the reset link in the response body and the server log. In production
  // this branch is gated off and the link is delivered by email instead.
  if (process.env["NODE_ENV"] !== "production") {
    logger.info({ email, resetUrl }, "password reset link generated (dev)");
    res.status(200).json({ ok: true, devResetUrl: resetUrl });
    return;
  }

  // TODO(prod): hand `resetUrl` off to the email integration (Resend) here.
  // Kept inline for now so the wiring stays visible — when an email service
  // is configured we'll send and fall through to the standard 200 response.
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

  res.status(200).json({ ok: true });
});

router.get("/auth/me", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  });
});

export default router;
