import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql, count, avg } from "drizzle-orm";
import { db, submissionsTable, areasTable } from "@workspace/db";
import { GetDashboardComplianceQueryParams, GetDashboardScoresQueryParams } from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";
import { getCurrentShift, getTodayDateString } from "../lib/scoring";

const router: IRouter = Router();

function getDayRange(dateStr?: string) {
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  return {
    start: new Date(y, m, d, 0, 0, 0),
    end: new Date(y, m, d + 1, 0, 0, 0),
  };
}

function getShiftRange(dateStr: string | undefined, shift: string) {
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  if (shift === "A") {
    return { start: new Date(y, m, d, 6, 0, 0), end: new Date(y, m, d, 14, 0, 0) };
  } else if (shift === "B") {
    return { start: new Date(y, m, d, 14, 0, 0), end: new Date(y, m, d, 22, 0, 0) };
  }
  return { start: new Date(y, m, d, 22, 0, 0), end: new Date(y, m, d + 1, 6, 0, 0) };
}

router.get("/dashboard/compliance", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const query = GetDashboardComplianceQueryParams.safeParse(req.query);
  const dateStr = query.success ? query.data.date : undefined;
  const shift = query.success ? query.data.shift : undefined;

  const areas = await db.select().from(areasTable);
  const totalAreas = areas.length;

  let conditions;
  if (shift) {
    const range = getShiftRange(dateStr, shift);
    conditions = and(
      eq(submissionsTable.shift, shift),
      gte(submissionsTable.createdAt, range.start),
      lt(submissionsTable.createdAt, range.end)
    );
  } else {
    const { start, end } = getDayRange(dateStr);
    conditions = and(
      gte(submissionsTable.createdAt, start),
      lt(submissionsTable.createdAt, end)
    );
  }

  const submissions = await db
    .selectDistinct({ areaId: submissionsTable.areaId })
    .from(submissionsTable)
    .where(conditions);

  const submittedIds = new Set(submissions.map((s) => s.areaId));
  const missingAreas = areas
    .filter((a) => !submittedIds.has(a.id))
    .map((a) => a.name);

  res.json({
    totalAreas,
    submittedAreas: submittedIds.size,
    compliancePercent: totalAreas > 0 ? Math.round((submittedIds.size / totalAreas) * 100) : 0,
    missingAreas,
  });
});

router.get("/dashboard/scores", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const query = GetDashboardScoresQueryParams.safeParse(req.query);
  const dateStr = query.success ? query.data.date : undefined;
  const groupBy = query.success ? query.data.groupBy : "area";

  const { start, end } = getDayRange(dateStr);
  const dateCondition = and(
    gte(submissionsTable.createdAt, start),
    lt(submissionsTable.createdAt, end)
  );

  if (groupBy === "shift") {
    const rows = await db
      .select({
        label: submissionsTable.shift,
        avgScore: avg(submissionsTable.scoreTotal),
        count: count(),
      })
      .from(submissionsTable)
      .where(dateCondition)
      .groupBy(submissionsTable.shift);

    res.json(
      rows.map((r) => ({
        label: `Shift ${r.label}`,
        avgScore: Number(r.avgScore) || 0,
        count: r.count,
      }))
    );
  } else if (groupBy === "day") {
    const rows = await db
      .select({
        label: sql<string>`to_char(${submissionsTable.createdAt}, 'YYYY-MM-DD')`,
        avgScore: avg(submissionsTable.scoreTotal),
        count: count(),
      })
      .from(submissionsTable)
      .groupBy(sql`to_char(${submissionsTable.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${submissionsTable.createdAt}, 'YYYY-MM-DD')`);

    res.json(
      rows.map((r) => ({
        label: r.label,
        avgScore: Number(r.avgScore) || 0,
        count: r.count,
      }))
    );
  } else {
    const rows = await db
      .select({
        label: areasTable.name,
        avgScore: avg(submissionsTable.scoreTotal),
        count: count(),
      })
      .from(submissionsTable)
      .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
      .where(dateCondition)
      .groupBy(areasTable.name);

    res.json(
      rows.map((r) => ({
        label: r.label,
        avgScore: Number(r.avgScore) || 0,
        count: r.count,
      }))
    );
  }
});

router.get("/dashboard/summary", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const { start, end } = getDayRange();

  const areas = await db.select().from(areasTable);

  const [todayStats] = await db
    .select({
      count: count(),
      avgScore: avg(submissionsTable.scoreTotal),
    })
    .from(submissionsTable)
    .where(
      and(
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end)
      )
    );

  const todayDistinct = await db
    .selectDistinct({ areaId: submissionsTable.areaId })
    .from(submissionsTable)
    .where(
      and(
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end)
      )
    );

  const [totalStats] = await db
    .select({ count: count() })
    .from(submissionsTable);

  const totalAreas = areas.length;
  const compliance = totalAreas > 0
    ? Math.round((todayDistinct.length / totalAreas) * 100)
    : 0;

  res.json({
    todaySubmissions: todayStats?.count ?? 0,
    todayAvgScore: Number(todayStats?.avgScore) || 0,
    todayCompliance: compliance,
    totalSubmissions: totalStats?.count ?? 0,
  });
});

export default router;
