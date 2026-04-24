import { Router, type IRouter } from "express";
import { sql, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  operatorSettingsTable,
  operatorSettingsAuditTable,
  usersTable,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  DEFAULT_OPERATOR_THRESHOLDS,
  THRESHOLD_VALIDATORS,
  getDbOperatorThresholds,
  getEnvOperatorThresholds,
  loadEffectiveOperatorThresholds,
} from "../lib/operator-thresholds.js";

const router: IRouter = Router();

const THRESHOLD_FIELDS = [
  "encouragementMinPercent",
  "priorBestWindowDays",
  "dueSoonThresholdMinutes",
] as const;
type ThresholdField = (typeof THRESHOLD_FIELDS)[number];

/** How many rows to surface on the admin page. */
const AUDIT_HISTORY_LIMIT = 5;

type ThresholdSources = {
  encouragementMinPercent: number | null;
  priorBestWindowDays: number | null;
  dueSoonThresholdMinutes: number | null;
};

interface AuditEntry {
  id: number;
  changedAt: string;
  changedByUserId: number;
  changedByUserEmail: string | null;
  field: string;
  oldValue: number | null;
  newValue: number | null;
}

interface ThresholdsPayload {
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  dueSoonThresholdMinutes: number;
  defaults: typeof DEFAULT_OPERATOR_THRESHOLDS;
  envOverrides: ThresholdSources;
  dbOverrides: ThresholdSources;
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUserEmail: string | null;
  auditHistory: AuditEntry[];
}

async function loadAuditHistory(): Promise<AuditEntry[]> {
  // Pull the most recent N rows, then resolve user emails in a single
  // follow-up query keyed by the distinct ids we actually need. We don't
  // join in SQL because the audit row is intentionally append-only and
  // we want the email lookup tolerant of deleted users.
  const rows = await db
    .select()
    .from(operatorSettingsAuditTable)
    .orderBy(
      desc(operatorSettingsAuditTable.changedAt),
      desc(operatorSettingsAuditTable.id),
    )
    .limit(AUDIT_HISTORY_LIMIT);
  if (rows.length === 0) return [];

  const userIds = Array.from(new Set(rows.map((r) => r.changedByUserId)));
  const users = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  return rows.map((r) => ({
    id: r.id,
    changedAt: r.changedAt.toISOString(),
    changedByUserId: r.changedByUserId,
    changedByUserEmail: emailById.get(r.changedByUserId) ?? null,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
  }));
}

async function resolveEmail(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const [row] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.email ?? null;
}

async function buildPayload(): Promise<ThresholdsPayload> {
  const [effective, env, dbRow, auditHistory] = await Promise.all([
    loadEffectiveOperatorThresholds(),
    Promise.resolve(getEnvOperatorThresholds()),
    getDbOperatorThresholds(),
    loadAuditHistory(),
  ]);
  const updatedByUserEmail = await resolveEmail(dbRow.updatedByUserId);
  return {
    ...effective,
    defaults: DEFAULT_OPERATOR_THRESHOLDS,
    envOverrides: env,
    dbOverrides: {
      encouragementMinPercent: dbRow.encouragementMinPercent,
      priorBestWindowDays: dbRow.priorBestWindowDays,
      dueSoonThresholdMinutes: dbRow.dueSoonThresholdMinutes,
    },
    updatedAt: dbRow.updatedAt ? dbRow.updatedAt.toISOString() : null,
    updatedByUserId: dbRow.updatedByUserId,
    updatedByUserEmail,
    auditHistory,
  };
}

// Authenticated read — operators need the effective values to render the
// encouragement chip and "due soon" badge. Diagnostic fields (envOverrides,
// dbOverrides, updatedAt, auditHistory) are returned unconditionally; they're
// not sensitive and the manager UI relies on them to show provenance.
router.get(
  "/operator-thresholds",
  authMiddleware,
  async (_req, res): Promise<void> => {
    res.json(await buildPayload());
  },
);

// Manager-only write. Per-field semantics:
//   * Field omitted → leave the existing DB override untouched.
//   * Field set to `null` → clear the DB override (fall back to env/default).
//   * Field set to a valid integer → store as the new DB override.
// Anything else (NaN, out-of-range, wrong type) is silently ignored, matching
// the permissive style used by the notification preferences endpoint so a
// stray bad field can't reject the whole payload. The full effective state
// is returned so the UI can confirm what actually landed.
router.put(
  "/operator-thresholds",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: Partial<Record<ThresholdField, number | null>> = {};

    for (const field of THRESHOLD_FIELDS) {
      if (!(field in body)) continue;
      const v = body[field];
      if (v === null) {
        patch[field] = null;
        continue;
      }
      if (typeof v === "number" && THRESHOLD_VALIDATORS[field](v)) {
        patch[field] = v;
      }
      // Anything else for this field is ignored (permissive).
    }

    if (Object.keys(patch).length > 0) {
      // Capture pre-write values so we can emit accurate audit rows that
      // describe each individual field that actually moved. We snapshot
      // *before* the upsert so a no-op set (e.g. saving the same number
      // back) doesn't pollute the history.
      const previous = await getDbOperatorThresholds();

      // Upsert the singleton row at id=1. We always touch updatedAt /
      // updatedByUserId so the admin UI can show "last changed by".
      const changedAt = new Date();
      await db
        .insert(operatorSettingsTable)
        .values({
          id: 1,
          encouragementMinPercent:
            patch.encouragementMinPercent ?? null,
          priorBestWindowDays: patch.priorBestWindowDays ?? null,
          dueSoonThresholdMinutes:
            patch.dueSoonThresholdMinutes ?? null,
          updatedByUserId: userId,
          updatedAt: changedAt,
        })
        .onConflictDoUpdate({
          target: operatorSettingsTable.id,
          set: {
            ...patch,
            updatedByUserId: userId,
            updatedAt: changedAt,
          },
        });

      // Keep the singleton sequence in step with the inserted id so future
      // serial allocations don't collide with our explicit id=1 write.
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('operator_settings', 'id'), GREATEST((SELECT MAX(id) FROM operator_settings), 1))`,
      );

      // One audit row per field that actually moved. Reuses the same
      // changedAt as the settings write so a UI can group simultaneous
      // tweaks together.
      const auditValues: Array<{
        changedByUserId: number;
        changedAt: Date;
        field: string;
        oldValue: number | null;
        newValue: number | null;
      }> = [];
      for (const field of THRESHOLD_FIELDS) {
        if (!(field in patch)) continue;
        const oldValue = previous[field];
        const newValue = patch[field] ?? null;
        if (oldValue === newValue) continue;
        auditValues.push({
          changedByUserId: userId,
          changedAt,
          field,
          oldValue,
          newValue,
        });
      }
      if (auditValues.length > 0) {
        await db.insert(operatorSettingsAuditTable).values(auditValues);
      }
    }

    res.json(await buildPayload());
  },
);

export default router;
