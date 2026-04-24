import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { areasTable } from "./areas";

/**
 * Per-area override row for the operator-facing thresholds. Layered on top of
 * the global `operator_settings` row so a manager can tighten (or relax) a
 * specific area without affecting the rest of the plant — e.g. a 24/7
 * bottling line that needs a shorter "due soon" lead than the low-traffic
 * packing area.
 *
 * Resolution order on the API server (see `operator-thresholds.ts` resolver):
 *   env > area-DB > global-DB > default
 *
 * NULL on any field means "no override at this layer for this area, fall
 * through to the next layer". `area_id` is unique so we can keep the same
 * single-row-per-area upsert pattern the global table uses.
 */
export const areaOperatorSettingsTable = pgTable("area_operator_settings", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id")
    .notNull()
    .references(() => areasTable.id, { onDelete: "cascade" })
    .unique(),
  /** 0..100. NULL = no per-area override (fall back to global / env / default). */
  encouragementMinPercent: integer("encouragement_min_percent"),
  /** 1..365. NULL = no per-area override. */
  priorBestWindowDays: integer("prior_best_window_days"),
  /** 0..1440. NULL = no per-area override. */
  dueSoonThresholdMinutes: integer("due_soon_threshold_minutes"),
  /** Manager who last touched the row, for audit. */
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AreaOperatorSettingsRow =
  typeof areaOperatorSettingsTable.$inferSelect;
