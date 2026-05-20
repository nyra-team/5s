CREATE TABLE "ai_score_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"area_id" integer NOT NULL,
	"model_version" text NOT NULL,
	"result_json" jsonb NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_hit_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_score_cache" ADD CONSTRAINT "ai_score_cache_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ai_score_cache_area_idx" ON "ai_score_cache" ("area_id");
--> statement-breakpoint
CREATE INDEX "ai_score_cache_last_hit_idx" ON "ai_score_cache" ("last_hit_at");
