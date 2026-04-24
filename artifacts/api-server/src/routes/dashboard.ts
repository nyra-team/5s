import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql, count, avg, desc, max, isNotNull } from "drizzle-orm";
import {
  db,
  submissionsTable,
  areasTable,
  escalationsTable,
  areaProfilesTable,
  nudgesTable,
  usersTable,
} from "@workspace/db";
import type { NudgeDismissReason } from "@workspace/db";
import {
  GetDashboardComplianceQueryParams,
  GetDashboardScoresQueryParams,
  GetDashboardTrendsQueryParams,
  GetDashboardOperatorDismissesQueryParams,
  GetDashboardOperatorDismissesDetailQueryParams,
} from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  getISTDayRange,
  getISTShiftRange,
  getShiftConfig,
  getZonedParts,
  formatZonedDate,
} from "../lib/scoring";

const router: IRouter = Router();

// Date ranges are anchored to the facility's configured shift timezone so
// "today" and per-shift filters match the clock operators see, regardless of
// where the server is running. A Date passed in (used by an internal call
// site) is converted via its calendar date in that timezone.
function normalizeDateInput(input: string | Date | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  return formatZonedDate(input);
}

function getDayRange(dateStr?: string | Date) {
  return getISTDayRange(normalizeDateInput(dateStr));
}

function getShiftRange(dateStr: string | Date | undefined, shift: string) {
  return getISTShiftRange(normalizeDateInput(dateStr), shift);
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

  const [openEsc] = await db
    .select({ count: count() })
    .from(escalationsTable)
    .where(eq(escalationsTable.status, "OPEN"));

  res.json({
    todaySubmissions: todayStats?.count ?? 0,
    todayAvgScore: Number(todayStats?.avgScore) || 0,
    todayCompliance: compliance,
    totalSubmissions: totalStats?.count ?? 0,
    openEscalations: openEsc?.count ?? 0,
  });
});

// Per-area daily score trend over the last N days (default 14). For each area
// we return one point per IST calendar day with the average scorePercent
// (scoreTotal × 4) and submission count, plus the IST date the area first
// reached the TRAINED threshold (stored on `area_profiles.trained_at`) so the
// UI can highlight when the AI's per-area model graduated from LEARNING.
router.get("/dashboard/trends", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const parsed = GetDashboardTrendsQueryParams.safeParse(req.query);
  const days = parsed.success ? parsed.data.days : 14;
  const shift = parsed.success ? parsed.data.shift : undefined;

  // Build the contiguous list of calendar-day labels the chart needs
  // (oldest → today) by walking backwards from today using calendar-day
  // arithmetic on YMD parts. We deliberately do NOT step by 24h UTC chunks:
  // across DST transitions a local day is 23 or 25 hours of UTC, so
  // fixed-millisecond stepping would skip or duplicate days for facilities
  // in DST-observing zones (e.g. America/New_York).
  const today = getZonedParts();
  const dayLabels: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    // Date.UTC normalizes negative day-of-month into the previous month/year,
    // and the YMD result is independent of UTC vs local clock — we only use
    // it to advance calendar dates.
    const stepped = new Date(Date.UTC(today.year, today.month, today.day - i));
    const y = stepped.getUTCFullYear();
    const m = String(stepped.getUTCMonth() + 1).padStart(2, "0");
    const d = String(stepped.getUTCDate()).padStart(2, "0");
    dayLabels.push(`${y}-${m}-${d}`);
  }
  const windowStart = getISTDayRange(dayLabels[0]).start;
  const windowEnd = getISTDayRange(dayLabels[dayLabels.length - 1]).end;

  const areas = await db.select().from(areasTable);
  if (areas.length === 0) {
    res.json([]);
    return;
  }

  // Use the configured shift timezone (validated at startup via
  // Intl.DateTimeFormat — never user-controlled) so trend rows bucket by the
  // same calendar day operators see in their timezone. We inline the tz as a
  // SQL literal rather than a bound parameter: when each use of istDayExpr is
  // bound separately, postgres sees two distinct parameter slots in SELECT vs
  // GROUP BY and can't prove the expressions are equal, raising
  // "column must appear in the GROUP BY clause" (SQLSTATE 42803). We still
  // escape single quotes defensively even though the value is validated.
  const shiftTz = getShiftConfig().timeZone;
  const tzLiteral = sql.raw(`'${shiftTz.replace(/'/g, "''")}'`);
  const istDayExpr = sql<string>`to_char(${submissionsTable.createdAt} at time zone ${tzLiteral}, 'YYYY-MM-DD')`;

  // When a shift filter is provided, every day's average reflects only that
  // shift's submissions; the date window itself is unchanged.
  const dailyWhere = shift
    ? and(
        gte(submissionsTable.createdAt, windowStart),
        lt(submissionsTable.createdAt, windowEnd),
        eq(submissionsTable.shift, shift)
      )
    : and(
        gte(submissionsTable.createdAt, windowStart),
        lt(submissionsTable.createdAt, windowEnd)
      );

  const dailyRows = await db
    .select({
      areaId: submissionsTable.areaId,
      day: istDayExpr,
      avgScore: avg(submissionsTable.scoreTotal),
      count: count(),
    })
    .from(submissionsTable)
    .where(dailyWhere)
    .groupBy(submissionsTable.areaId, istDayExpr);

  const byArea = new Map<number, Map<string, { avgScore: number; count: number }>>();
  for (const r of dailyRows) {
    const inner = byArea.get(r.areaId) ?? new Map();
    inner.set(r.day, {
      avgScore: Math.round((Number(r.avgScore) || 0) * 4),
      count: r.count,
    });
    byArea.set(r.areaId, inner);
  }

  const profiles = await db.select().from(areaProfilesTable);
  const profileByArea = new Map(profiles.map((p) => [p.areaId, p]));

  const result = areas.map((a) => {
    const inner = byArea.get(a.id) ?? new Map<string, { avgScore: number; count: number }>();
    // Days with no submissions are emitted as avgScore: null (not 0) so the
    // chart renders a gap instead of pretending the area scored 0%.
    const points = dayLabels.map((d) => {
      const hit = inner.get(d);
      return {
        date: d,
        avgScore: hit ? hit.avgScore : null,
        count: hit?.count ?? 0,
      };
    });
    const profile = profileByArea.get(a.id);
    const status: "LEARNING" | "TRAINED" =
      profile?.status === "TRAINED" ? "TRAINED" : "LEARNING";
    // Read the authoritative graduation date straight from the profile row
    // instead of replaying submissions on every dashboard load.
    const trainedOnDate =
      status === "TRAINED" && profile?.trainedAt
        ? normalizeDateInput(profile.trainedAt) ?? null
        : null;
    return {
      areaId: a.id,
      areaName: a.name,
      environmentType: a.environmentType,
      status,
      trainedOnDate,
      points,
    };
  });

  res.json(result);
});

// Compute the Date that is `days` calendar-day boundaries ago in the configured
// shift timezone. We want "last 7 days" to mean "since the start of 6 days
// before today" in the shift TZ, not 7 * 24h of UTC, so DST transitions don't
// quietly add or drop a day's worth of dismissals.
function getDismissWindowStart(days: number): Date {
  const today = getZonedParts();
  const stepped = new Date(Date.UTC(today.year, today.month, today.day - (days - 1)));
  const y = stepped.getUTCFullYear();
  const m = String(stepped.getUTCMonth() + 1).padStart(2, "0");
  const d = String(stepped.getUTCDate()).padStart(2, "0");
  return getISTDayRange(`${y}-${m}-${d}`).start;
}

const OPERATOR_DISMISS_REASON: NudgeDismissReason = "OPERATOR_DISMISS";

// Per-operator aggregate of nudges they dismissed without re-capturing
// (dismissReason=OPERATOR_DISMISS), within the last N days. Only operators
// who actually have at least one such dismissal in the window are returned,
// so the list focuses managers on the people exhibiting the pattern.
router.get(
  "/dashboard/operator-dismisses",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const parsed = GetDashboardOperatorDismissesQueryParams.safeParse(req.query);
    const days = parsed.success ? parsed.data.days : 7;
    const windowStart = getDismissWindowStart(days);

    const rows = await db
      .select({
        operatorId: usersTable.id,
        operatorEmail: usersTable.email,
        dismissCount: count(nudgesTable.id),
        lastDismissedAt: max(nudgesTable.dismissedAt),
      })
      .from(nudgesTable)
      .innerJoin(usersTable, eq(nudgesTable.dismissedByUserId, usersTable.id))
      .where(
        and(
          eq(nudgesTable.dismissReason, OPERATOR_DISMISS_REASON),
          isNotNull(nudgesTable.dismissedAt),
          isNotNull(nudgesTable.dismissedByUserId),
          gte(nudgesTable.dismissedAt, windowStart),
        ),
      )
      .groupBy(usersTable.id, usersTable.email)
      .orderBy(desc(count(nudgesTable.id)), desc(max(nudgesTable.dismissedAt)));

    res.json(
      rows.map((r) => ({
        operatorId: r.operatorId,
        operatorEmail: r.operatorEmail,
        dismissCount: r.dismissCount,
        // max() returns Date | null in drizzle types; the isNotNull guard above
        // makes the null case impossible, but coerce defensively for the wire.
        lastDismissedAt: r.lastDismissedAt ?? new Date(0),
      })),
    );
  },
);

// Drill-down: every nudge a single operator dismissed-without-submit in the
// window, newest first, with area name + machine + when so the dashboard
// can show the manager exactly what was silenced. operatorId rides in the
// query string (not the path) so the generated zod params type doesn't
// collide with the React client's combined query-params type.
router.get(
  "/dashboard/operator-dismisses/detail",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const query = GetDashboardOperatorDismissesDetailQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const { operatorId, days } = query.data;
    const windowStart = getDismissWindowStart(days);

    const rows = await db
      .select({
        nudgeId: nudgesTable.id,
        areaId: nudgesTable.areaId,
        areaName: areasTable.name,
        machine: nudgesTable.machine,
        shift: nudgesTable.shift,
        message: nudgesTable.message,
        createdAt: nudgesTable.createdAt,
        dismissedAt: nudgesTable.dismissedAt,
      })
      .from(nudgesTable)
      .innerJoin(areasTable, eq(nudgesTable.areaId, areasTable.id))
      .where(
        and(
          eq(nudgesTable.dismissReason, OPERATOR_DISMISS_REASON),
          eq(nudgesTable.dismissedByUserId, operatorId),
          isNotNull(nudgesTable.dismissedAt),
          gte(nudgesTable.dismissedAt, windowStart),
        ),
      )
      .orderBy(desc(nudgesTable.dismissedAt));

    res.json(
      rows.map((r) => ({
        nudgeId: r.nudgeId,
        areaId: r.areaId,
        areaName: r.areaName,
        machine: r.machine,
        shift: r.shift,
        message: r.message,
        createdAt: r.createdAt,
        dismissedAt: r.dismissedAt ?? new Date(0),
      })),
    );
  },
);

export default router;
