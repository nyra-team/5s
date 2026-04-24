CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'OPERATOR' NOT NULL,
	"notify_email_enabled" boolean DEFAULT true NOT NULL,
	"notify_slack_enabled" boolean DEFAULT false NOT NULL,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_hours_start" text DEFAULT '22:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '07:00' NOT NULL,
	"quiet_hours_weekday_mask" integer DEFAULT 127 NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"environment_type" text DEFAULT 'factory' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"area_id" integer NOT NULL,
	"tapped_area_id" integer,
	"user_id" integer NOT NULL,
	"shift" text NOT NULL,
	"score_total" integer NOT NULL,
	"score_json" jsonb NOT NULL,
	"suggestions_json" jsonb NOT NULL,
	"image_url" text NOT NULL,
	"media_type" text DEFAULT 'image' NOT NULL,
	"keyframes_json" jsonb,
	"machine_tag" text,
	"failing_pillars_json" jsonb,
	"embedding_hash" text,
	"ai_total_score" integer,
	"ai_pillars_json" jsonb,
	"ai_recommendations_json" jsonb,
	"ai_issues_json" jsonb,
	"ai_reasoning_json" jsonb,
	"model_version" text,
	"scoring_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"labeled_by_user_id" integer NOT NULL,
	"pillars_json" jsonb NOT NULL,
	"total_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "area_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"area_id" integer NOT NULL,
	"status" text DEFAULT 'LEARNING' NOT NULL,
	"submissions_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"items_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"machines_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"layout_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"common_issues_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trained_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_profiles_area_id_unique" UNIQUE("area_id")
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" serial PRIMARY KEY NOT NULL,
	"submission_id" integer NOT NULL,
	"area_id" integer NOT NULL,
	"operator_id" integer NOT NULL,
	"score_total" integer NOT NULL,
	"score_percent" integer NOT NULL,
	"failing_pillars_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_actions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_urls_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"acked_by_user_id" integer,
	"acked_at" timestamp with time zone,
	"resolved_by_user_id" integer,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notify_delivery_status" text,
	"reping_count" integer DEFAULT 0 NOT NULL,
	"last_reping_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "area_schedules" (
	"area_id" integer NOT NULL,
	"machine" text DEFAULT '' NOT NULL,
	"cadence_seconds" integer DEFAULT 14400 NOT NULL,
	"last_check_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_schedules_area_id_machine_pk" PRIMARY KEY("area_id","machine")
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" serial PRIMARY KEY NOT NULL,
	"area_id" integer NOT NULL,
	"machine" text,
	"shift" text NOT NULL,
	"message" text,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_user_id" integer,
	"dismiss_reason" text,
	"seen_by_user_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"encouragement_min_percent" integer,
	"prior_best_window_days" integer,
	"due_soon_threshold_minutes" integer,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_settings_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"changed_by_user_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field" text NOT NULL,
	"old_value" integer,
	"new_value" integer
);
--> statement-breakpoint
CREATE TABLE "area_operator_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"area_id" integer NOT NULL,
	"encouragement_min_percent" integer,
	"prior_best_window_days" integer,
	"due_soon_threshold_minutes" integer,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_operator_settings_area_id_unique" UNIQUE("area_id")
);
--> statement-breakpoint
CREATE TABLE "area_assignments" (
	"user_id" integer NOT NULL,
	"area_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_assignments_user_id_area_id_pk" PRIMARY KEY("user_id","area_id")
);
--> statement-breakpoint
CREATE TABLE "ai_scoring_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"model_version" text NOT NULL,
	"retried" boolean NOT NULL,
	"validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"time_zone" varchar(64),
	"shift_a_start_hour" integer,
	"shift_b_start_hour" integer,
	"shift_c_start_hour" integer,
	"updated_by_user_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_tapped_area_id_areas_id_fk" FOREIGN KEY ("tapped_area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_labeled_by_user_id_users_id_fk" FOREIGN KEY ("labeled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_profiles" ADD CONSTRAINT "area_profiles_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_acked_by_user_id_users_id_fk" FOREIGN KEY ("acked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_schedules" ADD CONSTRAINT "area_schedules_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_settings_audit" ADD CONSTRAINT "operator_settings_audit_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_operator_settings" ADD CONSTRAINT "area_operator_settings_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_assignments" ADD CONSTRAINT "area_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "area_assignments" ADD CONSTRAINT "area_assignments_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_scoring_metrics_created_at_idx" ON "ai_scoring_metrics" USING btree ("created_at");