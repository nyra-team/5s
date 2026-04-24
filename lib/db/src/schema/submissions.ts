import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { usersTable } from "./users";

export const submissionsTable = pgTable("submissions", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  // The area the operator originally tapped before auto-detect (or a manual
  // override) may have switched the chosen area. Persisted so we can measure
  // detection drift per area / per operator and feed corrections back into
  // the area-identification prompt. Nullable because legacy rows from before
  // this column existed don't carry an originally-tapped area.
  tappedAreaId: integer("tapped_area_id").references(() => areasTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  shift: text("shift").notNull(),
  scoreTotal: integer("score_total").notNull(),
  scoreJson: jsonb("score_json").notNull(),
  suggestionsJson: jsonb("suggestions_json").notNull(),
  imageUrl: text("image_url").notNull(),
  mediaType: text("media_type").notNull().default("image"),
  keyframesJson: jsonb("keyframes_json"),
  /**
   * Per-step ffmpeg/dedup/compress timings + counts captured during scoring,
   * mirroring `KeyframeMetrics` from the AI scoring lib. Only populated for
   * video submissions (image submissions skip keyframe extraction). Surfaced
   * in the manager audit detail view so a manager can judge whether their
   * walk-through is slow because of scene detection, dedup, or compression
   * — and decide whether to lower `KEYFRAMES_MAX_CANDIDATES` for the site.
   * Nullable for image submissions and for legacy rows recorded before this
   * column existed.
   */
  keyframeMetricsJson: jsonb("keyframe_metrics_json"),
  machineTag: text("machine_tag"),
  failingPillarsJson: jsonb("failing_pillars_json"),
  embeddingHash: text("embedding_hash"),
  aiTotalScore: integer("ai_total_score"),
  aiPillarsJson: jsonb("ai_pillars_json"),
  aiRecommendationsJson: jsonb("ai_recommendations_json"),
  aiIssuesJson: jsonb("ai_issues_json"),
  aiReasoningJson: jsonb("ai_reasoning_json"),
  modelVersion: text("model_version"),
  scoringMode: text("scoring_mode"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSubmissionSchema = createInsertSchema(submissionsTable).omit({ id: true, createdAt: true });
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
export type Submission = typeof submissionsTable.$inferSelect;
