import { Router, type IRouter } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import {
  db,
  labelsTable,
  submissionsTable,
  areaProfilesTable,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { TRAINING_THRESHOLD } from "../lib/learning";

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

  if (!submission) { res.status(404).json({ error: "Submission not found" }); return; }

  const existing = await db
    .select()
    .from(labelsTable)
    .where(and(eq(labelsTable.submissionId, submissionId), eq(labelsTable.labeledByUserId, userId)));

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
    .values({ submissionId, labeledByUserId: userId, pillarsJson, totalScore })
    .returning();

  res.status(201).json(label);
});

router.get("/labels/:submissionId", authMiddleware, async (req, res): Promise<void> => {
  const submissionId = parseInt(String(req.params.submissionId), 10);
  if (isNaN(submissionId)) { res.status(400).json({ error: "Invalid submission ID" }); return; }

  const labels = await db
    .select()
    .from(labelsTable)
    .where(eq(labelsTable.submissionId, submissionId));

  res.json(labels);
});

router.get("/areas/:id/model-status", authMiddleware, async (req, res): Promise<void> => {
  const areaId = parseInt(String(req.params.id), 10);
  if (isNaN(areaId)) { res.status(400).json({ error: "Invalid area ID" }); return; }

  const [labelCount] = await db
    .select({ count: count() })
    .from(labelsTable)
    .innerJoin(submissionsTable, eq(labelsTable.submissionId, submissionsTable.id))
    .where(eq(submissionsTable.areaId, areaId));

  const [profile] = await db
    .select()
    .from(areaProfilesTable)
    .where(eq(areaProfilesTable.areaId, areaId));

  const submissionsCount = profile?.submissionsCount ?? 0;
  const status = (profile?.status as "LEARNING" | "TRAINED" | undefined) ?? "LEARNING";

  const latest = await db
    .select({ scoringMode: submissionsTable.scoringMode, modelVersion: submissionsTable.modelVersion })
    .from(submissionsTable)
    .where(eq(submissionsTable.areaId, areaId))
    .orderBy(sql`${submissionsTable.createdAt} DESC`)
    .limit(1);

  res.json({
    areaId,
    labelsCount: labelCount?.count ?? 0,
    submissionsCount,
    learningStatus: status,
    targetSubmissions: TRAINING_THRESHOLD,
    canTrain: submissionsCount >= TRAINING_THRESHOLD,
    latestScoringMode: latest[0]?.scoringMode ?? null,
    latestModelVersion: latest[0]?.modelVersion ?? null,
  });
});

export default router;
