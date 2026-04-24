-- Replace the legacy single-scope `operator_settings_audit` table (which only
-- captured global threshold edits) with a unified per-(scope, area) audit
-- table. Existing audit rows in the legacy table are not preserved — there
-- was no per-area data there to carry forward, and the rewritten endpoints
-- write to the new table going forward.
DROP TABLE IF EXISTS "operator_settings_audit" CASCADE;
--> statement-breakpoint
CREATE TABLE "operator_threshold_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"area_id" integer,
	"changed_by_user_id" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"field" text NOT NULL,
	"old_value" integer,
	"new_value" integer
);
--> statement-breakpoint
ALTER TABLE "operator_threshold_changes" ADD CONSTRAINT "operator_threshold_changes_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operator_threshold_changes" ADD CONSTRAINT "operator_threshold_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "operator_threshold_changes_scope_area_changed_at_idx" ON "operator_threshold_changes" USING btree ("scope","area_id","changed_at");
