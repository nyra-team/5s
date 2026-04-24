import { Router, type IRouter } from "express";
import { and, eq, gte, lt, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  areasTable,
  submissionsTable,
  escalationsTable,
  usersTable,
  areaSchedulesTable,
  areaProfilesTable,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  getCurrentShift,
  getISTShiftRange,
  getISTParts,
  getTodayDateString,
} from "../lib/scoring";
import {
  getLatestActiveNudgeByArea,
  getLatestActiveNudgesByAreaMachine,
} from "./nudges";

const router: IRouter = Router();

const LOW_SCORE_PERCENT = 60;

const AREA_BASELINE_KEY = "";

router.get("/shift/live", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const { shift } = getCurrentShift();
  // For shift "C" before 6 AM IST, getISTShiftRange anchors to "yesterday 22:00 IST → today 06:00 IST".
  const { start, end } = getISTShiftRange(undefined, shift);
  const date = getTodayDateString();
  // For shift C straddling midnight, label by the IST day the shift began.
  const shiftDate = shift === "C" && getISTParts().hour < 6
    ? new Date(start.getTime() + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10)
    : date;

  // Pending areas: areas that have NOT received any submission this shift.
  const submittedThisShift = await db
    .selectDistinct({ areaId: submissionsTable.areaId })
    .from(submissionsTable)
    .where(
      and(
        eq(submissionsTable.shift, shift),
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end),
      ),
    );
  const submittedSet = new Set(submittedThisShift.map((r) => r.areaId));
  const allAreas = await db.select().from(areasTable).orderBy(areasTable.name);
  const nudgesByArea = await getLatestActiveNudgeByArea();
  const pendingAreas = allAreas
    .filter((a) => !submittedSet.has(a.id))
    .map((a) => ({
      areaId: a.id,
      areaName: a.name,
      lastNudgeAt: nudgesByArea.get(a.id) ?? null,
    }));

  // Overdue checks: area_schedules whose nextDueAt is in the past, joined to areas.
  const now = new Date();
  const schedules = await db
    .select({
      areaId: areaSchedulesTable.areaId,
      areaName: areasTable.name,
      machine: areaSchedulesTable.machine,
      cadenceSeconds: areaSchedulesTable.cadenceSeconds,
      nextDueAt: areaSchedulesTable.nextDueAt,
      profileStatus: areaProfilesTable.status,
    })
    .from(areaSchedulesTable)
    .innerJoin(areasTable, eq(areaSchedulesTable.areaId, areasTable.id))
    .leftJoin(areaProfilesTable, eq(areaProfilesTable.areaId, areaSchedulesTable.areaId))
    .where(isNotNull(areaSchedulesTable.nextDueAt));

  const nudgesByAreaMachine = await getLatestActiveNudgesByAreaMachine();
  const overdueChecks = schedules
    .filter((s) => s.nextDueAt && s.nextDueAt.getTime() <= now.getTime())
    // Only surface per-machine overdue rows once the area is TRAINED — same rule
    // as the operator's "next checks" feed, so managers don't see noise from
    // machines we're still learning about.
    .filter((s) => s.machine === AREA_BASELINE_KEY || s.profileStatus === "TRAINED")
    .map((s) => ({
      areaId: s.areaId,
      areaName: s.areaName,
      machine: s.machine === AREA_BASELINE_KEY ? null : s.machine,
      overdueSinceMinutes: s.nextDueAt
        ? Math.round((now.getTime() - s.nextDueAt.getTime()) / 60000)
        : 0,
      cadenceSeconds: s.cadenceSeconds,
      lastNudgeAt:
        nudgesByAreaMachine.get(`${s.areaId}|${s.machine === AREA_BASELINE_KEY ? "" : s.machine}`) ?? null,
    }))
    .sort((a, b) => b.overdueSinceMinutes - a.overdueSinceMinutes);

  // Low scoring submissions this shift (< 60%). scoreTotal is 0-25; percent = total*4.
  const lowScoringRows = await db
    .select({
      submissionId: submissionsTable.id,
      areaId: submissionsTable.areaId,
      areaName: areasTable.name,
      operatorEmail: usersTable.email,
      scoreTotal: submissionsTable.scoreTotal,
      createdAt: submissionsTable.createdAt,
      thumbnailUrl: submissionsTable.imageUrl,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(
      and(
        eq(submissionsTable.shift, shift),
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end),
        sql`${submissionsTable.scoreTotal} * 4 < ${LOW_SCORE_PERCENT}`,
      ),
    )
    .orderBy(sql`${submissionsTable.scoreTotal} ASC, ${submissionsTable.createdAt} DESC`);

  const lowScoringIds = lowScoringRows.map((r) => r.submissionId);
  const escalationsForLow = lowScoringIds.length
    ? await db
        .select({ submissionId: escalationsTable.submissionId, status: escalationsTable.status })
        .from(escalationsTable)
        .where(inArray(escalationsTable.submissionId, lowScoringIds))
    : [];
  const openEscalationsBySub = new Set(
    escalationsForLow.filter((e) => e.status === "OPEN").map((e) => e.submissionId),
  );

  const lowScoring = lowScoringRows.map((r) => ({
    submissionId: r.submissionId,
    areaId: r.areaId,
    areaName: r.areaName,
    operatorEmail: r.operatorEmail,
    scorePercent: Math.round((r.scoreTotal ?? 0) * 4),
    createdAt: r.createdAt,
    thumbnailUrl: r.thumbnailUrl,
    hasOpenEscalation: openEscalationsBySub.has(r.submissionId),
  }));

  // Open escalations (all open, not just from this shift, since they may pre-date it).
  const openEscRows = await db
    .select({
      id: escalationsTable.id,
      submissionId: escalationsTable.submissionId,
      areaId: escalationsTable.areaId,
      areaName: areasTable.name,
      operatorId: escalationsTable.operatorId,
      operatorEmail: usersTable.email,
      scoreTotal: escalationsTable.scoreTotal,
      scorePercent: escalationsTable.scorePercent,
      failingPillarsJson: escalationsTable.failingPillarsJson,
      recommendedActionsJson: escalationsTable.recommendedActionsJson,
      evidenceUrlsJson: escalationsTable.evidenceUrlsJson,
      status: escalationsTable.status,
      createdAt: escalationsTable.createdAt,
      ackedAt: escalationsTable.ackedAt,
      resolvedAt: escalationsTable.resolvedAt,
    })
    .from(escalationsTable)
    .innerJoin(areasTable, eq(escalationsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(escalationsTable.operatorId, usersTable.id))
    .where(eq(escalationsTable.status, "OPEN"))
    .orderBy(sql`${escalationsTable.createdAt} DESC`);

  const openEscalations = openEscRows.map((r) => ({
    id: r.id,
    submissionId: r.submissionId,
    areaId: r.areaId,
    areaName: r.areaName,
    operatorId: r.operatorId,
    operatorEmail: r.operatorEmail,
    scoreTotal: r.scoreTotal,
    scorePercent: r.scorePercent,
    failingPillars: (r.failingPillarsJson as string[]) ?? [],
    recommendedActions: (r.recommendedActionsJson as string[]) ?? [],
    evidenceUrls: (r.evidenceUrlsJson as string[]) ?? [],
    status: r.status,
    createdAt: r.createdAt,
    ackedAt: r.ackedAt,
    resolvedAt: r.resolvedAt,
  }));

  res.json({
    shift,
    date: shiftDate,
    startsAt: start,
    endsAt: end,
    pendingAreas,
    overdueChecks,
    lowScoring,
    openEscalations,
  });
});

export default router;
