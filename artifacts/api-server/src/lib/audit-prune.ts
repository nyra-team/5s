import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

/**
 * Hard cap on `operator_settings_audit` rows kept per `field`.
 *
 * Why per-field rather than a global LIMIT: each threshold (`encouragementMinPercent`,
 * `priorBestWindowDays`, `dueSoonThresholdMinutes`) tells its own story, and a
 * burst of edits to one field shouldn't push useful history of a rarely-touched
 * field out of the table. Three fields × N rows = a strict, predictable upper
 * bound (default 3 × 50 = 150 rows total) that the admin UI's "recent changes"
 * list comfortably fits inside while still leaving plenty of headroom for
 * compliance-style spot checks.
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
 * Trim `operator_settings_audit` to the most recent `keepPerField` rows for
 * each distinct `field`. Returns the number of rows deleted.
 *
 * Implementation note: we run a single window-function DELETE rather than
 * loading rows into JS so a year of accumulated history can be pruned in one
 * round-trip. ORDER BY `(changed_at DESC, id DESC)` mirrors the API's audit
 * query so what the UI shows is precisely what we keep — even if two writes
 * share the exact same `changedAt` timestamp the higher-id (newer) row wins.
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
    DELETE FROM operator_settings_audit
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY field
          ORDER BY changed_at DESC, id DESC
        ) AS rn
        FROM operator_settings_audit
      ) ranked
      WHERE ranked.rn > ${keepPerField}
    )
  `);

  const deleted = (result as { rowCount?: number | null }).rowCount ?? 0;
  if (deleted > 0) {
    logger.info(
      { deleted, keepPerField },
      "operator_settings_audit: pruned rows beyond per-field retention cap",
    );
  }
  return deleted;
}
