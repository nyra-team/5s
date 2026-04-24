import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { notificationProviderStatus } from "../lib/notifications.js";

const router: IRouter = Router();

interface PreferencesShape {
  notifyEmailEnabled: boolean;
  notifySlackEnabled: boolean;
  emailConfigured: boolean;
  slackConfigured: boolean;
  email: string;
}

async function loadPreferences(userId: number): Promise<PreferencesShape | null> {
  const [user] = await db
    .select({
      email: usersTable.email,
      notifyEmailEnabled: usersTable.notifyEmailEnabled,
      notifySlackEnabled: usersTable.notifySlackEnabled,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) return null;
  const status = notificationProviderStatus();
  return {
    email: user.email,
    notifyEmailEnabled: user.notifyEmailEnabled,
    notifySlackEnabled: user.notifySlackEnabled,
    emailConfigured: status.emailConfigured,
    slackConfigured: status.slackConfigured,
  };
}

router.get("/me/notification-preferences", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const { userId } = (req as any).user as { userId: number };
  const prefs = await loadPreferences(userId);
  if (!prefs) { res.status(404).json({ error: "User not found" }); return; }
  res.json(prefs);
});

router.put("/me/notification-preferences", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const { userId } = (req as any).user as { userId: number };
  const body = req.body ?? {};

  // Permissive: only the boolean fields the schema accepts are persisted.
  // Anything else is silently ignored so older clients keep working.
  const patch: { notifyEmailEnabled?: boolean; notifySlackEnabled?: boolean } = {};
  if (typeof body.notifyEmailEnabled === "boolean") patch.notifyEmailEnabled = body.notifyEmailEnabled;
  if (typeof body.notifySlackEnabled === "boolean") patch.notifySlackEnabled = body.notifySlackEnabled;

  if (Object.keys(patch).length > 0) {
    await db.update(usersTable).set(patch).where(eq(usersTable.id, userId));
  }

  const prefs = await loadPreferences(userId);
  if (!prefs) { res.status(404).json({ error: "User not found" }); return; }
  res.json(prefs);
});

export default router;
