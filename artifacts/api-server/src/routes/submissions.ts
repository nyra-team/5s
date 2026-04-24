import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql, or, ilike, inArray } from "drizzle-orm";
import path from "node:path";
import {
  db,
  submissionsTable,
  areasTable,
  usersTable,
  escalationsTable,
  areaProfilesTable,
  areaAssignmentsTable,
} from "@workspace/db";
import { GetSubmissionParams, ListSubmissionsQueryParams } from "@workspace/api-zod";
import { authMiddleware } from "../lib/auth";
import { upload } from "../lib/upload";
import { getCurrentShift, getISTShiftRange, getISTDayRange, getShiftConfig } from "../lib/scoring";
import { loadEffectiveShiftConfig } from "../lib/facility-settings.js";
import {
  scoreSubmission,
  type ScoringOutput,
  AI_UNAVAILABLE_FALLBACK_ACTION,
  isNoOpFallbackSuggestion,
} from "../lib/ai-scoring.js";
import { identifyArea, type IdentificationAreaProfile } from "../lib/ai-identification.js";
import { isVideoFile } from "../lib/keyframes.js";
import { ingestProfileExtract, getOrCreateProfile, TRAINING_THRESHOLD } from "../lib/learning";
import { recordCheck } from "../lib/schedule";
import { dismissNudgesForSubmission } from "./nudges";
import { logger } from "../lib/logger.js";
import { notifyEscalationCreated } from "../lib/notifications.js";
import {
  priorBestWindowMs,
  getEnvOperatorThresholds,
  getDbOperatorThresholds,
  getDbAreaOperatorThresholdsByIds,
  resolveOperatorThresholds,
} from "../lib/operator-thresholds.js";

const ESCALATION_THRESHOLD_PERCENT = (() => {
  const raw = parseInt(process.env.ESCALATION_THRESHOLD_PERCENT ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw;
  return 60;
})();

const router: IRouter = Router();

const submissionSelect = {
  id: submissionsTable.id,
  areaId: submissionsTable.areaId,
  tappedAreaId: submissionsTable.tappedAreaId,
  areaName: areasTable.name,
  userId: submissionsTable.userId,
  userEmail: usersTable.email,
  shift: submissionsTable.shift,
  scoreTotal: submissionsTable.scoreTotal,
  scoreJson: submissionsTable.scoreJson,
  suggestionsJson: submissionsTable.suggestionsJson,
  imageUrl: submissionsTable.imageUrl,
  mediaType: submissionsTable.mediaType,
  keyframesJson: submissionsTable.keyframesJson,
  keyframeMetricsJson: submissionsTable.keyframeMetricsJson,
  machineTag: submissionsTable.machineTag,
  failingPillarsJson: submissionsTable.failingPillarsJson,
  aiTotalScore: submissionsTable.aiTotalScore,
  aiPillarsJson: submissionsTable.aiPillarsJson,
  aiRecommendationsJson: submissionsTable.aiRecommendationsJson,
  aiIssuesJson: submissionsTable.aiIssuesJson,
  aiReasoningJson: submissionsTable.aiReasoningJson,
  scoringMode: submissionsTable.scoringMode,
  modelVersion: submissionsTable.modelVersion,
  embeddingHash: submissionsTable.embeddingHash,
  createdAt: submissionsTable.createdAt,
};

/**
 * Returns the area ids the given operator is allowed to act on:
 *   - `null`  → no assignments configured for this user; treat them as
 *               having access to *all* areas (backward-compatible mode for
 *               sites that haven't filled in the new model yet).
 *   - `[]`    → assignments table has been touched but the operator was
 *               left with zero areas; we honor that as "no access".
 *   - `[…]`   → the explicit set of assigned area ids.
 *
 * Distinguishing "no rows" from "explicit empty set" is impossible with
 * just this table (deletes are physical), so we adopt the documented rule:
 * zero rows == grant all. Managers who want to lock an operator out should
 * either remove the user or give them a sentinel "no-access" area, but the
 * common case (a freshly seeded DB or an operator the manager hasn't
 * configured yet) keeps working.
 */
async function getAssignedAreaIds(userId: number): Promise<number[] | null> {
  const rows = await db
    .select({ areaId: areaAssignmentsTable.areaId })
    .from(areaAssignmentsTable)
    .where(eq(areaAssignmentsTable.userId, userId));
  if (rows.length === 0) return null;
  return rows.map((r) => r.areaId);
}


router.get("/submissions", authMiddleware, async (req, res): Promise<void> => {
  const query = ListSubmissionsQueryParams.safeParse(req.query);
  const conditions = [];
  const cfg = await loadEffectiveShiftConfig();

  if (query.success && query.data.shift) conditions.push(eq(submissionsTable.shift, query.data.shift));
  if (query.success && query.data.areaId) conditions.push(eq(submissionsTable.areaId, query.data.areaId));
  if (query.success && query.data.date) {
    const dateStr = typeof query.data.date === "string" ? query.data.date : query.data.date.toISOString().split("T")[0];
    const { start, end } = getISTDayRange(dateStr, cfg);
    conditions.push(gte(submissionsTable.createdAt, start));
    conditions.push(lt(submissionsTable.createdAt, end));
  }
  if (query.success && query.data.q) {
    const term = `%${query.data.q.trim()}%`;
    if (term !== "%%") {
      const orExpr = or(
        ilike(usersTable.email, term),
        ilike(submissionsTable.machineTag, term),
        ilike(areasTable.name, term),
      );
      if (orExpr) conditions.push(orExpr);
    }
  }
  // scoreTotal is 0–25; percent = total * 4. Filtering on the underlying integer
  // keeps the query indexable and avoids float math in SQL.
  if (query.success && typeof query.data.minScorePercent === "number") {
    const minTotal = Math.ceil(query.data.minScorePercent / 4);
    conditions.push(gte(submissionsTable.scoreTotal, minTotal));
  }
  if (query.success && typeof query.data.maxScorePercent === "number") {
    const maxTotal = Math.floor(query.data.maxScorePercent / 4);
    conditions.push(lt(submissionsTable.scoreTotal, maxTotal + 1));
  }

  const rows = await db
    .select(submissionSelect)
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${submissionsTable.createdAt} DESC`);

  // Annotate each row with its most-recent OPEN/ACKNOWLEDGED escalation id (or
  // null) so the manager UI can offer a single-key resolve from the audit log.
  // Done in one extra query to avoid an N+1 against /escalations per row.
  const submissionIds = rows.map((r) => r.id);
  const openEscByMap = new Map<number, number>();
  if (submissionIds.length > 0) {
    const escRows = await db
      .select({
        id: escalationsTable.id,
        submissionId: escalationsTable.submissionId,
        status: escalationsTable.status,
        createdAt: escalationsTable.createdAt,
      })
      .from(escalationsTable)
      .where(inArray(escalationsTable.submissionId, submissionIds));
    for (const e of escRows) {
      if (e.status === "RESOLVED") continue;
      const prev = openEscByMap.get(e.submissionId);
      if (prev === undefined) {
        openEscByMap.set(e.submissionId, e.id);
      } else {
        openEscByMap.set(e.submissionId, Math.max(prev, e.id));
      }
    }
  }

  res.json(rows.map((r) => ({ ...r, openEscalationId: openEscByMap.get(r.id) ?? null })));
});

const uploadFields = upload.fields([
  { name: "media", maxCount: 1 },
  { name: "photo", maxCount: 1 },
]);

function extractFile(req: any) {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const f = files.media?.[0] ?? files.photo?.[0] ?? req.file;
  return f as Express.Multer.File | undefined;
}

async function runScoringPipeline(opts: {
  areaId: number;
  areaName: string;
  environmentType: string;
  file: Express.Multer.File;
  machineTag: string | null;
}): Promise<{
  scoring: ScoringOutput;
  mediaType: "image" | "video";
  mediaUrl: string;
}> {
  const mediaType: "image" | "video" = isVideoFile(opts.file) ? "video" : "image";
  const mediaUrl = `/uploads/${opts.file.filename}`;
  const absPath = path.resolve(process.cwd(), "uploads", opts.file.filename);

  const profile = await getOrCreateProfile(opts.areaId);
  const learnedProfile = {
    status: profile.status as "LEARNING" | "TRAINED",
    items: (profile.itemsJson as string[]) ?? [],
    machines: (profile.machinesJson as string[]) ?? [],
    layout: (profile.layoutJson as string[]) ?? [],
    commonIssues: (profile.commonIssuesJson as string[]) ?? [],
    summary: profile.summary,
  };

  const envType: "factory" | "warehouse" | "home" | "corporate_office" =
    opts.environmentType === "warehouse" ? "warehouse" :
    opts.environmentType === "home" ? "home" :
    opts.environmentType === "corporate_office" ? "corporate_office" : "factory";

  const scoring = await scoreSubmission({
    areaId: opts.areaId,
    areaName: opts.areaName,
    mediaAbsPath: absPath,
    mediaType,
    machineTag: opts.machineTag,
    environmentType: envType,
    learnedProfile,
  });

  return { scoring, mediaType, mediaUrl };
}

async function maybeCreateEscalation(args: {
  submissionId: number;
  areaId: number;
  areaName: string;
  operatorId: number;
  operatorEmail: string;
  scoreTotal: number;
  scorePercent: number;
  failingPillars: string[];
  recommendedActions: string[];
  evidenceUrls: string[];
}) {
  if (args.scorePercent >= ESCALATION_THRESHOLD_PERCENT) return;

  // Dedupe: if there's already a non-RESOLVED escalation for this submission
  // (e.g. the operator re-uploaded media for the same submission), don't
  // create a second row or fire another notification.
  const [existing] = await db
    .select({ id: escalationsTable.id })
    .from(escalationsTable)
    .where(
      and(
        eq(escalationsTable.submissionId, args.submissionId),
        sql`${escalationsTable.status} <> 'RESOLVED'`,
      ),
    )
    .limit(1);
  if (existing) return;

  const [created] = await db
    .insert(escalationsTable)
    .values({
      submissionId: args.submissionId,
      areaId: args.areaId,
      operatorId: args.operatorId,
      scoreTotal: args.scoreTotal,
      scorePercent: args.scorePercent,
      failingPillarsJson: args.failingPillars,
      recommendedActionsJson: args.recommendedActions,
      evidenceUrlsJson: args.evidenceUrls,
      status: "OPEN",
    })
    .returning({ id: escalationsTable.id });

  // Fire-and-forget so a flaky email/Slack provider can never wedge the
  // submission response. Errors are logged inside notifyEscalationCreated.
  if (created) {
    void notifyEscalationCreated({
      escalationId: created.id,
      submissionId: args.submissionId,
      areaId: args.areaId,
      areaName: args.areaName,
      scorePercent: args.scorePercent,
      failingPillars: args.failingPillars,
      operatorEmail: args.operatorEmail,
      recommendedActions: args.recommendedActions,
    }).catch((err) => logger.error({ err, escalationId: created.id }, "notify: unhandled error"));
  }
}

router.post("/submissions/identify-area", authMiddleware, uploadFields, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const file = extractFile(req);
  if (!file) { res.status(400).json({ error: "Media file is required (use field 'media' or 'photo')" }); return; }

  // Pull every area's profile and keep only those that have completed the
  // learning phase. Identification against a still-LEARNING profile would be
  // mostly noise, and the spec says fall back to manual selection in that
  // case rather than guessing.
  //
  // We further narrow the candidate pool to the calling operator's assigned
  // areas. If the operator has zero assignments, we fall back to all TRAINED
  // areas — that's the backward-compatible "no assignments configured"
  // mode for sites that haven't filled in the new model yet.
  const assignedAreaIds = await getAssignedAreaIds(userId);

  const baseConds = [eq(areaProfilesTable.status, "TRAINED")];
  if (assignedAreaIds !== null) {
    if (assignedAreaIds.length === 0) {
      // Operator has assignments configured but none — surface the empty
      // result instead of leaking everyone else's areas.
      res.json({ candidates: [], hasTrainedAreas: false, rationale: null });
      return;
    }
    baseConds.push(inArray(areasTable.id, assignedAreaIds));
  }

  const rows = await db
    .select({
      areaId: areasTable.id,
      areaName: areasTable.name,
      status: areaProfilesTable.status,
      summary: areaProfilesTable.summary,
      itemsJson: areaProfilesTable.itemsJson,
      machinesJson: areaProfilesTable.machinesJson,
      layoutJson: areaProfilesTable.layoutJson,
    })
    .from(areasTable)
    .innerJoin(areaProfilesTable, eq(areaProfilesTable.areaId, areasTable.id))
    .where(and(...baseConds));

  if (rows.length === 0) {
    res.json({ candidates: [], hasTrainedAreas: false, rationale: null });
    return;
  }

  const profiles: IdentificationAreaProfile[] = rows.map((r) => ({
    areaId: r.areaId,
    areaName: r.areaName,
    summary: r.summary,
    items: Array.isArray(r.itemsJson) ? (r.itemsJson as string[]) : [],
    machines: Array.isArray(r.machinesJson) ? (r.machinesJson as string[]) : [],
    layout: Array.isArray(r.layoutJson) ? (r.layoutJson as string[]) : [],
  }));

  const mediaType: "image" | "video" = isVideoFile(file) ? "video" : "image";
  const absPath = path.resolve(process.cwd(), "uploads", file.filename);

  try {
    const result = await identifyArea({
      mediaAbsPath: absPath,
      mediaType,
      profiles,
    });
    res.json({
      candidates: result.candidates,
      hasTrainedAreas: true,
      rationale: result.rationale,
    });
  } catch (err) {
    logger.error({ err }, "Area identification failed");
    // Surface as an empty-candidates result rather than a 500: the operator
    // flow simply falls back to manual area selection in either case, and
    // returning 200 keeps the UI's non-blocking detection state clean.
    res.json({
      candidates: [],
      hasTrainedAreas: true,
      rationale: null,
    });
  }
});

router.post("/submissions", authMiddleware, uploadFields, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const areaId = parseInt(req.body.areaId, 10);
  if (isNaN(areaId)) { res.status(400).json({ error: "areaId is required", code: "AREA_REQUIRED" }); return; }

  // Operator's *intent*: which area they tapped before any auto-detect/override.
  // Stays NULL when the client doesn't send it (legacy builds) so unknown
  // intent is excluded from the agreement metrics in
  // /dashboard/area-detection-agreement. We deliberately do NOT default to
  // areaId — silently coercing would inflate the agreement rate by treating
  // "we don't know what they tapped" as a match.
  const tappedAreaIdRaw = parseInt(req.body.tappedAreaId, 10);
  const tappedAreaId = Number.isFinite(tappedAreaIdRaw) ? tappedAreaIdRaw : null;

  // Optional: the AI's top auto-detect candidate at the moment of submission.
  // Only used to log corrections for future profile-prompt tuning; not
  // persisted on the submission row.
  const aiSuggestedAreaIdRaw = parseInt(req.body.aiSuggestedAreaId, 10);
  const aiSuggestedAreaId = Number.isFinite(aiSuggestedAreaIdRaw) ? aiSuggestedAreaIdRaw : null;

  const file = extractFile(req);
  if (!file) {
    res.status(400).json({
      error: "Media file is required (use field 'media' or 'photo')",
      code: "MEDIA_REQUIRED",
      hint: "Pick a photo or video before submitting.",
    });
    return;
  }

  const machineTag = (req.body.machineTag as string | undefined)?.trim() || null;
  const bodyShift = req.body.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shiftCfg = await loadEffectiveShiftConfig();
  const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : getCurrentShift(shiftCfg).shift;

  const [area] = await db.select().from(areasTable).where(eq(areasTable.id, areaId));
  if (!area) { res.status(404).json({ error: "Area not found", code: "AREA_NOT_FOUND" }); return; }

  // Enforce assignment scope on writes too. Without this, an operator could
  // bypass the home-grid filter by hitting the endpoint directly with an
  // areaId they aren't supposed to own.
  const assignedAreaIdsForPost = await getAssignedAreaIds(userId);
  if (assignedAreaIdsForPost !== null && !assignedAreaIdsForPost.includes(areaId)) {
    res.status(403).json({ error: "You are not assigned to this area" });
    return;
  }

  let pipeline;
  try {
    pipeline = await runScoringPipeline({ areaId, areaName: area.name, environmentType: area.environmentType, file, machineTag });
  } catch (err) {
    // Pipeline only throws on infrastructure-level problems (e.g. profile load
    // fails); the VLM itself falls back to an empty result instead of
    // throwing. We mark this as SCORING_FAILED so the operator UI knows the
    // upload didn't land — they should retry — and we suggest checking the
    // capture quality, which is the only knob they actually control.
    logger.error({ err }, "Scoring pipeline failed");
    res.status(502).json({
      error: "Failed to score submission",
      code: "SCORING_FAILED",
      hint: "We couldn't analyse this capture. Try again with brighter lighting and a steadier angle.",
      retryable: true,
    });
    return;
  }

  const { scoring, mediaType, mediaUrl } = pipeline;
  const finalScoreTotal = scoring.aiTotalScore;
  const finalScoreJson = scoring.aiPillarsJson;
  const finalSuggestions = scoring.aiRecommendationsJson?.length
    ? scoring.aiRecommendationsJson.map((r) => r.action)
    : [AI_UNAVAILABLE_FALLBACK_ACTION];

  const [submission] = await db
    .insert(submissionsTable)
    .values({
      areaId,
      tappedAreaId,
      userId,
      shift,
      scoreTotal: finalScoreTotal,
      scoreJson: finalScoreJson,
      suggestionsJson: finalSuggestions,
      imageUrl: mediaUrl,
      mediaType,
      keyframesJson: scoring.keyframeUrls.length ? scoring.keyframeUrls : null,
      keyframeMetricsJson: scoring.keyframeMetrics ?? null,
      machineTag,
      failingPillarsJson: scoring.failingPillars,
      embeddingHash: scoring.embeddingHash || null,
      aiTotalScore: scoring.aiTotalScore,
      aiPillarsJson: scoring.aiPillarsJson,
      aiRecommendationsJson: scoring.aiRecommendationsJson,
      aiIssuesJson: scoring.aiIssuesJson,
      aiReasoningJson: scoring.aiReasoningJson,
      modelVersion: scoring.modelVersion,
      scoringMode: scoring.scoringMode,
    })
    .returning();

  // Update learned profile
  try {
    await ingestProfileExtract(areaId, scoring.profile);
  } catch (err) {
    logger.error({ err }, "Failed to ingest profile extract");
  }

  // Drift signals for the area-identification prompt. Two cases worth a
  // structured log so a future profile rebuild (see lib/ai-identification.ts)
  // can mine corrections without scanning every submission row:
  //   - tappedAreaId !== areaId: the chosen area drifted from the operator's
  //     intent (either AI auto-switch or explicit manual change). When the AI
  //     suggested the chosen area, that's an AI-driven override of intent.
  //   - aiSuggestedAreaId is provided AND chosen area !== AI suggestion: the
  //     operator explicitly overrode the AI's top suggestion — the highest
  //     signal correction we can capture.
  if (tappedAreaId !== areaId) {
    logger.info(
      {
        submissionId: submission.id,
        userId,
        tappedAreaId,
        chosenAreaId: areaId,
        aiSuggestedAreaId,
        kind: "area-detection-drift",
      },
      "Submission's chosen area differed from the originally tapped area",
    );
  }
  if (aiSuggestedAreaId != null && aiSuggestedAreaId !== areaId) {
    logger.info(
      {
        submissionId: submission.id,
        userId,
        tappedAreaId,
        chosenAreaId: areaId,
        aiSuggestedAreaId,
        kind: "area-detection-correction",
      },
      "Operator overrode the AI's auto-detected area",
    );
  }

  // Update schedule cadence and last-check time (area baseline + per-machine if tagged)
  try { await recordCheck(areaId, machineTag ?? null, submission.createdAt); } catch (err) { logger.error({ err }, "recordCheck failed"); }

  // Implicitly clear any active manager nudges this submission satisfies so the
  // operator's badge disappears and Live shift no longer flags the area.
  try {
    await dismissNudgesForSubmission({ areaId, shift, machineTag: machineTag ?? null, userId });
  } catch (err) {
    logger.error({ err }, "dismissNudgesForSubmission failed");
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  // Auto-escalate on failure
  const scorePercent = Math.round(finalScoreTotal * 4);
  try {
    await maybeCreateEscalation({
      submissionId: submission.id,
      areaId,
      areaName: area.name,
      operatorId: userId,
      operatorEmail: user?.email ?? "",
      scoreTotal: finalScoreTotal,
      scorePercent,
      failingPillars: scoring.failingPillars,
      recommendedActions: finalSuggestions.slice(0, 5),
      evidenceUrls: scoring.keyframeUrls.length ? scoring.keyframeUrls : [mediaUrl],
    });
  } catch (err) {
    logger.error({ err }, "Failed to create escalation");
  }

  res.status(201).json({
    ...submission,
    areaName: area.name,
    userEmail: user?.email ?? "",
  });
});

router.put("/submissions/:id/reupload", authMiddleware, uploadFields, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid submission id", code: "INVALID_ID" }); return; }

  const [existing] = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }); return; }
  if (existing.userId !== userId) {
    res.status(403).json({
      error: "You can only re-upload your own submissions",
      code: "FORBIDDEN",
    });
    return;
  }

  const file = extractFile(req);
  if (!file) {
    res.status(400).json({
      error: "Media file is required",
      code: "MEDIA_REQUIRED",
      hint: "Pick a photo or video before re-uploading.",
    });
    return;
  }

  const machineTag = (req.body.machineTag as string | undefined)?.trim() || existing.machineTag || null;
  const bodyShift = req.body.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : existing.shift;

  const [area] = await db.select().from(areasTable).where(eq(areasTable.id, existing.areaId));

  let pipeline;
  try {
    pipeline = await runScoringPipeline({ areaId: existing.areaId, areaName: area?.name ?? "Unknown", environmentType: area?.environmentType ?? "factory", file, machineTag });
  } catch (err) {
    // See create handler — same SCORING_FAILED contract so the operator UI
    // can present an actionable retry hint instead of a generic toast.
    logger.error({ err }, "Scoring pipeline failed on reupload");
    res.status(502).json({
      error: "Failed to score submission",
      code: "SCORING_FAILED",
      hint: "We couldn't analyse this capture. Try again with brighter lighting and a steadier angle.",
      retryable: true,
    });
    return;
  }

  const { scoring, mediaType, mediaUrl } = pipeline;
  const finalScoreTotal = scoring.aiTotalScore;
  const finalScoreJson = scoring.aiPillarsJson;
  const finalSuggestions = scoring.aiRecommendationsJson?.length
    ? scoring.aiRecommendationsJson.map((r) => r.action)
    : [AI_UNAVAILABLE_FALLBACK_ACTION];

  const [updated] = await db
    .update(submissionsTable)
    .set({
      imageUrl: mediaUrl,
      mediaType,
      keyframesJson: scoring.keyframeUrls.length ? scoring.keyframeUrls : null,
      keyframeMetricsJson: scoring.keyframeMetrics ?? null,
      machineTag,
      shift,
      scoreTotal: finalScoreTotal,
      scoreJson: finalScoreJson,
      suggestionsJson: finalSuggestions,
      failingPillarsJson: scoring.failingPillars,
      embeddingHash: scoring.embeddingHash || null,
      aiTotalScore: scoring.aiTotalScore,
      aiPillarsJson: scoring.aiPillarsJson,
      aiRecommendationsJson: scoring.aiRecommendationsJson,
      aiIssuesJson: scoring.aiIssuesJson,
      aiReasoningJson: scoring.aiReasoningJson,
      modelVersion: scoring.modelVersion,
      scoringMode: scoring.scoringMode,
    })
    .where(eq(submissionsTable.id, id))
    .returning();

  try { await ingestProfileExtract(existing.areaId, scoring.profile); } catch (err) { logger.error({ err }, "ingest profile failed"); }
  try { await recordCheck(existing.areaId, machineTag ?? null, new Date()); } catch (err) { logger.error({ err }, "recordCheck failed"); }

  // Re-uploads also satisfy the manager's nudge for the same area+machine+shift.
  try {
    await dismissNudgesForSubmission({
      areaId: existing.areaId,
      shift,
      machineTag: machineTag ?? null,
      userId,
    });
  } catch (err) {
    logger.error({ err }, "dismissNudgesForSubmission failed on reupload");
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  const scorePercent = Math.round(finalScoreTotal * 4);
  try {
    await maybeCreateEscalation({
      submissionId: id,
      areaId: existing.areaId,
      areaName: area?.name ?? "",
      operatorId: userId,
      operatorEmail: user?.email ?? "",
      scoreTotal: finalScoreTotal,
      scorePercent,
      failingPillars: scoring.failingPillars,
      recommendedActions: finalSuggestions.slice(0, 5),
      evidenceUrls: scoring.keyframeUrls.length ? scoring.keyframeUrls : [mediaUrl],
    });
  } catch (err) {
    logger.error({ err }, "Failed to create escalation on reupload");
  }

  res.json({
    ...updated,
    areaName: area?.name ?? "",
    userEmail: user?.email ?? "",
  });
});

router.get("/submissions/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = GetSubmissionParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const [row] = await db
    .select(submissionSelect)
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(eq(submissionsTable.id, params.data.id));

  if (!row) { res.status(404).json({ error: "Submission not found" }); return; }
  res.json(row);
});

router.get("/shift/current", authMiddleware, async (_req, res): Promise<void> => {
  const cfg = await loadEffectiveShiftConfig();
  res.json(getCurrentShift(cfg));
});

// Exposes the facility's configured shift timezone + start hours so the UI can
// stop hardcoding "IST" / "Asia/Kolkata" in shift labels, clocks, and
// quiet-hours copy. Callers cache this; it changes only on server restart.
router.get("/shift/config", authMiddleware, async (_req, res): Promise<void> => {
  const cfg = getShiftConfig();
  res.json({ timeZone: cfg.timeZone, startHours: cfg.startHours });
});

router.get("/operator/recent", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 50 ? rawLimit : 12;

  // Pull a wide window so we can compute prevScoreTotal and bestScoreInLastWeek
  // without an extra round-trip per area. The strip itself only renders `limit`.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Resolve the prior-best window per AREA so admin-tuned per-area overrides
  // (env > area-DB > global-DB > default) take effect on the next call
  // without a redeploy. We do this once with bulk fetches and then resolve
  // per row using the cached layers — this is `O(unique areas + 1)` queries
  // instead of one per row.
  const env = getEnvOperatorThresholds();
  const globalRow = await getDbOperatorThresholds();

  const rows = await db
    .select({
      id: submissionsTable.id,
      areaId: submissionsTable.areaId,
      areaName: areasTable.name,
      shift: submissionsTable.shift,
      scoreTotal: submissionsTable.scoreTotal,
      mediaType: submissionsTable.mediaType,
      machineTag: submissionsTable.machineTag,
      createdAt: submissionsTable.createdAt,
      suggestionsJson: submissionsTable.suggestionsJson,
      // scoringMode lets the recent strip distinguish a real 0% audit from
      // one where the AI couldn't grade the upload at all (FALLBACK). The
      // toast on submit already calls this out, but operators who navigate
      // away or miss the toast otherwise see the saved row as a real "0%".
      scoringMode: submissionsTable.scoringMode,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .where(
      and(
        eq(submissionsTable.userId, userId),
        gte(submissionsTable.createdAt, since)
      )
    )
    .orderBy(sql`${submissionsTable.createdAt} DESC`);

  // Fetch per-area DB overrides for every area touched by the result set in
  // one round trip, then resolve the effective window per area. The map can
  // be empty (no area overrides → every area falls through to global/env/
  // default), which is the common case.
  const uniqueAreaIds = Array.from(new Set(rows.map((r) => r.areaId)));
  const areaOverrides = await getDbAreaOperatorThresholdsByIds(uniqueAreaIds);
  const windowMsByAreaId = new Map<number, number>();
  for (const areaId of uniqueAreaIds) {
    const resolved = resolveOperatorThresholds({
      env,
      areaOverride: areaOverrides.get(areaId) ?? null,
      globalOverride: globalRow,
    });
    windowMsByAreaId.set(areaId, priorBestWindowMs(resolved));
  }

  // For each submission, find the operator's prior submission for the same area
  // (any time before this one) and the operator's best score for the area in
  // the prior-best window strictly preceding this submission's timestamp
  // (excluding the row itself). Anchoring to each row's own timestamp keeps the
  // encouragement chip accurate for older cards too.
  const result = rows.slice(0, limit).map((row) => {
    const rowTime = new Date(row.createdAt).getTime();
    const sameAreaPrior = rows.filter(
      (r) => r.areaId === row.areaId && r.id !== row.id && new Date(r.createdAt).getTime() < rowTime
    );
    const prior = sameAreaPrior[0]; // rows are DESC, so first match is the most recent prior
    const windowMs =
      windowMsByAreaId.get(row.areaId) ?? priorBestWindowMs({
        encouragementMinPercent: 0,
        priorBestWindowDays: 7,
        dueSoonThresholdMinutes: 0,
      });
    const priorWeek = sameAreaPrior.filter((r) => new Date(r.createdAt).getTime() >= rowTime - windowMs);
    const best = priorWeek.length > 0
      ? priorWeek.reduce((m, r) => (r.scoreTotal > m ? r.scoreTotal : m), -Infinity)
      : null;
    // Surface the first ≤2 action labels inline on the recent-audits strip so
    // the operator can prioritize re-captures without opening the detail
    // dialog. suggestionsJson is jsonb-typed and may legitimately be empty.
    //
    // We deliberately skip known no-op fallbacks (e.g. the
    // "AI scoring unavailable" message that gets written when scoring fails)
    // because they aren't actionable for the operator and would otherwise
    // crowd out a real re-capture decision. The full detail dialog still
    // shows every suggestion, including the fallback, so scoring status is
    // not lost — just hidden from the inline chips.
    const rawSuggestions = Array.isArray(row.suggestionsJson)
      ? (row.suggestionsJson as unknown[])
      : [];
    const topActions: string[] = [];
    for (const s of rawSuggestions) {
      if (typeof s !== "string") continue;
      const trimmed = s.trim();
      if (!trimmed) continue;
      if (isNoOpFallbackSuggestion(trimmed)) continue;
      topActions.push(trimmed);
      if (topActions.length === 2) break;
    }
    const { suggestionsJson: _omit, ...rest } = row;
    return {
      ...rest,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      prevScoreTotal: prior ? prior.scoreTotal : null,
      bestScoreInLastWeek: best === -Infinity || best === null ? null : best,
      topActions,
    };
  });

  res.json(result);
});

router.get("/operator/status", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const queryShift = req.query.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const cfg = await loadEffectiveShiftConfig();
  const shift = queryShift && validShifts.includes(queryShift) ? queryShift : getCurrentShift(cfg).shift;

  // Use the configured shift timezone so the per-shift area list aligns
  // with the clock the operator sees.
  const { start, end } = getISTShiftRange(undefined, shift, cfg);

  // Scope the home grid to the operator's assigned areas. `null` means the
  // operator has no assignments configured at all → fall back to listing
  // everything (backward-compatible behavior). The auto-detect skip rule on
  // the client is keyed off `assignedAreas.length > 1`, so once we narrow
  // the response here it naturally turns into "only run identification when
  // the operator owns more than one area".
  const assignedAreaIds = await getAssignedAreaIds(userId);
  const areas = assignedAreaIds === null
    ? await db.select().from(areasTable).orderBy(areasTable.id)
    : assignedAreaIds.length === 0
      ? []
      : await db
          .select()
          .from(areasTable)
          .where(inArray(areasTable.id, assignedAreaIds))
          .orderBy(areasTable.id);

  const submissions = await db
    .select(submissionSelect)
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(
      and(
        eq(submissionsTable.userId, userId),
        eq(submissionsTable.shift, shift),
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end)
      )
    );

  const result = areas.map((area) => {
    const sub = submissions.find((s) => s.areaId === area.id);
    return {
      areaId: area.id,
      areaName: area.name,
      environmentType: area.environmentType,
      // Surfaced so the capture sheet can render the manager's per-area
      // override of the walk-through bullets when one is set, falling back
      // to the static environmentType default otherwise.
      walkthroughHintsOverride: area.walkthroughHintsOverrideJson ?? null,
      submitted: !!sub,
      ...(sub ? { submission: sub } : {}),
    };
  });

  res.json(result);
});

// Note: profile/learning is exposed under /areas/:id/profile (see profiles route).
export { TRAINING_THRESHOLD };

export default router;
