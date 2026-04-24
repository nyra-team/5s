CREATE TABLE IF NOT EXISTS "settings_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"subject_id" integer,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by_user_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "area_detection_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"area_id" integer NOT NULL,
	"tapped_area_id" integer,
	"ai_suggested_area_id" integer,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE IF EXISTS "operator_settings_audit" CASCADE;--> statement-breakpoint
ALTER TABLE "areas" ADD COLUMN IF NOT EXISTS "walkthrough_hints_override_json" jsonb;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "profile_extract_json" jsonb;--> statement-breakpoint
ALTER TABLE "area_profiles" ADD COLUMN IF NOT EXISTS "needs_rebuild" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "area_profiles" ADD COLUMN IF NOT EXISTS "flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "area_profiles" ADD COLUMN IF NOT EXISTS "flag_reason" text;--> statement-breakpoint
ALTER TABLE "area_profiles" ADD COLUMN IF NOT EXISTS "last_rebuild_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "settings_audit" ADD CONSTRAINT "settings_audit_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "area_detection_events" ADD CONSTRAINT "area_detection_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "area_detection_events" ADD CONSTRAINT "area_detection_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "area_detection_events" ADD CONSTRAINT "area_detection_events_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "area_detection_events" ADD CONSTRAINT "area_detection_events_tapped_area_id_areas_id_fk" FOREIGN KEY ("tapped_area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "area_detection_events" ADD CONSTRAINT "area_detection_events_ai_suggested_area_id_areas_id_fk" FOREIGN KEY ("ai_suggested_area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settings_audit_scope_subject_changed_at_idx" ON "settings_audit" USING btree ("scope","subject_id","changed_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "area_detection_events_area_created_idx" ON "area_detection_events" USING btree ("area_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "area_detection_events_submission_idx" ON "area_detection_events" USING btree ("submission_id");
