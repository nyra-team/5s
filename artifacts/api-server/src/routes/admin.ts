import { Router, type IRouter } from "express";
import { isNull, sql } from "drizzle-orm";
import { db, submissionsTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  countBackfillReasoningRemaining,
  runBackfillReasoningBatch,
  DEFAULT_BATCH_LIMIT,
  MAX_BATCH_LIMIT,
} from "../lib/backfill-reasoning.js";

const router: IRouter = Router();

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(MAX_BATCH_LIMIT, n);
}

function parseSubmissionId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `?dryRun=1` / `=true` / `=yes` -> true; everything else (including
 *  `=false`, `=0`, `=no`, an empty value, or the param being absent) -> false.
 *  We deliberately don't accept the bare `Boolean(req.query.dryRun)` truthiness
 *  test because `?dryRun=false` would silently turn into a no-op run. */
function parseDryRun(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * GET /api/admin/backfill-reasoning
 *
 * Lightweight read-only counterpart to the POST below: returns just how many
 * legacy submissions still have a NULL `aiReasoningJson`. The manager
 * dashboard polls this so the "Backfill AI explanations" panel can show the
 * outstanding count without having to actually trigger (or even dry-run) a
 * batch — dry-running still scans candidates and is overkill when all we need
 * is the headline number.
 */
router.get(
  "/admin/backfill-reasoning",
  authMiddleware,
  requireRole("MANAGER"),
  async (_req, res): Promise<void> => {
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(submissionsTable)
      .where(isNull(submissionsTable.aiReasoningJson));
    res.json({ remaining });
  },
);

/**
 * POST /api/admin/backfill-reasoning
 *
 * Manager-only one-shot endpoint that drains legacy submissions whose
 * `aiReasoningJson` is NULL by calling the shared
 * `runBackfillReasoningBatch` helper. The same helper backs the nightly
 * scheduler in `backfill-reasoning-scheduler.ts`.
 *
 * Query params:
 *   - limit         max submissions to process this call (default 25, cap 100)
 *   - submissionId  process only this one row (overrides limit; useful for
 *                   debugging a stuck row)
 *   - dryRun        any truthy value -> report what would change without
 *                   touching the DB or hitting the VLM
 */
router.post(
  "/admin/backfill-reasoning",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const limit = parseLimit(req.query.limit);
    const submissionId = parseSubmissionId(req.query.submissionId);
    const dryRun = parseDryRun(req.query.dryRun);

    const summary = await runBackfillReasoningBatch({ limit, submissionId, dryRun });
    const remaining = await countBackfillReasoningRemaining();

    res.json({ ...summary, remaining });
  },
);

export default router;
