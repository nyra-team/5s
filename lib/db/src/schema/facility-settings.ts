import { pgTable, serial, varchar, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row table that stores the manager-tunable facility shift schedule
 * (timezone + the three shift start hours) and the escalation re-ping
 * cadence (threshold + cap). Mirrors the bootstrap defaults coming from
 * `SHIFT_TIMEZONE` / `SHIFT_A_START_HOUR` / `SHIFT_B_START_HOUR` /
 * `SHIFT_C_START_HOUR` / `ESCALATION_REPING_THRESHOLD_MINUTES` /
 * `ESCALATION_REPING_MAX_COUNT` env vars: a NULL column means "use the env
 * var, otherwise the shipped default".
 *
 * Per-facility overrides aren't modeled (this product has no facility table
 * yet), so the global row identified by the lowest id wins. Same pattern as
 * `operator_settings`.
 */
export const facilitySettingsTable = pgTable("facility_settings", {
  id: serial("id").primaryKey(),
  /** IANA timezone string (e.g. "Asia/Kolkata"). NULL = use env/default. */
  timeZone: varchar("time_zone", { length: 64 }),
  /** Hour-of-day (0..23) shift A starts. NULL = use env/default. */
  shiftAStartHour: integer("shift_a_start_hour"),
  /** Hour-of-day (0..23) shift B starts. NULL = use env/default. */
  shiftBStartHour: integer("shift_b_start_hour"),
  /** Hour-of-day (0..23) shift C starts. NULL = use env/default. */
  shiftCStartHour: integer("shift_c_start_hour"),
  /**
   * Minutes an OPEN escalation must sit untouched before the scheduler
   * re-pings managers. Positive integer; NULL = use env/default.
   */
  repingThresholdMinutes: integer("reping_threshold_minutes"),
  /**
   * Maximum number of re-ping reminders to send per escalation. 0 disables
   * re-pings entirely. NULL = use env/default.
   */
  repingMaxRepings: integer("reping_max_repings"),
  /** Manager who last touched the row, for audit. */
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type FacilitySettingsRow = typeof facilitySettingsTable.$inferSelect;
