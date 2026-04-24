import path from "node:path";
import fs from "node:fs";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  submissionsTable,
  areasTable,
  type EnvironmentType,
  ENVIRONMENT_TYPES,
} from "@workspace/db";
import { scoreSubmission, type VLMPillarReasoning } from "./ai-scoring.js";
import { getOrCreateProfile } from "./learning.js";
import { logger } from "./logger.js";

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

export const DEFAULT_BATCH_LIMIT = 25;
export const MAX_BATCH_LIMIT = 100;

export interface BackfillRowResult {
  submissionId: number;
  status: "updated" | "missing_media" | "scoring_failed" | "would_update";
  reason?: string;
}

export interface BackfillSummary {
  scanned: number;
  updated: number;
  missingMedia: number;
  scoringFailed: number;
  dryRun: boolean;
  results: BackfillRowResult[];
}

export interface BackfillOptions {
  limit: number;
  submissionId?: number | null;
  dryRun?: boolean;
}

function resolveMediaAbsPath(imageUrl: string): string | null {
  if (typeof imageUrl !== "string" || imageUrl.length === 0) return null;
  const prefix = "/uploads/";
  if (!imageUrl.startsWith(prefix)) return null;
  const filename = path.basename(imageUrl.slice(prefix.length));
  if (!filename) return null;
  const abs = path.join(UPLOADS_DIR, filename);
  if (!abs.startsWith(UPLOADS_DIR + path.sep) && abs !== UPLOADS_DIR) return null;
  return abs;
}

function coerceEnvironmentType(value: unknown): EnvironmentType {
  return (ENVIRONMENT_TYPES as readonly string[]).includes(String(value))
    ? (value as EnvironmentType)
    : "factory";
}

/**
 * Count submissions still missing per-pillar reasoning. Used by the admin
 * endpoint (so an operator running it iteratively knows when they're done)
 * and the nightly scheduler (so logs make the queue depth visible).
 */
export async function countBackfillReasoningRemaining(): Promise<number> {
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(submissionsTable)
    .where(isNull(submissionsTable.aiReasoningJson));
  return remaining;
}

/**
 * Scan submissions whose `aiReasoningJson` is NULL (legacy rows from before
 * per-pillar reasoning was captured), re-run the VLM against the original
 * stored media, and write ONLY the reasoning back to the row. The persisted
 * `scoreTotal`, `aiPillarsJson`, `aiIssuesJson` and `aiRecommendationsJson`
 * are deliberately left untouched so historical audits and any downstream
 * metrics stay reproducible — the goal is purely to fill in the per-pillar
 * "why" so old detail dialogs no longer say "No reasoning recorded."
 *
 * Shared by the manager-only admin endpoint and the nightly scheduler.
 */
export async function runBackfillReasoningBatch(
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  const { limit, submissionId = null, dryRun = false } = opts;

  const baseConditions = [isNull(submissionsTable.aiReasoningJson)];
  if (submissionId !== null) {
    baseConditions.push(eq(submissionsTable.id, submissionId));
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
    .limit(submissionId !== null ? 1 : limit);

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
      // historical audits stay reproducible. Guard the WHERE on
      // aiReasoningJson IS NULL so a concurrent run that already populated
      // this row doesn't get clobbered.
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
        // Another worker beat us to it — count as a no-op success.
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

  return summary;
}
