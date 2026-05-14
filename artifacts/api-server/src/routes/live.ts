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
  getZonedParts,
  getTodayDateString,
  formatZonedDate,
} from "../lib/scoring";
import { loadEffectiveShiftConfig } from "../lib/facility-settings.js";
import {
  getLatestActiveNudgeByArea,
  getLatestActiveNudgesByAreaMachine,
  getOperatorDismissedNudgeByArea,
  getOperatorDismissedNudgesByAreaMachine,
} from "./nudges";

const router: IRouter = Router();

const LOW_SCORE_PERCENT = 60;

const AREA_BASELINE_KEY = "";

router.get("/shift/live", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const cfg = await loadEffectiveShiftConfig();
  const { shift } = getCurrentShift(cfg);
  // For shift "C" before A-start, getISTShiftRange anchors to "yesterday
  // C-start → today A-start" in the configured shift timezone.
  const { start, end } = getISTShiftRange(undefined, shift, cfg);
  const date = getTodayDateString(cfg);
  // For shift C straddling midnight, label by the calendar day the shift
  // began (in the configured shift timezone).
  const shiftDate =
    shift === "C" && getZonedParts(new Date(), cfg.timeZone).hour < cfg.startHours.A
      ? formatZonedDate(start, cfg.timeZone)
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
  // Operator-dismissed-without-resubmit nudges, scoped to this shift window so
  // an old swipe-away from yesterday doesn't keep flagging the area today.
  const operatorDismissedByArea = await getOperatorDismissedNudgeByArea(start);
  const pendingAreas = allAreas
    .filter((a) => !submittedSet.has(a.id))
    .map((a) => {
      const dismissed = operatorDismissedByArea.get(a.id);
      return {
        areaId: a.id,
        areaName: a.name,
        lastNudgeAt: nudgesByArea.get(a.id) ?? null,
        // Pending areas have no submission this shift by definition, so any
        // operator-dismissed nudge here is unambiguously a "swipe-away without
        // re-capturing" event we want managers to see.
        lastOperatorDismissedNudgeAt: dismissed?.dismissedAt ?? null,
        lastOperatorDismissedNudgeByEmail: dismissed?.dismissedByEmail ?? null,
        lastOperatorDismissedNudgeByDisplayName:
          dismissed?.dismissedByDisplayName ?? null,
      };
    });

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
  // Same shift window as pendingAreas: an overdue check accompanied by a
  // recent operator-dismissed nudge means the operator silenced the reminder
  // instead of capturing fresh evidence.
  const operatorDismissedByAreaMachine = await getOperatorDismissedNudgesByAreaMachine(start);
  const overdueChecks = schedules
    .filter((s) => s.nextDueAt && s.nextDueAt.getTime() <= now.getTime())
    // Only surface per-machine overdue rows once the area is TRAINED — same rule
    // as the operator's "next checks" feed, so managers don't see noise from
    // machines we're still learning about.
    .filter((s) => s.machine === AREA_BASELINE_KEY || s.profileStatus === "TRAINED")
    .map((s) => {
      const nudgeKey = `${s.areaId}|${s.machine === AREA_BASELINE_KEY ? "" : s.machine}`;
      const dismissed = operatorDismissedByAreaMachine.get(nudgeKey);
      return {
        areaId: s.areaId,
        areaName: s.areaName,
        machine: s.machine === AREA_BASELINE_KEY ? null : s.machine,
        overdueSinceMinutes: s.nextDueAt
          ? Math.round((now.getTime() - s.nextDueAt.getTime()) / 60000)
          : 0,
        cadenceSeconds: s.cadenceSeconds,
        lastNudgeAt: nudgesByAreaMachine.get(nudgeKey) ?? null,
        lastOperatorDismissedNudgeAt: dismissed?.dismissedAt ?? null,
        lastOperatorDismissedNudgeByEmail: dismissed?.dismissedByEmail ?? null,
        lastOperatorDismissedNudgeByDisplayName:
          dismissed?.dismissedByDisplayName ?? null,
      };
    })
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
      aiIssuesJson: submissionsTable.aiIssuesJson,
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
    aiIssuesJson: r.aiIssuesJson,
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
      repingCount: escalationsTable.repingCount,
      lastRepingAt: escalationsTable.lastRepingAt,
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
    // Mirror the inbox's "Reminded Nx · 12m ago" badge on the live page so a
    // manager triaging from here can see at a glance which escalations the
    // re-ping scheduler has already auto-poked.
    repingCount: r.repingCount ?? 0,
    lastRepingAt: r.lastRepingAt,
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
