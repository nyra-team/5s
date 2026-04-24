ALTER TABLE "facility_settings" ADD COLUMN IF NOT EXISTS "reping_threshold_minutes" integer;--> statement-breakpoint
ALTER TABLE "facility_settings" ADD COLUMN IF NOT EXISTS "reping_max_repings" integer;
