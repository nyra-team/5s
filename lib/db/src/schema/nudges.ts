import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { usersTable } from "./users";

// Why a nudge was cleared. Lets the manager UI distinguish "operator submitted
// new evidence" (SUBMISSION) from "operator tapped dismiss without
// re-capturing" (OPERATOR_DISMISS) so habitual dismiss-without-fix patterns
// are visible on the Live shift view.
export type NudgeDismissReason = "SUBMISSION" | "OPERATOR_DISMISS";

export const nudgesTable = pgTable("nudges", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  machine: text("machine"),
  shift: text("shift").notNull(),
  message: text("message"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  // Who cleared the nudge and how. Both are populated together when dismissedAt
  // is set; null when the nudge is still active. dismissReason is one of
  // NudgeDismissReason values above.
  dismissedByUserId: integer("dismissed_by_user_id").references(() => usersTable.id),
  dismissReason: text("dismiss_reason"),
  // Per-user dismissal: each operator who has read this nudge has their id
  // appended here. The nudge stays "active" for any operator whose id is not
  // present, so one operator's read does not silently consume the reminder
  // for the rest of the shift crew.
  seenByUserIdsJson: jsonb("seen_by_user_ids_json").notNull().default([]),
});

export const insertNudgeSchema = createInsertSchema(nudgesTable).omit({ id: true, createdAt: true, seenByUserIdsJson: true });
export type InsertNudge = z.infer<typeof insertNudgeSchema>;
export type Nudge = typeof nudgesTable.$inferSelect;
