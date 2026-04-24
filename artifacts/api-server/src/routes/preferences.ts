import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { notificationProviderStatus, quietHoursStatus } from "../lib/notifications.js";
import {
  diffFields,
  loadLastSettingsChange,
  loadSettingsAuditHistory,
  recordSettingsChanges,
  type AuditValue,
  type SettingsAuditEntry,
} from "../lib/settings-audit.js";

const router: IRouter = Router();

/**
 * Audit scope for this settings page. Stable string — used as the
 * `scope` column in `settings_audit`. Don't rename without a migration.
 */
const AUDIT_SCOPE = "notification_preferences";

/**
 * Fields we audit. Keep in sync with the patch shape below; anything not
 * listed here will save without leaving an audit trail. The order is also
 * the order the diff helper iterates, but rendering order is up to the UI.
 */
const AUDITED_FIELDS = [
  "notifyEmailEnabled",
  "notifySlackEnabled",
  "quietHoursEnabled",
  "quietHoursStart",
  "quietHoursEnd",
  "quietHoursWeekdayMask",
] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

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
  quietHoursActive: boolean;
  quietHoursActiveUntil: string | null;
  quietHoursNextStart: string | null;
  /**
   * Resolved attribution for the most recent change to this user's
   * preferences. All three are null when the user has never changed
   * their preferences (i.e. they're still on the schema defaults).
   */
  lastChangedAt: string | null;
  lastChangedByUserId: number | null;
  lastChangedByUserEmail: string | null;
  /**
   * Recent per-field changes (newest first), capped server-side.
   * Mirrors the shape used by the operator-thresholds endpoint so the
   * UI can render both pages from a shared component.
   */
  auditHistory: SettingsAuditEntry[];
}

// Canonical wire/storage shape is 24h "HH:MM" — the column is `text`
// and the form's <input type="time"> only ever submits HH:MM, so the
// schema and DB are aligned today and round-trip cleanly without any
// seconds suffix. The optional `:SS` group below is tolerated on both
// the read and write boundary purely as defense-in-depth: if a legacy
// row, an out-of-band SQL update, or a future schema drift back to
// `time without time zone` produces an "HH:MM:SS" value, this folds
// it back to canonical HH:MM in the same step instead of dropping
// the value to the default and losing the user's preference. This
// fallback is no longer load-bearing for normal operation.
function normalizeTimeOfDay(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/**
 * Pull just the audited fields off the row in the same order the helper
 * expects. Centralizing it avoids accidentally diffing different shapes
 * before vs after a write.
 */
function snapshot(row: {
  notifyEmailEnabled: boolean;
  notifySlackEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursWeekdayMask: number;
}): Record<AuditedField, AuditValue> {
  return {
    notifyEmailEnabled: row.notifyEmailEnabled,
    notifySlackEnabled: row.notifySlackEnabled,
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    quietHoursWeekdayMask: row.quietHoursWeekdayMask,
  };
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
  const live = quietHoursStatus(user);
  // Audit attribution + history are scoped to THIS user (subjectId = userId).
  // They're cheap parallel reads against an indexed lookup — see the index
  // on (scope, subject_id, changed_at, id) in `settings_audit`.
  const [lastChange, auditHistory] = await Promise.all([
    loadLastSettingsChange({ scope: AUDIT_SCOPE, subjectId: userId }),
    loadSettingsAuditHistory({ scope: AUDIT_SCOPE, subjectId: userId }),
  ]);
  return {
    email: user.email,
    notifyEmailEnabled: user.notifyEmailEnabled,
    notifySlackEnabled: user.notifySlackEnabled,
    quietHoursEnabled: user.quietHoursEnabled,
    quietHoursStart: normalizeTimeOfDay(user.quietHoursStart) ?? "22:00",
    quietHoursEnd: normalizeTimeOfDay(user.quietHoursEnd) ?? "07:00",
    quietHoursWeekdayMask: user.quietHoursWeekdayMask,
    quietHoursActive: live.active,
    quietHoursActiveUntil: live.activeUntil,
    quietHoursNextStart: live.nextStart,
    emailConfigured: status.emailConfigured,
    slackConfigured: status.slackConfigured,
    lastChangedAt: lastChange?.changedAt ?? null,
    lastChangedByUserId: lastChange?.changedByUserId ?? null,
    lastChangedByUserEmail: lastChange?.changedByUserEmail ?? null,
    auditHistory,
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
    // Wrap read-snapshot + update + audit insert in a single transaction so
    // an audit failure rolls the settings write back too. Without this we
    // could leave an unattributed change in the wild if the audit insert
    // throws after the user row has already been mutated.
    await db.transaction(async (tx) => {
      // Snapshot the audited fields BEFORE the write so the diff describes
      // what actually moved (a no-op set of the same value won't pollute
      // the history). One round-trip; cheap.
      const [previous] = await tx
        .select({
          notifyEmailEnabled: usersTable.notifyEmailEnabled,
          notifySlackEnabled: usersTable.notifySlackEnabled,
          quietHoursEnabled: usersTable.quietHoursEnabled,
          quietHoursStart: usersTable.quietHoursStart,
          quietHoursEnd: usersTable.quietHoursEnd,
          quietHoursWeekdayMask: usersTable.quietHoursWeekdayMask,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      await tx.update(usersTable).set(patch).where(eq(usersTable.id, userId));

      if (previous) {
        // Build a "before/after" snapshot using normalized HH:MM values so a
        // legacy DB value with seconds doesn't show up as a phantom change
        // (loadPreferences normalizes on read, so an unchanged DB write would
        // otherwise look like "22:00:00 → 22:00").
        const before = snapshot({
          ...previous,
          quietHoursStart: normalizeTimeOfDay(previous.quietHoursStart) ?? previous.quietHoursStart,
          quietHoursEnd: normalizeTimeOfDay(previous.quietHoursEnd) ?? previous.quietHoursEnd,
        });
        const after: Record<AuditedField, AuditValue> = { ...before };
        for (const f of AUDITED_FIELDS) {
          if (f in patch) {
            const v = (patch as Record<string, AuditValue>)[f];
            if (v !== undefined) after[f] = v;
          }
        }
        const changes = diffFields(before, after, AUDITED_FIELDS);
        await recordSettingsChanges({
          scope: AUDIT_SCOPE,
          subjectId: userId,
          changedByUserId: userId,
          changes,
          executor: tx,
        });
      }
    });
  }

  const prefs = await loadPreferences(userId);
  if (!prefs) { res.status(404).json({ error: "User not found" }); return; }
  res.json(prefs);
});

export default router;
