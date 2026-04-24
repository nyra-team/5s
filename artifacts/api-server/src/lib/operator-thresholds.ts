/**
 * Server-side source of truth for the operator-facing thresholds. Mirrors the
 * defaults in the web artifact (`artifacts/five-s/src/lib/operator-thresholds.ts`)
 * but layers three additional override mechanisms so plant managers can tune
 * them without a redeploy:
 *
 *   1. Environment variable overrides (highest precedence) — useful for ops
 *      to lock a value down per-deployment, mirroring the existing
 *      `ESCALATION_THRESHOLD_PERCENT` knob.
 *   2. Per-area DB overrides via `area_operator_settings` — let a manager
 *      tighten a single hot area (e.g. a 24/7 bottling line) without
 *      touching the rest of the plant.
 *   3. Global DB overrides via `operator_settings` (managed at runtime by
 *      managers through the admin UI / `PUT /operator-thresholds`).
 *   4. Static defaults (lowest precedence) — must stay in sync with the web
 *      module above. The encouragement chip and the operator-recent route
 *      both ultimately read through `loadEffectiveOperatorThresholds()`.
 *
 * `PRIOR_BEST_WINDOW_MS` is preserved as a default-only constant for
 * existing test fixtures; runtime code paths must use the loader so DB
 * overrides take effect on the next request.
 */
import { eq, inArray } from "drizzle-orm";
import {
  db,
  operatorSettingsTable,
  areaOperatorSettingsTable,
} from "@workspace/db";

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

export type ThresholdSources = {
  encouragementMinPercent: number | null;
  priorBestWindowDays: number | null;
  dueSoonThresholdMinutes: number | null;
};

/** Snapshot of env-var overrides. Captured once at module init since env
 * vars don't change at runtime in this process model. */
export function getEnvOperatorThresholds(): ThresholdSources {
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
 * Read the single-row global DB override. Returns nulls for every field if
 * the row doesn't exist yet (the row is created lazily on the first manager
 * update).
 */
export async function getDbOperatorThresholds(): Promise<
  ThresholdSources & {
    updatedByUserId: number | null;
    updatedAt: Date | null;
  }
> {
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

export type AreaOverrideRow = ThresholdSources & {
  areaId: number;
  updatedByUserId: number | null;
  updatedAt: Date | null;
};

const EMPTY_AREA_OVERRIDE: ThresholdSources & {
  updatedByUserId: number | null;
  updatedAt: Date | null;
} = {
  encouragementMinPercent: null,
  priorBestWindowDays: null,
  dueSoonThresholdMinutes: null,
  updatedByUserId: null,
  updatedAt: null,
};

/**
 * Per-area override for a single area. Returns the empty shape (all nulls)
 * if the area has no override row, so callers can treat "no row" and "row
 * with all nulls" identically.
 */
export async function getDbAreaOperatorThresholds(
  areaId: number,
): Promise<typeof EMPTY_AREA_OVERRIDE> {
  const [row] = await db
    .select()
    .from(areaOperatorSettingsTable)
    .where(eqAreaId(areaId))
    .limit(1);
  if (!row) return { ...EMPTY_AREA_OVERRIDE };
  return {
    encouragementMinPercent: row.encouragementMinPercent,
    priorBestWindowDays: row.priorBestWindowDays,
    dueSoonThresholdMinutes: row.dueSoonThresholdMinutes,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Bulk fetch every per-area override row. Used by the admin UI (one selector,
 * full provenance for every area) and by `/operator/recent` (one round-trip
 * for the whole strip rather than one per row).
 */
export async function getAllAreaOperatorThresholds(): Promise<AreaOverrideRow[]> {
  const rows = await db.select().from(areaOperatorSettingsTable);
  return rows.map((r) => ({
    areaId: r.areaId,
    encouragementMinPercent: r.encouragementMinPercent,
    priorBestWindowDays: r.priorBestWindowDays,
    dueSoonThresholdMinutes: r.dueSoonThresholdMinutes,
    updatedByUserId: r.updatedByUserId,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Bulk fetch the per-area overrides for a specific set of area ids. Returns
 * a map keyed by areaId so the caller can do O(1) lookups while iterating
 * other rows. Areas without an override row are simply absent from the map.
 */
export async function getDbAreaOperatorThresholdsByIds(
  areaIds: number[],
): Promise<Map<number, ThresholdSources>> {
  const map = new Map<number, ThresholdSources>();
  if (areaIds.length === 0) return map;
  const rows = await db
    .select()
    .from(areaOperatorSettingsTable)
    .where(inArray(areaOperatorSettingsTable.areaId, areaIds));
  for (const r of rows) {
    map.set(r.areaId, {
      encouragementMinPercent: r.encouragementMinPercent,
      priorBestWindowDays: r.priorBestWindowDays,
      dueSoonThresholdMinutes: r.dueSoonThresholdMinutes,
    });
  }
  return map;
}

/**
 * Resolve effective values from the layered sources. Pure function so
 * callers that already have the per-layer rows in hand (e.g. /operator/recent
 * with its bulk-fetched area override map) can resolve without an extra
 * round-trip per row.
 *
 * Precedence: env > area-DB > global-DB > default.
 */
export function resolveOperatorThresholds(args: {
  env: ThresholdSources;
  areaOverride?: ThresholdSources | null;
  globalOverride: ThresholdSources;
}): EffectiveOperatorThresholds {
  const { env, areaOverride, globalOverride } = args;
  const a = areaOverride ?? null;
  return {
    encouragementMinPercent:
      env.encouragementMinPercent ??
      a?.encouragementMinPercent ??
      globalOverride.encouragementMinPercent ??
      DEFAULT_OPERATOR_THRESHOLDS.encouragementMinPercent,
    priorBestWindowDays:
      env.priorBestWindowDays ??
      a?.priorBestWindowDays ??
      globalOverride.priorBestWindowDays ??
      DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays,
    dueSoonThresholdMinutes:
      env.dueSoonThresholdMinutes ??
      a?.dueSoonThresholdMinutes ??
      globalOverride.dueSoonThresholdMinutes ??
      DEFAULT_OPERATOR_THRESHOLDS.dueSoonThresholdMinutes,
  };
}

/**
 * Resolve the effective values for a request. Precedence: env > area-DB >
 * global-DB > default. Pass `areaId` to layer in a per-area override (used
 * by per-area request paths such as the operator-recent strip's per-row
 * resolution); omit it for global resolution (admin UI default, capture
 * sheet fallback while a specific area context is unknown).
 *
 * No in-process cache: each layer is a single small select on a tiny table
 * and the task spec calls for overrides to take effect on the *next*
 * request.
 */
export async function loadEffectiveOperatorThresholds(
  areaId?: number,
): Promise<EffectiveOperatorThresholds> {
  const env = getEnvOperatorThresholds();
  const [globalRow, areaRow] = await Promise.all([
    getDbOperatorThresholds(),
    areaId == null ? Promise.resolve(null) : getDbAreaOperatorThresholds(areaId),
  ]);
  return resolveOperatorThresholds({
    env,
    areaOverride: areaRow,
    globalOverride: globalRow,
  });
}

/** Convenience: prior-best window expressed in milliseconds. */
export function priorBestWindowMs(t: EffectiveOperatorThresholds): number {
  return t.priorBestWindowDays * 24 * 60 * 60 * 1000;
}

function eqAreaId(areaId: number) {
  return eq(areaOperatorSettingsTable.areaId, areaId);
}
