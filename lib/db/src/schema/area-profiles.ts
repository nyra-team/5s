import { pgTable, text, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
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
  trainedAt: timestamp("trained_at", { withTimezone: true }),
  // Auto-retune bookkeeping. `needsRebuild` is the queryable flag the
  // dashboard CTA reads from; it's set by the auto-flag hook when this
  // area's recent agreement falls below the configured threshold and
  // cleared by a successful rebuild. `flaggedAt` records the most recent
  // flagging time so the UI can surface "flagged 2h ago"; `flagReason`
  // is a short tag (e.g. "low-agreement") for future expansion.
  // `lastRebuildAt` records the last successful rebuild so we can show
  // managers when the profile was last refreshed.
  needsRebuild: boolean("needs_rebuild").notNull().default(false),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }),
  flagReason: text("flag_reason"),
  lastRebuildAt: timestamp("last_rebuild_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAreaProfileSchema = createInsertSchema(areaProfilesTable).omit({ id: true, updatedAt: true });
export type InsertAreaProfile = z.infer<typeof insertAreaProfileSchema>;
export type AreaProfile = typeof areaProfilesTable.$inferSelect;
