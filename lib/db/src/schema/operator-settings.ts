import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row table that stores admin-tunable overrides for the operator-facing
 * thresholds (encouragement chip cutoff, prior-best lookback window, "due
 * soon" lead time). Lets plant managers tune them at runtime instead of
 * shipping a redeploy. The settings module on the API server merges these
 * with optional environment overrides and the static defaults — a NULL here
 * means "use the env var, otherwise fall back to the default".
 *
 * Per-facility overrides aren't modeled (this product has no facility table
 * yet), so the global row identified by the lowest id wins.
 */
export const operatorSettingsTable = pgTable("operator_settings", {
  id: serial("id").primaryKey(),
  /** 0..100. NULL = no DB override. */
  encouragementMinPercent: integer("encouragement_min_percent"),
  /** 1..365. NULL = no DB override. */
  priorBestWindowDays: integer("prior_best_window_days"),
  /** 0..1440. NULL = no DB override. */
  dueSoonThresholdMinutes: integer("due_soon_threshold_minutes"),
  /** Manager who last touched the row, for audit. */
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OperatorSettingsRow = typeof operatorSettingsTable.$inferSelect;
