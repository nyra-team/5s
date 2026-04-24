import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Append-only audit log of every per-field change to the singleton
 * `operator_settings` row. One row per (field, change) so several dials
 * tweaked in a single PUT each get their own entry — keeps the manager UI
 * able to surface a "what moved" view without parsing JSON blobs.
 *
 * `oldValue` / `newValue` are nullable to model the "clear the override"
 * case: NULL means "no DB override; fall back to env/default". The
 * `field` column stores the camelCase override key
 * (e.g. "encouragementMinPercent") so it can be matched against the
 * existing FIELD_META on the client without an extra mapping table.
 *
 * Retention: this table is bounded by `pruneOperatorSettingsAudit()` in
 * the API server, which runs inline after every audit insert and keeps
 * only the most recent N rows per `field` (default 50, override via
 * `OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD`). With three threshold fields
 * the table is therefore capped at ~150 rows in steady state, instead of
 * growing forever. The admin UI surfaces only the last 5 entries, so the
 * cap is well above what's user-visible while still leaving a deep
 * compliance trail. See `artifacts/api-server/src/lib/audit-prune.ts`.
 */
export const operatorSettingsAuditTable = pgTable("operator_settings_audit", {
  id: serial("id").primaryKey(),
  // Nullable + ON DELETE SET NULL so deactivating/removing a manager
  // preserves the historical record (oldValue/newValue/changedAt stay
  // intact) — the actor link just becomes null, which the API and UI
  // already render as a graceful "user #?" fallback. Insertion always
  // sets this from the authenticated PUT, so live audit rows always
  // have an attributable user.
  changedByUserId: integer("changed_by_user_id").references(
    () => usersTable.id,
    { onDelete: "set null" },
  ),
  changedAt: timestamp("changed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  field: text("field").notNull(),
  oldValue: integer("old_value"),
  newValue: integer("new_value"),
});

export type OperatorSettingsAuditRow =
  typeof operatorSettingsAuditTable.$inferSelect;
