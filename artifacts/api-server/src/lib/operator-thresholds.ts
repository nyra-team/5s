/**
 * Server-side mirror of the operator-facing thresholds defined in the web
 * artifact (`artifacts/five-s/src/lib/operator-thresholds.ts`). Kept here so
 * the API can compute prior-week stats without depending on the web bundle.
 *
 * If you change a value here, change it in the web artifact too — the
 * encouragement chip relies on `bestScoreInLastWeek` matching this window.
 */
export const OPERATOR_THRESHOLDS = {
  /**
   * Lookback window (in days) used by `/operator/recent` to compute each
   * submission's `bestScoreInLastWeek`. Drives the operator UI's
   * "New best this week" encouragement chip.
   */
  PRIOR_BEST_WINDOW_DAYS: 7,
} as const;

/** Same as `PRIOR_BEST_WINDOW_DAYS`, expressed in milliseconds. */
export const PRIOR_BEST_WINDOW_MS =
  OPERATOR_THRESHOLDS.PRIOR_BEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
