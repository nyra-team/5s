/**
 * Server-side source of truth for the operator-facing thresholds. Mirrors the
 * defaults in the web artifact (`artifacts/five-s/src/lib/operator-thresholds.ts`)
 * but layers two additional override mechanisms so plant managers can tune
 * them without a redeploy:
 *
 *   1. Environment variable overrides (highest precedence) — useful for ops
 *      to lock a value down per-deployment, mirroring the existing
 *      `ESCALATION_THRESHOLD_PERCENT` knob.
 *   2. Database overrides via `operator_settings` (managed at runtime by
 *      managers through the admin UI / `PUT /operator-thresholds`).
 *   3. Static defaults (lowest precedence) — must stay in sync with the web
 *      module above. The encouragement chip and the operator-recent route
 *      both ultimately read through `loadEffectiveOperatorThresholds()`.
 *
 * `PRIOR_BEST_WINDOW_MS` is preserved as a default-only constant for
 * existing test fixtures; runtime code paths must use the loader so DB
 * overrides take effect on the next request.
 */
import { db, operatorSettingsTable } from "@workspace/db";

export interface EffectiveOperatorThresholds {
  /** Display percent (0..100) at which a submission is considered "good". */
  encouragementMinPercent: number;
  /** Lookback window (in days) for prior-best per area. */
  priorBestWindowDays: number;
  /** Time-to-due (in minutes) at which an area check is "due soon". */
  dueSoonThresholdMinutes: number;
}

export const DEFAULT_OPERATOR_THRESHOLDS: EffectiveOperatorThresholds = {
  encouragementMinPercent: 80,
  priorBestWindowDays: 7,
  dueSoonThresholdMinutes: 60,
};

/** Backwards-compat: existing tests import this directly. */
export const OPERATOR_THRESHOLDS = {
  PRIOR_BEST_WINDOW_DAYS: DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays,
} as const;

/** Default lookback expressed in milliseconds. Tests still import this. */
export const PRIOR_BEST_WINDOW_MS =
  DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays * 24 * 60 * 60 * 1000;

function readIntEnv(
  name: string,
  validate: (n: number) => boolean,
): number | null {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || !validate(n)) return null;
  return n;
}

/** Per-field validators reused by env reads and the PUT route. */
export const THRESHOLD_VALIDATORS = {
  encouragementMinPercent: (n: number) =>
    Number.isInteger(n) && n >= 0 && n <= 100,
  priorBestWindowDays: (n: number) =>
    Number.isInteger(n) && n >= 1 && n <= 365,
  dueSoonThresholdMinutes: (n: number) =>
    Number.isInteger(n) && n >= 0 && n <= 1440,
} as const;

/** Snapshot of env-var overrides. Captured once at module init since env
 * vars don't change at runtime in this process model. */
export function getEnvOperatorThresholds(): {
  encouragementMinPercent: number | null;
  priorBestWindowDays: number | null;
  dueSoonThresholdMinutes: number | null;
} {
  return {
    encouragementMinPercent: readIntEnv(
      "ENCOURAGEMENT_MIN_PERCENT",
      THRESHOLD_VALIDATORS.encouragementMinPercent,
    ),
    priorBestWindowDays: readIntEnv(
      "PRIOR_BEST_WINDOW_DAYS",
      THRESHOLD_VALIDATORS.priorBestWindowDays,
    ),
    dueSoonThresholdMinutes: readIntEnv(
      "DUE_SOON_THRESHOLD_MINUTES",
      THRESHOLD_VALIDATORS.dueSoonThresholdMinutes,
    ),
  };
}

/**
 * Read the single-row DB override. Returns nulls for every field if the row
 * doesn't exist yet (the row is created lazily on the first manager update).
 */
export async function getDbOperatorThresholds(): Promise<{
  encouragementMinPercent: number | null;
  priorBestWindowDays: number | null;
  dueSoonThresholdMinutes: number | null;
  updatedByUserId: number | null;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(operatorSettingsTable)
    .orderBy(operatorSettingsTable.id)
    .limit(1);
  if (!row) {
    return {
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
      updatedByUserId: null,
      updatedAt: null,
    };
  }
  return {
    encouragementMinPercent: row.encouragementMinPercent,
    priorBestWindowDays: row.priorBestWindowDays,
    dueSoonThresholdMinutes: row.dueSoonThresholdMinutes,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve the effective values for a request. Precedence: env > DB > default.
 * No in-process cache: this is a single-row select on a tiny table and the
 * task spec calls for overrides to take effect on the *next* request.
 */
export async function loadEffectiveOperatorThresholds(): Promise<EffectiveOperatorThresholds> {
  const env = getEnvOperatorThresholds();
  const dbRow = await getDbOperatorThresholds();
  return {
    encouragementMinPercent:
      env.encouragementMinPercent ??
      dbRow.encouragementMinPercent ??
      DEFAULT_OPERATOR_THRESHOLDS.encouragementMinPercent,
    priorBestWindowDays:
      env.priorBestWindowDays ??
      dbRow.priorBestWindowDays ??
      DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays,
    dueSoonThresholdMinutes:
      env.dueSoonThresholdMinutes ??
      dbRow.dueSoonThresholdMinutes ??
      DEFAULT_OPERATOR_THRESHOLDS.dueSoonThresholdMinutes,
  };
}

/** Convenience: prior-best window expressed in milliseconds. */
export function priorBestWindowMs(t: EffectiveOperatorThresholds): number {
  return t.priorBestWindowDays * 24 * 60 * 60 * 1000;
}
