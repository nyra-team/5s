ALTER TABLE "ai_score_cache" ADD COLUMN "dhashes_json" jsonb NOT NULL DEFAULT '[]'::jsonb;
