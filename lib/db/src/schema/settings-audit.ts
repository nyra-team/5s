import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Generic, append-only audit log for any manager-tunable setting.
 *
 * The original `operator_settings_audit` table was specific to the
 * operator-thresholds page (one column per integer field). This table
 * is the reusable replacement that other settings endpoints — notification
 * preferences, escalation thresholds, AI rubrics, future dials — can write
 * into without each one rolling its own table or migration.
 *
 * Shape rationale:
 *   * `scope` identifies which settings page/group the row belongs to
 *     (e.g. "notification_preferences"). The endpoint that writes the
 *     row picks the constant.
 *   * `subjectId` is a free-form integer that lets per-user (or per-area,
 *     per-area-rubric, etc.) settings disambiguate WHICH row was changed.
 *     It's nullable so singleton settings can leave it off.
 *   * `oldValue` / `newValue` are stored as JSON-encoded text so the same
 *     table can hold booleans, numbers, strings, and null without needing
 *     a polymorphic value column. Endpoints that read the rows back are
 *     responsible for decoding them; the helper module
 *     (`lib/settings-audit.ts` in api-server) handles this for callers.
 *   * `changedByUserId` is a nullable FK with ON DELETE SET NULL so the
 *     historical record (what moved, when, from/to) is preserved when a
 *     manager is deactivated/removed — matching the pattern in
 *     `operator_settings_audit`.
 *
 * The composite index on (scope, subjectId, changedAt DESC, id DESC) makes
 * the "latest N entries for this scope/subject" query — the only read
 * pattern we have today — index-only.
 */
export const settingsAuditTable = pgTable(
  "settings_audit",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(),
    subjectId: integer("subject_id"),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedByUserId: integer("changed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("settings_audit_scope_subject_changed_at_idx").on(
      t.scope,
      t.subjectId,
      t.changedAt,
      t.id,
    ),
  ],
);

export type SettingsAuditRow = typeof settingsAuditTable.$inferSelect;
