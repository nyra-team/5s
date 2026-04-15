import { pgTable, text, serial, integer, timestamp, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { usersTable } from "./users";

export const submissionsTable = pgTable("submissions", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  shift: text("shift").notNull(),
  scoreTotal: integer("score_total").notNull(),
  scoreJson: jsonb("score_json").notNull(),
  suggestionsJson: jsonb("suggestions_json").notNull(),
  imageUrl: text("image_url").notNull(),
  embeddingHash: text("embedding_hash"),
  similarityToIdeal: doublePrecision("similarity_to_ideal"),
  aiTotalScore: integer("ai_total_score"),
  aiPillarsJson: jsonb("ai_pillars_json"),
  aiRecommendationsJson: jsonb("ai_recommendations_json"),
  aiIssuesJson: jsonb("ai_issues_json"),
  modelVersion: text("model_version"),
  scoringMode: text("scoring_mode"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSubmissionSchema = createInsertSchema(submissionsTable).omit({ id: true, createdAt: true });
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissionsTable.$inferSelect;
