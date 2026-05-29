import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import { authMiddleware, requireAdmin } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Roles an admin may assign. ADMIN is grantable only by another admin. */
const ASSIGNABLE_ROLES = ["OPERATOR", "MANAGER", "ADMIN"] as const;

/** Shape returned to the user-management screen. No password material. */
const userColumns = {
  id: usersTable.id,
  email: usersTable.email,
  displayName: usersTable.displayName,
  role: usersTable.role,
  requestedRole: usersTable.requestedRole,
};

function parseUserId(raw: unknown): number | null {
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Count of live (non-deleted) admins — used to refuse demoting the last one. */
async function liveAdminCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(and(eq(usersTable.role, "ADMIN"), isNull(usersTable.deletedAt)));
  return row?.n ?? 0;
}

/**
 * GET /api/admin/users
 * Full roster (excluding soft-deleted accounts), ordered by id so the list
 * reads in signup order. Admin-only.
 */
router.get("/admin/users", authMiddleware, requireAdmin, async (_req, res): Promise<void> => {
  const users = await db
    .select(userColumns)
    .from(usersTable)
    .where(isNull(usersTable.deletedAt))
    .orderBy(usersTable.id);
  res.json({ users });
});

/**
 * GET /api/admin/users/pending
 * Just the accounts with an outstanding elevation request — the approval
 * queue the admin acts on. Admin-only.
 */
router.get(
  "/admin/users/pending",
  authMiddleware,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const users = await db
      .select(userColumns)
      .from(usersTable)
      .where(and(isNull(usersTable.deletedAt), sql`${usersTable.requestedRole} is not null`))
      .orderBy(usersTable.id);
    res.json({ users });
  },
);

/**
 * POST /api/admin/users/:id/approve
 * Grant the role the operator asked for: role := requested_role, then clear
 * the request. No-op-safe: 409 if there's nothing pending. Admin-only.
 */
router.post(
  "/admin/users/:id/approve",
  authMiddleware,
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = parseUserId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const [user] = await db
      .select(userColumns)
      .from(usersTable)
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!user.requestedRole) {
      res.status(409).json({ error: "This user has no pending access request" });
      return;
    }
    const [updated] = await db
      .update(usersTable)
      .set({ role: user.requestedRole, requestedRole: null })
      .where(eq(usersTable.id, id))
      .returning(userColumns);
    logger.info(
      { actorId: (req as any).user?.userId, targetId: id, grantedRole: user.requestedRole },
      "admin approved role request",
    );
    res.json({ user: updated });
  },
);

/**
 * POST /api/admin/users/:id/deny
 * Reject the elevation request — the account stays OPERATOR; we just clear
 * the pending flag. Admin-only.
 */
router.post(
  "/admin/users/:id/deny",
  authMiddleware,
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = parseUserId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const [updated] = await db
      .update(usersTable)
      .set({ requestedRole: null })
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)))
      .returning(userColumns);
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    logger.info(
      { actorId: (req as any).user?.userId, targetId: id },
      "admin denied role request",
    );
    res.json({ user: updated });
  },
);

const SetRoleBody = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

/**
 * PATCH /api/admin/users/:id/role
 * Directly set a user's role (promote / demote / grant admin). Clears any
 * pending request as a side effect since the role is now decided. Refuses to
 * demote the last remaining admin so the system can't lock itself out.
 * Admin-only.
 */
router.patch(
  "/admin/users/:id/role",
  authMiddleware,
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = parseUserId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const parsed = SetRoleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const nextRole = parsed.data.role;

    const [user] = await db
      .select(userColumns)
      .from(usersTable)
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Guard against demoting the last admin — including an admin demoting
    // themselves — which would leave nobody able to manage users.
    if (user.role === "ADMIN" && nextRole !== "ADMIN") {
      const admins = await liveAdminCount();
      if (admins <= 1) {
        res
          .status(409)
          .json({ error: "Cannot demote the last remaining admin. Promote another admin first." });
        return;
      }
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role: nextRole, requestedRole: null })
      .where(eq(usersTable.id, id))
      .returning(userColumns);
    logger.info(
      { actorId: (req as any).user?.userId, targetId: id, from: user.role, to: nextRole },
      "admin changed user role",
    );
    res.json({ user: updated });
  },
);

/**
 * DELETE /api/admin/users/:id
 * Soft-delete + anonymise an account (mirrors the self-service DELETE
 * /auth/me): the row stays so historical FKs (submissions, labels,
 * escalations) keep resolving, but PII is scrubbed, the password hash is
 * voided, and `deleted_at` is set — after which login and every roster query
 * filter the user out. Email is scrambled to a unique placeholder so the
 * original can be re-claimed by a future signup.
 *
 * Guard rails: an admin can't delete themselves through this route (use
 * account settings, which requires the password) and can't delete the last
 * remaining admin — either would risk locking the system out. Admin-only.
 */
router.delete(
  "/admin/users/:id",
  authMiddleware,
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = parseUserId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const actorId = (req as any).user?.userId as number | undefined;
    if (actorId === id) {
      res.status(409).json({
        error: "You can't delete your own account here. Use account settings instead.",
      });
      return;
    }

    const [user] = await db
      .select(userColumns)
      .from(usersTable)
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.role === "ADMIN") {
      const admins = await liveAdminCount();
      if (admins <= 1) {
        res
          .status(409)
          .json({ error: "Cannot delete the last remaining admin. Promote another admin first." });
        return;
      }
    }

    const anonEmail = `deleted-${user.id}-${crypto.randomBytes(4).toString("hex")}@anonymized.local`;
    await db
      .update(usersTable)
      .set({
        email: anonEmail,
        displayName: null,
        passwordHash: "deleted",
        requestedRole: null,
        deletedAt: new Date(),
      })
      .where(eq(usersTable.id, id));

    logger.info(
      { actorId, targetId: id, oldEmail: user.email, oldRole: user.role },
      "admin deleted user",
    );
    res.json({ ok: true });
  },
);

export default router;
