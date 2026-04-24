import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

/**
 * Hard cap on `operator_threshold_changes` rows kept per audit stream,
 * where an "audit stream" is a unique `(scope, area_id, field)` tuple.
 *
 * Why per-(scope, area, field) rather than a global LIMIT or per-field-only:
 * each threshold (`encouragementMinPercent`, `priorBestWindowDays`,
 * `dueSoonThresholdMinutes`) tells its own story, AND the global override
 * and each per-area override row are independent stories. A burst of edits
 * to one area's "due soon" threshold shouldn't push useful history of a
 * rarely-touched global setting (or a different area) out of the table.
 *
 * Defaults to 50 (10× the 5 the UI surfaces). Override at runtime via
 * `OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD`.
 */
const DEFAULT_KEEP_PER_FIELD = 50;

export function getAuditKeepPerField(): number {
  const raw = process.env.OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD;
  if (raw == null || raw === "") return DEFAULT_KEEP_PER_FIELD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return DEFAULT_KEEP_PER_FIELD;
  }
  return n;
}

/**
 * Trim `operator_threshold_changes` to the most recent `keepPerField` rows
 * for each distinct `(scope, area_id, field)` tuple. Returns the number of
 * rows deleted.
 *
 * Implementation note: we run a single window-function DELETE rather than
 * loading rows into JS so a year of accumulated history can be pruned in
 * one round-trip. ORDER BY `(changed_at DESC, id DESC)` mirrors the API's
 * audit query so what the UI shows is precisely what we keep — even if two
 * writes share the exact same `changedAt` timestamp the higher-id (newer)
 * row wins.
 *
 * `area_id` is part of the partition with `IS NOT DISTINCT FROM` semantics
 * baked into the window: PostgreSQL's `PARTITION BY` already treats two
 * NULLs as the same group, which is exactly what we want for the global
 * scope (all global rows share `area_id = NULL`).
 *
 * Pass-throughs:
 *   * `keepPerField <= 0` — treated as "policy disabled" and returns 0.
 *   * `keepPerField` not finite — same.
 */
export async function pruneOperatorSettingsAudit(
  keepPerField: number = getAuditKeepPerField(),
): Promise<number> {
  if (!Number.isFinite(keepPerField) || keepPerField <= 0) return 0;

  const result = await db.execute(sql`
    DELETE FROM operator_threshold_changes
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY scope, area_id, field
          ORDER BY changed_at DESC, id DESC
        ) AS rn
        FROM operator_threshold_changes
      ) ranked
      WHERE ranked.rn > ${keepPerField}
    )
  `);

  const deleted = (result as { rowCount?: number | null }).rowCount ?? 0;
  if (deleted > 0) {
    logger.info(
      { deleted, keepPerField },
      "operator_threshold_changes: pruned rows beyond per-(scope, area, field) retention cap",
    );
  }
  return deleted;
}
