import { pgTable, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { submissionsTable } from "./submissions";
import { usersTable } from "./users";

export const labelsTable = pgTable("labels", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => submissionsTable.id),
  labeledByUserId: integer("labeled_by_user_id").notNull().references(() => usersTable.id),
  pillarsJson: jsonb("pillars_json").notNull(),
  totalScore: integer("total_score").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLabelSchema = createInsertSchema(labelsTable).omit({ id: true, createdAt: true });
export type InsertLabel = z.infer<typeof insertLabelSchema>;
export type Label = typeof labelsTable.$inferSelect;
