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
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursWeekdayMask: number;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Postgres `time` columns (and some legacy data) serialise as "HH:MM:SS".
// The UI form picker only round-trips "HH:MM", so any drift breaks the
// edit flow. Normalise both on read (so the client always gets HH:MM) and
// on write (so HH:MM:SS submissions don't get silently dropped by the
// strict regex above).
function normalizeTimeOfDay(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

async function loadPreferences(userId: number): Promise<PreferencesShape | null> {
  const [user] = await db
    .select({
      email: usersTable.email,
      notifyEmailEnabled: usersTable.notifyEmailEnabled,
      notifySlackEnabled: usersTable.notifySlackEnabled,
      quietHoursEnabled: usersTable.quietHoursEnabled,
      quietHoursStart: usersTable.quietHoursStart,
      quietHoursEnd: usersTable.quietHoursEnd,
      quietHoursWeekdayMask: usersTable.quietHoursWeekdayMask,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) return null;
  const status = notificationProviderStatus();
  return {
    email: user.email,
    notifyEmailEnabled: user.notifyEmailEnabled,
    notifySlackEnabled: user.notifySlackEnabled,
    quietHoursEnabled: user.quietHoursEnabled,
    quietHoursStart: normalizeTimeOfDay(user.quietHoursStart) ?? "22:00",
    quietHoursEnd: normalizeTimeOfDay(user.quietHoursEnd) ?? "07:00",
    quietHoursWeekdayMask: user.quietHoursWeekdayMask,
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

  // Permissive: only known fields with valid shape are persisted. Anything
  // else (or anything malformed) is silently ignored so older clients keep
  // working and a stray bad field can't reject the whole payload.
  const patch: {
    notifyEmailEnabled?: boolean;
    notifySlackEnabled?: boolean;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    quietHoursWeekdayMask?: number;
  } = {};

  if (typeof body.notifyEmailEnabled === "boolean") patch.notifyEmailEnabled = body.notifyEmailEnabled;
  if (typeof body.notifySlackEnabled === "boolean") patch.notifySlackEnabled = body.notifySlackEnabled;
  if (typeof body.quietHoursEnabled === "boolean") patch.quietHoursEnabled = body.quietHoursEnabled;
  if (typeof body.quietHoursStart === "string") {
    const start = normalizeTimeOfDay(body.quietHoursStart);
    if (start) patch.quietHoursStart = start;
  }
  if (typeof body.quietHoursEnd === "string") {
    const end = normalizeTimeOfDay(body.quietHoursEnd);
    if (end) patch.quietHoursEnd = end;
  }
  if (
    typeof body.quietHoursWeekdayMask === "number" &&
    Number.isInteger(body.quietHoursWeekdayMask) &&
    body.quietHoursWeekdayMask >= 0 &&
    body.quietHoursWeekdayMask <= 127
  ) {
    patch.quietHoursWeekdayMask = body.quietHoursWeekdayMask;
  }

  if (Object.keys(patch).length > 0) {
    await db.update(usersTable).set(patch).where(eq(usersTable.id, userId));
  }

  const prefs = await loadPreferences(userId);
  if (!prefs) { res.status(404).json({ error: "User not found" }); return; }
  res.json(prefs);
});

export default router;
