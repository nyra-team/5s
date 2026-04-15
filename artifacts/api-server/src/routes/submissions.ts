import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { db, submissionsTable, areasTable, usersTable } from "@workspace/db";
import { GetSubmissionParams, ListSubmissionsQueryParams } from "@workspace/api-zod";
import { authMiddleware } from "../lib/auth";
import { upload } from "../lib/upload";
import { getCurrentShift } from "../lib/scoring";
import { scoreSubmission, type AIScoringResult } from "../lib/ai-scoring.js";
import { logger } from "../lib/logger.js";

const CONSERVATIVE_DEFAULT: AIScoringResult = {
  embeddingHash: "",
  similarityToIdeal: 0,
  aiTotalScore: 0,
  aiPillarsJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
  aiRecommendationsJson: [{ action: "Manual inspection required — AI scoring unavailable", why: "AI pipeline error", location: "general" }],
  aiIssuesJson: [{ issue: "AI scoring unavailable", evidence: "Pipeline error", location: "general" }],
  modelVersion: "error",
  scoringMode: "FALLBACK",
};

const router: IRouter = Router();

function getShiftDateRange(dateStr?: string, shift?: string) {
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  if (shift === "A") {
    return {
      start: new Date(y, m, d, 6, 0, 0),
      end: new Date(y, m, d, 14, 0, 0),
    };
  } else if (shift === "B") {
    return {
      start: new Date(y, m, d, 14, 0, 0),
      end: new Date(y, m, d, 22, 0, 0),
    };
  } else if (shift === "C") {
    return {
      start: new Date(y, m, d, 22, 0, 0),
      end: new Date(y, m, d + 1, 6, 0, 0),
    };
  }
  return {
    start: new Date(y, m, d, 0, 0, 0),
    end: new Date(y, m, d + 1, 0, 0, 0),
  };
}

router.get("/submissions", authMiddleware, async (req, res): Promise<void> => {
  const query = ListSubmissionsQueryParams.safeParse(req.query);

  const conditions = [];
  if (query.success && query.data.shift) {
    conditions.push(eq(submissionsTable.shift, query.data.shift));
  }
  if (query.success && query.data.areaId) {
    conditions.push(eq(submissionsTable.areaId, query.data.areaId));
  }
  if (query.success && query.data.date) {
    const { start, end } = getShiftDateRange(query.data.date);
    conditions.push(gte(submissionsTable.createdAt, start));
    conditions.push(lt(submissionsTable.createdAt, end));
  }

  const rows = await db
    .select({
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
      similarityToIdeal: submissionsTable.similarityToIdeal,
      aiTotalScore: submissionsTable.aiTotalScore,
      aiPillarsJson: submissionsTable.aiPillarsJson,
      aiRecommendationsJson: submissionsTable.aiRecommendationsJson,
      aiIssuesJson: submissionsTable.aiIssuesJson,
      scoringMode: submissionsTable.scoringMode,
      modelVersion: submissionsTable.modelVersion,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${submissionsTable.createdAt} DESC`);

  res.json(rows);
});

router.post(
  "/submissions",
  authMiddleware,
  upload.single("photo"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user;
    const areaId = parseInt(req.body.areaId, 10);

    if (isNaN(areaId)) {
      res.status(400).json({ error: "areaId is required" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Photo is required" });
      return;
    }

    const bodyShift = req.body.shift as string | undefined;
    const validShifts = ["A", "B", "C"];
    const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : getCurrentShift().shift;
    const imageUrl = `/uploads/${file.filename}`;

    const [area] = await db
      .select()
      .from(areasTable)
      .where(eq(areasTable.id, areaId));

    let aiResult;
    try {
      aiResult = await scoreSubmission(imageUrl, areaId, area?.name ?? "Unknown");
    } catch (err) {
      logger.error({ err }, "AI scoring failed entirely, using conservative defaults");
    }

    const result = aiResult ?? CONSERVATIVE_DEFAULT;
    const finalScoreTotal = result.aiTotalScore;
    const finalScoreJson = result.aiPillarsJson;
    const finalSuggestions = result.aiRecommendationsJson?.length
      ? result.aiRecommendationsJson.map((r) => r.action)
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
        imageUrl,
        embeddingHash: result.embeddingHash || null,
        similarityToIdeal: result.similarityToIdeal ?? null,
        aiTotalScore: result.aiTotalScore ?? null,
        aiPillarsJson: result.aiPillarsJson ?? null,
        aiRecommendationsJson: result.aiRecommendationsJson ?? null,
        aiIssuesJson: result.aiIssuesJson ?? null,
        modelVersion: result.modelVersion ?? null,
        scoringMode: result.scoringMode ?? null,
      })
      .returning();

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    res.status(201).json({
      ...submission,
      areaName: area?.name ?? "",
      userEmail: user?.email ?? "",
    });
  }
);

router.put(
  "/submissions/:id/reupload",
  authMiddleware,
  upload.single("photo"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user;
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }

    const [existing] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, id));

    if (!existing) {
      res.status(404).json({ error: "Submission not found" });
      return;
    }

    if (existing.userId !== userId) {
      res.status(403).json({ error: "You can only re-upload your own submissions" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Photo is required" });
      return;
    }

    const imageUrl = `/uploads/${file.filename}`;

    const bodyShift = req.body.shift as string | undefined;
    const validShifts = ["A", "B", "C"];
    const shift = bodyShift && validShifts.includes(bodyShift) ? bodyShift : existing.shift;

    const [area] = await db
      .select()
      .from(areasTable)
      .where(eq(areasTable.id, existing.areaId));

    let aiResult;
    try {
      aiResult = await scoreSubmission(imageUrl, existing.areaId, area?.name ?? "Unknown");
    } catch (err) {
      logger.error({ err }, "AI scoring failed on reupload, using conservative defaults");
    }

    const result = aiResult ?? CONSERVATIVE_DEFAULT;
    const finalScoreTotal = result.aiTotalScore;
    const finalScoreJson = result.aiPillarsJson;
    const finalSuggestions = result.aiRecommendationsJson?.length
      ? result.aiRecommendationsJson.map((r) => r.action)
      : ["Manual inspection required — AI scoring unavailable"];

    const [updated] = await db
      .update(submissionsTable)
      .set({
        imageUrl,
        shift,
        scoreTotal: finalScoreTotal,
        scoreJson: finalScoreJson,
        suggestionsJson: finalSuggestions,
        embeddingHash: result.embeddingHash || null,
        similarityToIdeal: result.similarityToIdeal ?? null,
        aiTotalScore: result.aiTotalScore ?? null,
        aiPillarsJson: result.aiPillarsJson ?? null,
        aiRecommendationsJson: result.aiRecommendationsJson ?? null,
        aiIssuesJson: result.aiIssuesJson ?? null,
        modelVersion: result.modelVersion ?? null,
        scoringMode: result.scoringMode ?? null,
      })
      .where(eq(submissionsTable.id, id))
      .returning();

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    res.json({
      ...updated,
      areaName: area?.name ?? "",
      userEmail: user?.email ?? "",
    });
  }
);

router.get("/submissions/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = GetSubmissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
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
      similarityToIdeal: submissionsTable.similarityToIdeal,
      aiTotalScore: submissionsTable.aiTotalScore,
      aiPillarsJson: submissionsTable.aiPillarsJson,
      aiRecommendationsJson: submissionsTable.aiRecommendationsJson,
      aiIssuesJson: submissionsTable.aiIssuesJson,
      scoringMode: submissionsTable.scoringMode,
      modelVersion: submissionsTable.modelVersion,
      embeddingHash: submissionsTable.embeddingHash,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(eq(submissionsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  res.json(row);
});

router.get("/shift/current", authMiddleware, async (_req, res): Promise<void> => {
  res.json(getCurrentShift());
});

router.get("/operator/status", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const queryShift = req.query.shift as string | undefined;
  const validShifts = ["A", "B", "C"];
  const shift = queryShift && validShifts.includes(queryShift) ? queryShift : getCurrentShift().shift;

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  let start: Date, end: Date;
  if (shift === "A") {
    start = new Date(y, m, d, 6, 0, 0);
    end = new Date(y, m, d, 14, 0, 0);
  } else if (shift === "B") {
    start = new Date(y, m, d, 14, 0, 0);
    end = new Date(y, m, d, 22, 0, 0);
  } else {
    if (now.getHours() < 6) {
      start = new Date(y, m, d - 1, 22, 0, 0);
      end = new Date(y, m, d, 6, 0, 0);
    } else {
      start = new Date(y, m, d, 22, 0, 0);
      end = new Date(y, m, d + 1, 6, 0, 0);
    }
  }

  const areas = await db.select().from(areasTable).orderBy(areasTable.id);

  const submissions = await db
    .select({
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
      createdAt: submissionsTable.createdAt,
    })
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

export default router;
