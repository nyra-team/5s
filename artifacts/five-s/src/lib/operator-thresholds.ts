/**
 * Tunable thresholds used by the operator UI. Centralized so adjusting any of
 * these values doesn't require touching component logic or test fixtures —
 * the page, the matching tests, and any helpers all read from here.
 *
 * Score domain reminder: a submission's `scoreTotal` ranges 0..25 (five 5S
 * pillars × 5 points). Display percent is `scoreTotal * 4`.
 */
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
