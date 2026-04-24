CREATE TABLE IF NOT EXISTS "ai_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "vlm_model" text,
  "updated_by_user_id" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
