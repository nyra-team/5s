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
