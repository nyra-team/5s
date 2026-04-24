import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { usersTable } from "./users";

export const nudgesTable = pgTable("nudges", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  machine: text("machine"),
  shift: text("shift").notNull(),
  message: text("message"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  // Per-user dismissal: each operator who has read this nudge has their id
  // appended here. The nudge stays "active" for any operator whose id is not
  // present, so one operator's read does not silently consume the reminder
  // for the rest of the shift crew.
  seenByUserIdsJson: jsonb("seen_by_user_ids_json").notNull().default([]),
});

export const insertNudgeSchema = createInsertSchema(nudgesTable).omit({ id: true, createdAt: true, seenByUserIdsJson: true });
export type InsertNudge = z.infer<typeof insertNudgeSchema>;
export type Nudge = typeof nudgesTable.$inferSelect;
