import { Router, type IRouter } from "express";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs";
import {
  db,
  submissionsTable,
  areasTable,
  type EnvironmentType,
  ENVIRONMENT_TYPES,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { scoreSubmission, type VLMPillarReasoning } from "../lib/ai-scoring.js";
import { getOrCreateProfile } from "../lib/learning";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

const DEFAULT_BATCH_LIMIT = 25;
const MAX_BATCH_LIMIT = 100;

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

function resolveMediaAbsPath(imageUrl: string): string | null {
  // imageUrl looks like "/uploads/<filename>" — strip the prefix and resolve
  // against the uploads dir. Anything else (absolute http URLs, weird paths)
  // is treated as missing because we can't re-run VLM without local pixels.
  if (typeof imageUrl !== "string" || imageUrl.length === 0) return null;
  const prefix = "/uploads/";
  if (!imageUrl.startsWith(prefix)) return null;
  const filename = path.basename(imageUrl.slice(prefix.length));
  if (!filename) return null;
  const abs = path.join(UPLOADS_DIR, filename);
  // Defence in depth: never let a crafted imageUrl escape the uploads dir.
  if (!abs.startsWith(UPLOADS_DIR + path.sep) && abs !== UPLOADS_DIR) return null;
  return abs;
}

function coerceEnvironmentType(value: unknown): EnvironmentType {
  return (ENVIRONMENT_TYPES as readonly string[]).includes(String(value))
    ? (value as EnvironmentType)
    : "factory";
}

interface BackfillRowResult {
  submissionId: number;
  status: "updated" | "missing_media" | "scoring_failed" | "would_update";
  reason?: string;
}

interface BackfillSummary {
  scanned: number;
  updated: number;
  missingMedia: number;
  scoringFailed: number;
  dryRun: boolean;
  results: BackfillRowResult[];
}

/**
 * POST /api/admin/backfill-reasoning
 *
 * Manager-only one-shot endpoint that scans submissions whose `aiReasoningJson`
 * is NULL (legacy rows from before per-pillar reasoning was captured), re-runs
 * the VLM against the original stored media, and writes ONLY the reasoning
 * back to the row. The persisted `scoreTotal`, `aiPillarsJson`, `aiIssuesJson`
 * and `aiRecommendationsJson` are deliberately left untouched so historical
 * audits and any downstream metrics stay reproducible — the goal is purely to
 * fill in the per-pillar "why" so old detail dialogs no longer say
 * "No reasoning recorded."
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
    const onlyId = parseSubmissionId(req.query.submissionId);
    const dryRun = parseDryRun(req.query.dryRun);

    const baseConditions = [isNull(submissionsTable.aiReasoningJson)];
    if (onlyId !== null) {
      baseConditions.push(eq(submissionsTable.id, onlyId));
    }

    const candidates = await db
      .select({
        id: submissionsTable.id,
        areaId: submissionsTable.areaId,
        areaName: areasTable.name,
        environmentType: areasTable.environmentType,
        mediaType: submissionsTable.mediaType,
        imageUrl: submissionsTable.imageUrl,
        machineTag: submissionsTable.machineTag,
      })
      .from(submissionsTable)
      .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
      .where(and(...baseConditions))
      .orderBy(asc(submissionsTable.id))
      .limit(onlyId !== null ? 1 : limit);

    const summary: BackfillSummary = {
      scanned: candidates.length,
      updated: 0,
      missingMedia: 0,
      scoringFailed: 0,
      dryRun,
      results: [],
    };

    for (const row of candidates) {
      const absPath = resolveMediaAbsPath(row.imageUrl);
      if (!absPath || !fs.existsSync(absPath)) {
        summary.missingMedia++;
        summary.results.push({
          submissionId: row.id,
          status: "missing_media",
          reason: absPath
            ? `media file not found on disk: ${path.basename(absPath)}`
            : `imageUrl does not point at /uploads/: ${row.imageUrl}`,
        });
        continue;
      }

      if (dryRun) {
        summary.results.push({ submissionId: row.id, status: "would_update" });
        continue;
      }

      try {
        const profile = await getOrCreateProfile(row.areaId);
        const learnedProfile = {
          status: profile.status as "LEARNING" | "TRAINED",
          items: (profile.itemsJson as string[]) ?? [],
          machines: (profile.machinesJson as string[]) ?? [],
          layout: (profile.layoutJson as string[]) ?? [],
          commonIssues: (profile.commonIssuesJson as string[]) ?? [],
          summary: profile.summary,
        };

        const mediaType = row.mediaType === "video" ? "video" : "image";
        const scoring = await scoreSubmission({
          areaId: row.areaId,
          areaName: row.areaName,
          mediaAbsPath: absPath,
          mediaType,
          machineTag: row.machineTag,
          environmentType: coerceEnvironmentType(row.environmentType),
          learnedProfile,
        });

        const reasoning: VLMPillarReasoning | null = scoring.aiReasoningJson;
        if (!reasoning) {
          // VLM still failed (e.g. proxy down, JSON validation gave up). Don't
          // overwrite anything — leave the row for a future retry. The
          // existing pillar scores stay as-is regardless.
          summary.scoringFailed++;
          summary.results.push({
            submissionId: row.id,
            status: "scoring_failed",
            reason: "VLM did not return reasoning on retry",
          });
          continue;
        }

        // Update ONLY aiReasoningJson. Persisted scoreTotal / aiPillarsJson /
        // aiIssuesJson / aiRecommendationsJson are explicitly preserved so
        // historical audits stay reproducible (the freshly-computed pillars
        // could differ from what the operator saw at the time, and we don't
        // want to silently rewrite history).
        //
        // Guard the WHERE on aiReasoningJson IS NULL so a concurrent run that
        // already populated this row doesn't get clobbered.
        const updated = await db
          .update(submissionsTable)
          .set({ aiReasoningJson: reasoning })
          .where(
            and(
              eq(submissionsTable.id, row.id),
              isNull(submissionsTable.aiReasoningJson),
            ),
          )
          .returning({ id: submissionsTable.id });

        if (updated.length > 0) {
          summary.updated++;
          summary.results.push({ submissionId: row.id, status: "updated" });
        } else {
          // Another worker beat us to it — count as scanned but not as our
          // own update. Treat it as a no-op success.
          summary.results.push({
            submissionId: row.id,
            status: "updated",
            reason: "row already populated by another worker",
          });
        }
      } catch (err) {
        logger.error(
          { err, submissionId: row.id },
          "backfill-reasoning: scoring failed for submission",
        );
        summary.scoringFailed++;
        summary.results.push({
          submissionId: row.id,
          status: "scoring_failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // How many legacy rows are still outstanding after this batch — useful so
    // an operator running this iteratively knows when they're done.
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(submissionsTable)
      .where(isNull(submissionsTable.aiReasoningJson));

    res.json({ ...summary, remaining });
  },
);

export default router;
