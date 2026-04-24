import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";

export const areaProfilesTable = pgTable("area_profiles", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id).unique(),
  status: text("status").notNull().default("LEARNING"),
  submissionsCount: integer("submissions_count").notNull().default(0),
  summary: text("summary"),
  itemsJson: jsonb("items_json").notNull().default([]),
  machinesJson: jsonb("machines_json").notNull().default([]),
  layoutJson: jsonb("layout_json").notNull().default([]),
  commonIssuesJson: jsonb("common_issues_json").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAreaProfileSchema = createInsertSchema(areaProfilesTable).omit({ id: true, updatedAt: true });
export type InsertAreaProfile = z.infer<typeof insertAreaProfileSchema>;
export type AreaProfile = typeof areaProfilesTable.$inferSelect;
