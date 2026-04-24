import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, operatorSettingsTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  DEFAULT_OPERATOR_THRESHOLDS,
  THRESHOLD_VALIDATORS,
  getDbOperatorThresholds,
  getEnvOperatorThresholds,
  loadEffectiveOperatorThresholds,
} from "../lib/operator-thresholds.js";

const router: IRouter = Router();

type ThresholdSources = {
  encouragementMinPercent: number | null;
  priorBestWindowDays: number | null;
  dueSoonThresholdMinutes: number | null;
};

interface ThresholdsPayload {
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  dueSoonThresholdMinutes: number;
  defaults: typeof DEFAULT_OPERATOR_THRESHOLDS;
  envOverrides: ThresholdSources;
  dbOverrides: ThresholdSources;
  updatedAt: string | null;
  updatedByUserId: number | null;
}

async function buildPayload(): Promise<ThresholdsPayload> {
  const [effective, env, dbRow] = await Promise.all([
    loadEffectiveOperatorThresholds(),
    Promise.resolve(getEnvOperatorThresholds()),
    getDbOperatorThresholds(),
  ]);
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
  };
}

// Authenticated read — operators need the effective values to render the
// encouragement chip and "due soon" badge. Diagnostic fields (envOverrides,
// dbOverrides, updatedAt) are returned unconditionally; they're not
// sensitive and the manager UI relies on them to show provenance.
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

    const patch: Record<string, number | null> = {};

    for (const field of [
      "encouragementMinPercent",
      "priorBestWindowDays",
      "dueSoonThresholdMinutes",
    ] as const) {
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
      // Upsert the singleton row at id=1. We always touch updatedAt /
      // updatedByUserId so the admin UI can show "last changed by".
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
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: operatorSettingsTable.id,
          set: {
            ...patch,
            updatedByUserId: userId,
            updatedAt: new Date(),
          },
        });

      // Keep the singleton sequence in step with the inserted id so future
      // serial allocations don't collide with our explicit id=1 write.
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('operator_settings', 'id'), GREATEST((SELECT MAX(id) FROM operator_settings), 1))`,
      );
    }

    res.json(await buildPayload());
  },
);

export default router;
