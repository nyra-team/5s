import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { areasTable } from "./areas";

/**
 * Append-only audit log of every per-field change to the operator-facing
 * thresholds — both the singleton global override row (`operator_settings`)
 * and the per-area override rows (`area_operator_settings`). One row per
 * (field, change) so several dials tweaked in a single PUT each get their
 * own entry, and the manager UI can surface a "what moved" view without
 * parsing JSON blobs.
 *
 * `oldValue` / `newValue` are nullable to model the "clear the override"
 * case: NULL means "no DB override at this layer; fall back to the next
 * layer". The `field` column stores the camelCase override key
 * (e.g. "encouragementMinPercent") so it can be matched against the
 * existing FIELD_META on the client without an extra mapping table.
 *
 * This replaces the older `operator_settings_audit` table which only
 * captured the global scope. The unified shape lets the same UI and the
 * same query path serve global and per-area history views.
 */
export const operatorThresholdChangesTable = pgTable(
  "operator_threshold_changes",
  {
    id: serial("id").primaryKey(),
    /**
     * "global" → row describes a change to the singleton global override.
     * "area"   → row describes a change to a per-area override; `areaId`
     *            is set in that case.
     * Stored as text (rather than a pg enum) for the same reason the rest
     * of the codebase avoids enums: simpler migrations and no need to
     * coordinate enum drops/adds across the schema.
     */
    scope: text("scope").notNull(),
    /**
     * NULL when scope = "global". When scope = "area", points at the
     * affected area. ON DELETE SET NULL so deleting an area doesn't
     * cascade-erase the audit trail; the historical record (what moved,
     * when, by whom) is preserved with a dangling area reference.
     */
    areaId: integer("area_id").references(() => areasTable.id, {
      onDelete: "set null",
    }),
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
  },
  (table) => ({
    // The history view filters by (scope, areaId) and orders by
    // changedAt — small dedicated index keeps the lookup O(log n) even
    // as the table grows.
    scopeAreaChangedAtIdx: index(
      "operator_threshold_changes_scope_area_changed_at_idx",
    ).on(table.scope, table.areaId, table.changedAt),
  }),
);

export type OperatorThresholdChangeRow =
  typeof operatorThresholdChangesTable.$inferSelect;
