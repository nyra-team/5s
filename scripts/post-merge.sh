#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

# Backfill area_profiles.trained_at for any TRAINED rows that pre-date the
# column. We use the timestamp of the 5th submission (TRAINING_THRESHOLD) as
# the graduation moment. Idempotent: only fills NULLs, only touches TRAINED
# rows, and skips areas with fewer than 5 submissions. Wrapped in a DO block
# so it no-ops cleanly if area_profiles doesn't exist yet.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'area_profiles' AND column_name = 'trained_at'
  ) THEN
    UPDATE area_profiles ap
    SET trained_at = sub.fifth_at
    FROM (
      SELECT area_id, created_at AS fifth_at FROM (
        SELECT area_id, created_at,
               ROW_NUMBER() OVER (PARTITION BY area_id ORDER BY created_at ASC) AS rn
        FROM submissions
      ) ranked
      WHERE rn = 5
    ) sub
    WHERE ap.area_id = sub.area_id
      AND ap.status = 'TRAINED'
      AND ap.trained_at IS NULL;
  END IF;
END$$;
SQL
