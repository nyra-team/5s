import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { areasTable } from "./areas";

/**
 * Read-through cache for VLM scoring results. Key is a deterministic hash
 * over (area_id, sorted dHash list of submitted frames, model_version) so
 * a re-capture of the same area with no visual change short-circuits to
 * the previously-computed score instead of round-tripping to Claude.
 *
 * Cache value is the full `AIScoringResult` plus the keyframe URLs that
 * shipped with the original scoring (the operator's new submission gets
 * to keep its OWN keyframe URLs — only the AI judgment is reused).
 *
 * `last_hit_at` lets us prune cold entries on a schedule; `hit_count`
 * surfaces cache effectiveness to the dashboard during Phase 2 follow-up.
 */
export const aiScoreCacheTable = pgTable("ai_score_cache", {
  cacheKey: text("cache_key").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  modelVersion: text("model_version").notNull(),
  resultJson: jsonb("result_json").notNull(),
  // Each frame's dHash as a hex string. Persisted alongside the cached
  // result so a fuzzy near-duplicate lookup can score `(stored_dhashes
  // vs incoming_dhashes)` per-frame in app code (Postgres doesn't have
  // a native Hamming-distance operator we can rely on here). Without
  // this column, only bit-identical uploads can ever hit the cache,
  // which fails the consistency promise — a re-capture of the same
  // physical scene almost always picks up slightly different frames
  // out of ffmpeg's scene-detect pass.
  dhashesJson: jsonb("dhashes_json").notNull().default([]),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiScoreCacheEntry = typeof aiScoreCacheTable.$inferSelect;
