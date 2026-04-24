/**
 * Default values for the operator-facing thresholds. These are the static
 * fallbacks shipped with the build and used for the very first render
 * (before the API's effective values land) and for tests.
 *
 * At runtime the operator UI calls `useEffectiveOperatorThresholds()` to get
 * the resolved values, which can be tuned per-deployment without a code
 * change via either an env-var override on the API or a manager edit on the
 * /operator-thresholds admin screen. Server-side mirror (with the same
 * defaults) lives at `artifacts/api-server/src/lib/operator-thresholds.ts`.
 *
 * Score domain reminder: a submission's `scoreTotal` ranges 0..25 (five 5S
 * pillars × 5 points). Display percent is `scoreTotal * 4`.
 */
import {
  useGetOperatorThresholds,
  getGetOperatorThresholdsQueryKey,
} from "@workspace/api-client-react";

export const OPERATOR_THRESHOLDS = {
  /**
   * Minimum display percent (0–100) at which a submission is considered
   * "good" by the operator UI. Drives the encouragement chip and the
   * "Last good" hint surfaced in the capture sheet.
   */
  ENCOURAGEMENT_MIN_PERCENT: 80,
  /**
   * Lookback window (in days) used to compute the operator's prior best
   * per area for the encouragement chip. Must stay in sync with the
   * matching window applied server-side in `/operator/recent`.
   */
  PRIOR_BEST_WINDOW_DAYS: 7,
  /**
   * Time-to-due (in ms) at which an upcoming check is flagged "due soon"
   * in the area grid.
   */
  DUE_SOON_THRESHOLD_MS: 60 * 60 * 1000,
} as const;

/** Same as `PRIOR_BEST_WINDOW_DAYS`, expressed in milliseconds. */
export const PRIOR_BEST_WINDOW_MS =
  OPERATOR_THRESHOLDS.PRIOR_BEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Resolved (env > DB > default) thresholds in the units the UI consumes.
 * `dueSoonThresholdMs` is derived from the API's minutes value so all UI
 * call sites can keep working in milliseconds.
 *
 * `dueSoonThresholdMsByAreaId` exposes per-area "due soon" overrides set by
 * managers via the /operator-thresholds admin screen. Areas without an
 * override are absent from the map — callers should fall back to the global
 * `dueSoonThresholdMs`. The `dueSoonThresholdMsForArea` helper does that
 * lookup so call sites don't have to repeat the fallback logic.
 */
export interface ResolvedOperatorThresholds {
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  priorBestWindowMs: number;
  dueSoonThresholdMs: number;
  dueSoonThresholdMsByAreaId: Readonly<Record<number, number>>;
  dueSoonThresholdMsForArea: (areaId: number) => number;
}

const EMPTY_AREA_OVERRIDES: Readonly<Record<number, number>> = Object.freeze({});

function makeResolved(args: {
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  dueSoonThresholdMs: number;
  dueSoonThresholdMsByAreaId: Readonly<Record<number, number>>;
}): ResolvedOperatorThresholds {
  const {
    encouragementMinPercent,
    priorBestWindowDays,
    dueSoonThresholdMs,
    dueSoonThresholdMsByAreaId,
  } = args;
  return {
    encouragementMinPercent,
    priorBestWindowDays,
    priorBestWindowMs: priorBestWindowDays * 24 * 60 * 60 * 1000,
    dueSoonThresholdMs,
    dueSoonThresholdMsByAreaId,
    dueSoonThresholdMsForArea: (areaId: number) =>
      dueSoonThresholdMsByAreaId[areaId] ?? dueSoonThresholdMs,
  };
}

export const DEFAULT_RESOLVED_OPERATOR_THRESHOLDS: ResolvedOperatorThresholds =
  makeResolved({
    encouragementMinPercent: OPERATOR_THRESHOLDS.ENCOURAGEMENT_MIN_PERCENT,
    priorBestWindowDays: OPERATOR_THRESHOLDS.PRIOR_BEST_WINDOW_DAYS,
    dueSoonThresholdMs: OPERATOR_THRESHOLDS.DUE_SOON_THRESHOLD_MS,
    dueSoonThresholdMsByAreaId: EMPTY_AREA_OVERRIDES,
  });

/**
 * React hook that returns the effective operator thresholds. Falls back to
 * the static defaults while the request is in flight or on error so the UI
 * never renders with undefined cutoffs. Refetches on a slow interval so
 * admin tweaks land without a hard refresh.
 */
export function useEffectiveOperatorThresholds(): ResolvedOperatorThresholds {
  const { data } = useGetOperatorThresholds({
    query: {
      // Slow polling: thresholds change rarely. 60s keeps "next request"
      // semantics (per task spec) without hammering the API.
      refetchInterval: 60_000,
      staleTime: 30_000,
      queryKey: getGetOperatorThresholdsQueryKey(),
    },
  });
  if (!data) return DEFAULT_RESOLVED_OPERATOR_THRESHOLDS;
  // Build the per-area "due soon" map from the GET payload's `areaOverrides`
  // list. Only entries with a non-null minutes value contribute — a row that
  // overrides a different field but leaves due-soon as null should still
  // resolve to the global value, not zero.
  const byAreaId: Record<number, number> = {};
  for (const a of data.areaOverrides ?? []) {
    if (typeof a.dueSoonThresholdMinutes === "number") {
      byAreaId[a.areaId] = a.dueSoonThresholdMinutes * 60 * 1000;
    }
  }
  return makeResolved({
    encouragementMinPercent: data.encouragementMinPercent,
    priorBestWindowDays: data.priorBestWindowDays,
    dueSoonThresholdMs: data.dueSoonThresholdMinutes * 60 * 1000,
    dueSoonThresholdMsByAreaId: byAreaId,
  });
}
