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
} from "@workspace/db";
import { GetSubmissionParams, ListSubmissionsQueryParams } from "@workspace/api-zod";
import { authMiddleware } from "../lib/auth";
import { upload } from "../lib/upload";
import { getCurrentShift, getISTShiftRange } from "../lib/scoring";
import { scoreSubmission, type ScoringOutput } from "../lib/ai-scoring.js";
import { isVideoFile } from "../lib/keyframes.js";
import { ingestProfileExtract, getOrCreateProfile, TRAINING_THRESHOLD } from "../lib/learning";
import { recordCheck } from "../lib/schedule";
import { logger } from "../lib/logger.js";
import { notifyEscalationCreated } from "../lib/notifications.js";

const ESCALATION_THRESHOLD_PERCENT = (() => {
  const raw = parseInt(process.env.ESCALATION_THRESHOLD_PERCENT ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return raw;
  return 60;
})();

const router: IRouter = Router();

const submissionSelect = {
  id: submissionsTable.id,
  areaId: submissionsTable.areaId,
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
  machineTag: submissionsTable.machineTag,
  failingPillarsJson: submissionsTable.failingPillarsJson,
  aiTotalScore: submissionsTable.aiTotalScore,
  aiPillarsJson: submissionsTable.aiPillarsJson,
  aiRecommendationsJson: submissionsTable.aiRecommendationsJson,
  aiIssuesJson: submissionsTable.aiIssuesJson,
  scoringMode: submissionsTable.scoringMode,
  modelVersion: submissionsTable.modelVersion,
  embeddingHash: submissionsTable.embeddingHash,
  createdAt: submissionsTable.createdAt,
};

function getShiftDateRange(dateStr?: string | Date, shift?: string) {
  const date = !dateStr ? new Date() : (dateStr instanceof Date ? dateStr : new Date(dateStr + "T00:00:00"));
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  if (shift === "A") return { start: new Date(y, m, d, 6, 0, 0), end: new Date(y, m, d, 14, 0, 0) };
  if (shift === "B") return { start: new Date(y, m, d, 14, 0, 0), end: new Date(y, m, d, 22, 0, 0) };
  if (shift === "C") return { start: new Date(y, m, d, 22, 0, 0), end: new Date(y, m, d + 1, 6, 0, 0) };
  return { start: new Date(y, m, d, 0, 0, 0), end: new Date(y, m, d + 1, 0, 0, 0) };
}

router.get("/submissions", authMiddleware, async (req, res): Promise<void> => {
  const query = ListSubmissionsQueryParams.safeParse(req.query);
  const conditions = [];
  if (query.success && query.data.shift) conditions.push(eq(submissionsTable.shift, query.data.shift));
  if (query.success && query.data.areaId) conditions.push(eq(submissionsTable.areaId, query.data.areaId));
  if (query.success && query.data.date) {
    const { start, end } = getShiftDateRange(query.data.date);
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

  const scoring = await scoreSubmission({
    areaId: opts.areaId,
    areaName: opts.areaName,
    mediaAbsPath: absPath,
    mediaType,
    machineTag: opts.machineTag,
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
      areaName: args.areaName,
      scorePercent: args.scorePercent,
      failingPillars: args.failingPillars,
      operatorEmail: args.operatorEmail,
      recommendedActions: args.recommendedActions,
    }).catch((err) => logger.error({ err, escalationId: created.id }, "notify: unhandled error"));
  }
}

router.post("/submissions", authMiddleware, uploadFields, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const areaId = parseInt(req.body.areaId, 10);
  if (isNaN(areaId)) { res.status(400).json({ error: "areaId is required" }); return; }

  const file = extractFile(req);
  if (!file) { res.status(400).json({ error: "Media file is required (use field 'media' or 'photo')" }); return; }

  const machineTag = (req.body.machineTag as string | undefined)?.trim() || null;
  const bodyShift = req.body.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : getCurrentShift().shift;

  const [area] = await db.select().from(areasTable).where(eq(areasTable.id, areaId));
  if (!area) { res.status(404).json({ error: "Area not found" }); return; }

  let pipeline;
  try {
    pipeline = await runScoringPipeline({ areaId, areaName: area.name, file, machineTag });
  } catch (err) {
    logger.error({ err }, "Scoring pipeline failed");
    res.status(500).json({ error: "Failed to score submission" });
    return;
  }

  const { scoring, mediaType, mediaUrl } = pipeline;
  const finalScoreTotal = scoring.aiTotalScore;
  const finalScoreJson = scoring.aiPillarsJson;
  const finalSuggestions = scoring.aiRecommendationsJson?.length
    ? scoring.aiRecommendationsJson.map((r) => r.action)
    : ["Manual inspection required — AI scoring unavailable"];

  const [submission] = await db
    .insert(submissionsTable)
    .values({
      areaId,
      userId,
      shift,
      scoreTotal: finalScoreTotal,
      scoreJson: finalScoreJson,
      suggestionsJson: finalSuggestions,
      imageUrl: mediaUrl,
      mediaType,
      keyframesJson: scoring.keyframeUrls.length ? scoring.keyframeUrls : null,
      machineTag,
      failingPillarsJson: scoring.failingPillars,
      embeddingHash: scoring.embeddingHash || null,
      aiTotalScore: scoring.aiTotalScore,
      aiPillarsJson: scoring.aiPillarsJson,
      aiRecommendationsJson: scoring.aiRecommendationsJson,
      aiIssuesJson: scoring.aiIssuesJson,
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

  // Update schedule cadence and last-check time (area baseline + per-machine if tagged)
  try { await recordCheck(areaId, machineTag ?? null, submission.createdAt); } catch (err) { logger.error({ err }, "recordCheck failed"); }

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
  if (isNaN(id)) { res.status(400).json({ error: "Invalid submission id" }); return; }

  const [existing] = await db.select().from(submissionsTable).where(eq(submissionsTable.id, id));
  if (!existing) { res.status(404).json({ error: "Submission not found" }); return; }
  if (existing.userId !== userId) { res.status(403).json({ error: "You can only re-upload your own submissions" }); return; }

  const file = extractFile(req);
  if (!file) { res.status(400).json({ error: "Media file is required" }); return; }

  const machineTag = (req.body.machineTag as string | undefined)?.trim() || existing.machineTag || null;
  const bodyShift = req.body.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : existing.shift;

  const [area] = await db.select().from(areasTable).where(eq(areasTable.id, existing.areaId));

  let pipeline;
  try {
    pipeline = await runScoringPipeline({ areaId: existing.areaId, areaName: area?.name ?? "Unknown", file, machineTag });
  } catch (err) {
    logger.error({ err }, "Scoring pipeline failed on reupload");
    res.status(500).json({ error: "Failed to score submission" });
    return;
  }

  const { scoring, mediaType, mediaUrl } = pipeline;
  const finalScoreTotal = scoring.aiTotalScore;
  const finalScoreJson = scoring.aiPillarsJson;
  const finalSuggestions = scoring.aiRecommendationsJson?.length
    ? scoring.aiRecommendationsJson.map((r) => r.action)
    : ["Manual inspection required — AI scoring unavailable"];

  const [updated] = await db
    .update(submissionsTable)
    .set({
      imageUrl: mediaUrl,
      mediaType,
      keyframesJson: scoring.keyframeUrls.length ? scoring.keyframeUrls : null,
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
      modelVersion: scoring.modelVersion,
      scoringMode: scoring.scoringMode,
    })
    .where(eq(submissionsTable.id, id))
    .returning();

  try { await ingestProfileExtract(existing.areaId, scoring.profile); } catch (err) { logger.error({ err }, "ingest profile failed"); }
  try { await recordCheck(existing.areaId, machineTag ?? null, new Date()); } catch (err) { logger.error({ err }, "recordCheck failed"); }

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
  res.json(getCurrentShift());
});

router.get("/operator/recent", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 50 ? rawLimit : 12;

  // Pull a wide window so we can compute prevScoreTotal and bestScoreInLastWeek
  // without an extra round-trip per area. The strip itself only renders `limit`.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

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

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // For each submission, find the operator's prior submission for the same area
  // (any time before this one) and the operator's best score for the area in the
  // 7 days strictly preceding this submission's timestamp (excluding the row
  // itself). Anchoring to each row's own timestamp keeps the encouragement chip
  // accurate for older cards too.
  const result = rows.slice(0, limit).map((row) => {
    const rowTime = new Date(row.createdAt).getTime();
    const sameAreaPrior = rows.filter(
      (r) => r.areaId === row.areaId && r.id !== row.id && new Date(r.createdAt).getTime() < rowTime
    );
    const prior = sameAreaPrior[0]; // rows are DESC, so first match is the most recent prior
    const priorWeek = sameAreaPrior.filter((r) => new Date(r.createdAt).getTime() >= rowTime - WEEK_MS);
    const best = priorWeek.length > 0
      ? priorWeek.reduce((m, r) => (r.scoreTotal > m ? r.scoreTotal : m), -Infinity)
      : null;
    return {
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      prevScoreTotal: prior ? prior.scoreTotal : null,
      bestScoreInLastWeek: best === -Infinity || best === null ? null : best,
    };
  });

  res.json(result);
});

router.get("/operator/status", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const queryShift = req.query.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shift = queryShift && validShifts.includes(queryShift) ? queryShift : getCurrentShift().shift;

  // Use IST so the per-shift area list aligns with the IST clock the operator sees.
  const { start, end } = getISTShiftRange(undefined, shift);

  const areas = await db.select().from(areasTable).orderBy(areasTable.id);

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
      submitted: !!sub,
      ...(sub ? { submission: sub } : {}),
    };
  });

  res.json(result);
});

// Note: profile/learning is exposed under /areas/:id/profile (see profiles route).
export { TRAINING_THRESHOLD };

export default router;
