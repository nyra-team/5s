import { Router, type IRouter } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import {
  db,
  labelsTable,
  submissionsTable,
  areasTable,
  idealPhotosTable,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { trainAreaModel } from "../lib/ai-scoring.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.post("/labels", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const { submissionId, pillarsJson, totalScore } = req.body;
  const { userId } = (req as any).user;

  if (!submissionId || !pillarsJson || totalScore === undefined) {
    res.status(400).json({ error: "submissionId, pillarsJson, and totalScore are required" });
    return;
  }

  const requiredPillars = ["sort", "set", "shine", "standardize", "sustain"];
  for (const p of requiredPillars) {
    if (typeof pillarsJson[p] !== "number" || pillarsJson[p] < 0 || pillarsJson[p] > 5) {
      res.status(400).json({ error: `Invalid pillar score for ${p}: must be 0-5` });
      return;
    }
  }

  const [submission] = await db
    .select()
    .from(submissionsTable)
    .where(eq(submissionsTable.id, submissionId));

  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const existing = await db
    .select()
    .from(labelsTable)
    .where(
      and(
        eq(labelsTable.submissionId, submissionId),
        eq(labelsTable.labeledByUserId, userId)
      )
    );

  if (existing.length > 0) {
    const [updated] = await db
      .update(labelsTable)
      .set({ pillarsJson, totalScore })
      .where(eq(labelsTable.id, existing[0].id))
      .returning();
    res.json(updated);
    return;
  }

  const [label] = await db
    .insert(labelsTable)
    .values({
      submissionId,
      labeledByUserId: userId,
      pillarsJson,
      totalScore,
    })
    .returning();

  res.status(201).json(label);
});

router.get("/labels/:submissionId", authMiddleware, async (req, res): Promise<void> => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (isNaN(submissionId)) {
    res.status(400).json({ error: "Invalid submission ID" });
    return;
  }

  const labels = await db
    .select()
    .from(labelsTable)
    .where(eq(labelsTable.submissionId, submissionId));

  res.json(labels);
});

router.post(
  "/areas/:id/train",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const areaId = parseInt(req.params.id, 10);
    if (isNaN(areaId)) {
      res.status(400).json({ error: "Invalid area ID" });
      return;
    }

    const labeledSubmissions = await db
      .select({
        embeddingHash: submissionsTable.embeddingHash,
        pillarsJson: labelsTable.pillarsJson,
        totalScore: labelsTable.totalScore,
      })
      .from(labelsTable)
      .innerJoin(submissionsTable, eq(labelsTable.submissionId, submissionsTable.id))
      .where(
        and(
          eq(submissionsTable.areaId, areaId),
          sql`${submissionsTable.embeddingHash} IS NOT NULL`
        )
      );

    if (labeledSubmissions.length < 5) {
      res.status(400).json({
        error: `Need at least 5 labeled submissions with embeddings to train. Currently have ${labeledSubmissions.length}.`,
      });
      return;
    }

    res.status(501).json({
      error: "Training requires embedding vectors stored server-side. Use the ML service directly for now.",
      labelsCount: labeledSubmissions.length,
    });
  }
);

router.get(
  "/areas/:id/model-status",
  authMiddleware,
  async (req, res): Promise<void> => {
    const areaId = parseInt(req.params.id, 10);
    if (isNaN(areaId)) {
      res.status(400).json({ error: "Invalid area ID" });
      return;
    }

    const [labelCount] = await db
      .select({ count: count() })
      .from(labelsTable)
      .innerJoin(submissionsTable, eq(labelsTable.submissionId, submissionsTable.id))
      .where(eq(submissionsTable.areaId, areaId));

    const [idealCount] = await db
      .select({ count: count() })
      .from(idealPhotosTable)
      .where(eq(idealPhotosTable.areaId, areaId));

    const [submissionCount] = await db
      .select({ count: count() })
      .from(submissionsTable)
      .where(eq(submissionsTable.areaId, areaId));

    const latestScoringMode = await db
      .select({ scoringMode: submissionsTable.scoringMode, modelVersion: submissionsTable.modelVersion })
      .from(submissionsTable)
      .where(eq(submissionsTable.areaId, areaId))
      .orderBy(sql`${submissionsTable.createdAt} DESC`)
      .limit(1);

    res.json({
      areaId,
      labelsCount: labelCount?.count ?? 0,
      idealPhotosCount: idealCount?.count ?? 0,
      submissionsCount: submissionCount?.count ?? 0,
      canTrain: (labelCount?.count ?? 0) >= 5,
      latestScoringMode: latestScoringMode[0]?.scoringMode ?? null,
      latestModelVersion: latestScoringMode[0]?.modelVersion ?? null,
    });
  }
);

export default router;
