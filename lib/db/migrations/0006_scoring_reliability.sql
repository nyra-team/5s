ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "json_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "transient_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "outcome" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_scoring_metrics" ADD COLUMN IF NOT EXISTS "elapsed_ms" integer;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN IF NOT EXISTS "walkthrough_hints_override_json" jsonb;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings_audit" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope" text NOT NULL,
  "subject_id" integer,
  "field" text NOT NULL,
  "old_value" text,
  "new_value" text,
  "changed_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settings_audit_scope_subject_changed_at_idx" ON "settings_audit" ("scope","subject_id","changed_at","id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
  "id" serial PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "conversation_id" integer NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
