ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "keyframe_metrics_json" jsonb;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "call_kind" text DEFAULT 'scoring' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "completion_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "total_tokens" integer;
