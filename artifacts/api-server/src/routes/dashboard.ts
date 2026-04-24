import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql, count, avg, desc, max, isNotNull, isNull, inArray } from "drizzle-orm";
import {
  db,
  submissionsTable,
  areasTable,
  escalationsTable,
  areaProfilesTable,
  nudgesTable,
  usersTable,
  aiScoringMetricsTable,
} from "@workspace/db";
import { computeRetryStatsSince } from "../lib/ai-reliability.js";
import type { NudgeDismissReason } from "@workspace/db";
import {
  GetDashboardComplianceQueryParams,
  GetDashboardScoresQueryParams,
  GetDashboardTrendsQueryParams,
  GetDashboardOperatorDismissesQueryParams,
  GetDashboardOperatorDismissesDetailQueryParams,
  SendOperatorCoachingNudgeBody,
} from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  getISTDayRange,
  getISTShiftRange,
  getZonedParts,
  formatZonedDate,
  getCurrentShift,
  type ShiftConfig,
} from "../lib/scoring";
import { loadEffectiveShiftConfig } from "../lib/facility-settings.js";

const router: IRouter = Router();

// Date ranges are anchored to the facility's configured shift timezone so
// "today" and per-shift filters match the clock operators see, regardless of
// where the server is running. A Date passed in (used by an internal call
// site) is converted via its calendar date in that timezone.
function normalizeDateInput(input: string | Date | undefined, cfg: ShiftConfig): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  return formatZonedDate(input, cfg.timeZone);
}

function getDayRange(cfg: ShiftConfig, dateStr?: string | Date) {
  return getISTDayRange(normalizeDateInput(dateStr, cfg), cfg);
}

function getShiftRange(cfg: ShiftConfig, dateStr: string | Date | undefined, shift: string) {
  return getISTShiftRange(normalizeDateInput(dateStr, cfg), shift, cfg);
}

router.get("/dashboard/compliance", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const cfg = await loadEffectiveShiftConfig();
  const query = GetDashboardComplianceQueryParams.safeParse(req.query);
  const dateStr = query.success ? query.data.date : undefined;
  const shift = query.success ? query.data.shift : undefined;

  const areas = await db.select().from(areasTable);
  const totalAreas = areas.length;

  let conditions;
  if (shift) {
    const range = getShiftRange(cfg, dateStr, shift);
    conditions = and(
      eq(submissionsTable.shift, shift),
      gte(submissionsTable.createdAt, range.start),
      lt(submissionsTable.createdAt, range.end)
    );
  } else {
    const { start, end } = getDayRange(cfg, dateStr);
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
  const cfg = await loadEffectiveShiftConfig();
  const query = GetDashboardScoresQueryParams.safeParse(req.query);
  const dateStr = query.success ? query.data.date : undefined;
  const groupBy = query.success ? query.data.groupBy : "area";

  const { start, end } = getDayRange(cfg, dateStr);
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
  const cfg = await loadEffectiveShiftConfig();
  const { start, end } = getDayRange(cfg);

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

// Surfaces how often the VLM scoring pipeline had to retry its first
// response because the JSON failed validation. We aggregate over a rolling
// 24h and 7d window so the dashboard can compare today against the recent
// baseline at a glance — a sudden 24h spike means the model is misbehaving
// and we're paying ~2x per audit. Per window we also return the most
// frequent distinct validation messages so engineers can target the
// specific failure ("missing pillar_scores object") instead of guessing.
const AI_RELIABILITY_TOP_ERRORS = 5;

router.get("/dashboard/ai-reliability", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const now = Date.now();
  const last24h = new Date(now - 24 * 60 * 60 * 1000);
  const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

  // Totals/rate come from the shared `computeRetryStatsSince` helper so the
  // dashboard chip and the background spike monitor can't drift apart on
  // future schema changes. The top-N validation message breakdown is
  // dashboard-only (the alert payload doesn't need it), so we run it
  // alongside in a separate query — keeping each query trivially
  // explainable: totals as headline, breakdown as drill-down.
  async function windowStats(since: Date) {
    // Group by validation_error so semantically identical failures collapse
    // into a single row. We restrict to retried=true AND validation_error IS
    // NOT NULL so a clean call (which writes a row with retried=false and a
    // null error) can never sneak into the breakdown — only actual retries
    // count toward what's "tripping the AI up". The callKind="scoring"
    // predicate keeps identification calls out of the breakdown for the
    // same reason the headline retry-rate filters them: they don't run a
    // JSON-validation retry loop and would dilute the signal.
    const [stats, errorRows] = await Promise.all([
      computeRetryStatsSince(since),
      db
        .select({
          message: aiScoringMetricsTable.validationError,
          count: count(),
        })
        .from(aiScoringMetricsTable)
        .where(
          and(
            gte(aiScoringMetricsTable.createdAt, since),
            eq(aiScoringMetricsTable.retried, true),
            isNotNull(aiScoringMetricsTable.validationError),
            eq(aiScoringMetricsTable.callKind, "scoring"),
          ),
        )
        .groupBy(aiScoringMetricsTable.validationError)
        .orderBy(desc(count()))
        .limit(AI_RELIABILITY_TOP_ERRORS),
    ]);

    const topErrors = errorRows
      // The isNotNull predicate above already filters nulls, but the column
      // is nullable so the inferred type still includes null — coerce here
      // so the response shape is exactly string + integer.
      .filter((r): r is { message: string; count: number } => r.message != null)
      .map((r) => ({ message: r.message, count: Number(r.count) }));
    return { ...stats, topErrors };
  }

  const [twentyFourHour, sevenDay] = await Promise.all([
    windowStats(last24h),
    windowStats(last7d),
  ]);

  res.json({
    last24h: twentyFourHour,
    last7d: sevenDay,
  });
});

// Per-model latency + token usage rollup over the last 7d/30d windows.
//
// Why this exists: task #165 hard-swapped the underlying model from
// gpt-5-mini to flagship gpt-5, accepting higher per-call cost and somewhat
// slower responses. This endpoint surfaces the trade-off in-app so managers
// can sanity-check whether the quality bump is worth the spend, with old
// `gpt-5-mini-…-v3` rows and the new `gpt-5-…-v1` rows rendered side-by-side.
//
// One row per `modelVersion` per window. Pricing is a rough USD estimate using
// the published gpt-5 family prompt/completion rates — exact billing lives at
// the proxy, not here, so we deliberately label the column "estimated".
//
// Per-1K-token rates (USD) sourced from the gpt-5 model family pricing as of
// April 2026. If/when these change, bump the version number in MODEL_PRICING
// so a stale cost estimate doesn't silently drift.
type ModelPricing = { promptPer1k: number; completionPer1k: number };
const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5": { promptPer1k: 0.005, completionPer1k: 0.015 },
  "gpt-5-mini": { promptPer1k: 0.00025, completionPer1k: 0.002 },
};
// Pricing fallback when a modelVersion string doesn't map to a known family.
// Returning null (rather than 0) keeps the UI honest about unknown models.
function pricingFor(modelVersion: string): ModelPricing | null {
  // Order matters: the more specific "gpt-5-mini" prefix must win over the
  // generic "gpt-5" check so a mini-flavored row isn't priced as flagship.
  if (modelVersion.startsWith("gpt-5-mini")) return MODEL_PRICING["gpt-5-mini"]!;
  if (modelVersion.startsWith("gpt-5")) return MODEL_PRICING["gpt-5"]!;
  return null;
}

router.get(
  "/dashboard/ai-cost",
  authMiddleware,
  requireRole("MANAGER"),
  async (_req, res): Promise<void> => {
    const now = Date.now();
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // Aggregate per-(modelVersion, callKind) inside one window. We use
    // PERCENTILE_CONT for p95 because the table is small enough that the
    // extra sort beats maintaining histograms ourselves; the createdAt
    // index already constrains the input set to the window.
    async function windowRollup(since: Date) {
      const rows = await db
        .select({
          modelVersion: aiScoringMetricsTable.modelVersion,
          callKind: aiScoringMetricsTable.callKind,
          requestCount: count(),
          // Latency aggregates are computed only over rows with a non-null
          // latency_ms; legacy rows written before timing was captured drop
          // out of the average instead of skewing it to 0.
          avgLatencyMs: sql<number | null>`AVG(${aiScoringMetricsTable.latencyMs})::float8`,
          p95LatencyMs: sql<number | null>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${aiScoringMetricsTable.latencyMs})::float8`,
          totalPromptTokens: sql<number>`COALESCE(SUM(${aiScoringMetricsTable.promptTokens}), 0)::bigint`,
          totalCompletionTokens: sql<number>`COALESCE(SUM(${aiScoringMetricsTable.completionTokens}), 0)::bigint`,
          totalTokens: sql<number>`COALESCE(SUM(${aiScoringMetricsTable.totalTokens}), 0)::bigint`,
        })
        .from(aiScoringMetricsTable)
        .where(gte(aiScoringMetricsTable.createdAt, since))
        .groupBy(aiScoringMetricsTable.modelVersion, aiScoringMetricsTable.callKind);

      return rows.map((r) => {
        const requestCount = Number(r.requestCount ?? 0);
        const promptTokens = Number(r.totalPromptTokens ?? 0);
        const completionTokens = Number(r.totalCompletionTokens ?? 0);
        const totalTokens = Number(r.totalTokens ?? 0);
        const price = pricingFor(r.modelVersion);
        const estimatedCostUsd = price
          ? (promptTokens / 1000) * price.promptPer1k +
            (completionTokens / 1000) * price.completionPer1k
          : null;
        return {
          modelVersion: r.modelVersion,
          callKind: r.callKind,
          requestCount,
          avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(Number(r.avgLatencyMs)),
          p95LatencyMs: r.p95LatencyMs == null ? null : Math.round(Number(r.p95LatencyMs)),
          totalPromptTokens: promptTokens,
          totalCompletionTokens: completionTokens,
          totalTokens,
          // Rounded to 4 decimals — for individual-model lines these are
          // typically under a dollar; clipping at 4dp avoids floating-point
          // noise on the wire while keeping cents-level precision.
          estimatedCostUsd:
            estimatedCostUsd == null ? null : Math.round(estimatedCostUsd * 10000) / 10000,
          // null per-call cost when we couldn't price the model at all,
          // otherwise tokens/request × per-token cost. requestCount==0 is
          // unreachable here (groupBy only emits rows that exist) but guard
          // for it defensively so a future code change can't divide by zero.
          estimatedCostPerCallUsd:
            estimatedCostUsd == null || requestCount === 0
              ? null
              : Math.round((estimatedCostUsd / requestCount) * 10000) / 10000,
          // Per-call token estimate so managers can compare modelVersions
          // independent of traffic volume — flagship gpt-5 burns roughly an
          // order of magnitude more tokens per call than gpt-5-mini, and that
          // ratio matters more than absolute totals when the windows have
          // different request counts. Rounded to a whole token; unreachable
          // requestCount==0 falls back to null defensively.
          estimatedTokensPerCall:
            requestCount === 0 ? null : Math.round(totalTokens / requestCount),
        };
      })
      // Sort highest cost first so the UI naturally lands on the model
      // accounting for most spend; ties broken by request count.
      .sort((a, b) => {
        const ac = a.estimatedCostUsd ?? -1;
        const bc = b.estimatedCostUsd ?? -1;
        if (ac !== bc) return bc - ac;
        return b.requestCount - a.requestCount;
      });
    }

    const [sevenDay, thirtyDay] = await Promise.all([
      windowRollup(last7d),
      windowRollup(last30d),
    ]);

    res.json({
      last7d: sevenDay,
      last30d: thirtyDay,
    });
  },
);

// Per-area daily score trend over the last N days (default 14). For each area
// we return one point per IST calendar day with the average scorePercent
// (scoreTotal × 4) and submission count, plus the IST date the area first
// reached the TRAINED threshold (stored on `area_profiles.trained_at`) so the
// UI can highlight when the AI's per-area model graduated from LEARNING.
router.get("/dashboard/trends", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const cfg = await loadEffectiveShiftConfig();
  const parsed = GetDashboardTrendsQueryParams.safeParse(req.query);
  const days = parsed.success ? parsed.data.days : 14;
  const shift = parsed.success ? parsed.data.shift : undefined;

  // Build the contiguous list of calendar-day labels the chart needs
  // (oldest → today) by walking backwards from today using calendar-day
  // arithmetic on YMD parts. We deliberately do NOT step by 24h UTC chunks:
  // across DST transitions a local day is 23 or 25 hours of UTC, so
  // fixed-millisecond stepping would skip or duplicate days for facilities
  // in DST-observing zones (e.g. America/New_York).
  const today = getZonedParts(new Date(), cfg.timeZone);
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
  const windowStart = getISTDayRange(dayLabels[0], cfg).start;
  const windowEnd = getISTDayRange(dayLabels[dayLabels.length - 1], cfg).end;

  const areas = await db.select().from(areasTable);
  if (areas.length === 0) {
    res.json([]);
    return;
  }

  // Use the configured shift timezone (validated at startup) so trend rows
  // bucket by the same calendar day operators see in their timezone.
  const shiftTz = cfg.timeZone;
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
        ? normalizeDateInput(profile.trainedAt, cfg) ?? null
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
function getDismissWindowStart(days: number, cfg: ShiftConfig): Date {
  const today = getZonedParts(new Date(), cfg.timeZone);
  const stepped = new Date(Date.UTC(today.year, today.month, today.day - (days - 1)));
  const y = stepped.getUTCFullYear();
  const m = String(stepped.getUTCMonth() + 1).padStart(2, "0");
  const d = String(stepped.getUTCDate()).padStart(2, "0");
  return getISTDayRange(`${y}-${m}-${d}`, cfg).start;
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
    const cfg = await loadEffectiveShiftConfig();
    const parsed = GetDashboardOperatorDismissesQueryParams.safeParse(req.query);
    const days = parsed.success ? parsed.data.days : 7;
    const windowStart = getDismissWindowStart(days, cfg);

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
    const cfg = await loadEffectiveShiftConfig();
    const query = GetDashboardOperatorDismissesDetailQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const { operatorId, days } = query.data;
    const windowStart = getDismissWindowStart(days, cfg);

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

// One-tap "send a coaching nudge" action that closes the loop on the
// operator-dismiss panel. The manager picks an operator from the row, we pick
// the area they've been silencing the most in the last `days` window, and we
// drop a fresh nudge on that area for the current shift. Throttled per
// (operator, area) to one hour so two managers reacting to the same row
// (or a quick double-tap) don't pile reminders on the operator.
//
// Note: the nudge schema is shift-scoped, not operator-scoped — there's no
// `targetUserId` column on `nudges` today. We surface the action AS a per-
// operator coaching tool because the area picked is derived from THAT
// operator's dismissal history, but the actual reminder is delivered through
// the existing per-shift nudge channel that the operator app already polls.
// If we later add a per-operator nudge channel, the throttle key (operator+
// area) is already correct.
const COACHING_NUDGE_THROTTLE_MS = 60 * 60 * 1000;

router.post(
  "/dashboard/operator-coaching-nudge",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId: managerId } = (req as any).user as { userId: number };
    const parsed = SendOperatorCoachingNudgeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { operatorId, message: rawMessage, days } = parsed.data;

    // Confirm the operator exists before we start joining nudges around their
    // id — a 404 here gives a much clearer signal than an empty aggregate.
    const [operator] = await db
      .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, operatorId));
    if (!operator) {
      res.status(404).json({ error: "Operator not found" });
      return;
    }

    const cfg = await loadEffectiveShiftConfig();
    const windowStart = getDismissWindowStart(days, cfg);

    // Pick the operator's most-dismissed area in the window. Ties broken by
    // most-recent dismissal so the manager sends a reminder on the area
    // that's been freshly painful, not a stale one from a week ago.
    const [topArea] = await db
      .select({
        areaId: nudgesTable.areaId,
        areaName: areasTable.name,
        dismissCount: count(nudgesTable.id),
        lastDismissedAt: max(nudgesTable.dismissedAt),
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
      .groupBy(nudgesTable.areaId, areasTable.name)
      .orderBy(desc(count(nudgesTable.id)), desc(max(nudgesTable.dismissedAt)))
      .limit(1);

    if (!topArea) {
      res.status(404).json({
        error:
          "No OPERATOR_DISMISS history for this operator in the requested window",
      });
      return;
    }

    const currentShift = getCurrentShift(cfg).shift;
    const throttleSince = new Date(Date.now() - COACHING_NUDGE_THROTTLE_MS);

    // Throttle key: a nudge for the same (area, shift) created in the last
    // hour, with no machine attached (matching the area-level coaching
    // nudge we'd be about to insert). Catches both "two managers acted
    // simultaneously" and "the same manager double-tapped". We deliberately
    // include dismissed nudges in the lookup so a fast OPERATOR_DISMISS does
    // not let the manager re-spam right away.
    const [recent] = await db
      .select({
        id: nudgesTable.id,
        createdAt: nudgesTable.createdAt,
      })
      .from(nudgesTable)
      .where(
        and(
          eq(nudgesTable.areaId, topArea.areaId),
          eq(nudgesTable.shift, currentShift),
          isNull(nudgesTable.machine),
          gte(nudgesTable.createdAt, throttleSince),
        ),
      )
      .orderBy(desc(nudgesTable.createdAt))
      .limit(1);

    if (recent) {
      const nextEligibleAt = new Date(
        recent.createdAt.getTime() + COACHING_NUDGE_THROTTLE_MS,
      );
      res.status(429).json({
        error:
          "A reminder for this operator's most-dismissed area was sent within the last hour",
        targetOperatorId: operatorId,
        targetAreaId: topArea.areaId,
        targetAreaName: topArea.areaName,
        lastSentAt: recent.createdAt,
        nextEligibleAt,
      });
      return;
    }

    const trimmed =
      typeof rawMessage === "string" && rawMessage.trim() !== ""
        ? rawMessage.trim()
        : null;
    const message =
      trimmed ??
      `Coaching nudge: please prioritise a fresh walk-through for ${topArea.areaName} this shift.`;

    const [created] = await db
      .insert(nudgesTable)
      .values({
        areaId: topArea.areaId,
        machine: null,
        shift: currentShift,
        message,
        createdByUserId: managerId,
      })
      .returning({ id: nudgesTable.id, createdAt: nudgesTable.createdAt });

    // Re-shape the row through the join so the response carries areaName +
    // createdByEmail in the same shape the rest of the nudge endpoints use.
    const [shaped] = await db
      .select({
        id: nudgesTable.id,
        areaId: nudgesTable.areaId,
        areaName: areasTable.name,
        machine: nudgesTable.machine,
        shift: nudgesTable.shift,
        message: nudgesTable.message,
        createdByEmail: usersTable.email,
        createdAt: nudgesTable.createdAt,
        dismissedAt: nudgesTable.dismissedAt,
      })
      .from(nudgesTable)
      .innerJoin(areasTable, eq(nudgesTable.areaId, areasTable.id))
      .innerJoin(usersTable, eq(nudgesTable.createdByUserId, usersTable.id))
      .where(eq(nudgesTable.id, created.id));

    res.status(201).json({
      nudge: shaped,
      targetOperatorId: operatorId,
      targetAreaId: topArea.areaId,
      targetAreaName: topArea.areaName,
      targetShift: currentShift,
      sentAt: created.createdAt,
      reused: false,
    });
  },
);

// Auto-detect agreement: how often the area the operator originally tapped
// matched the area their submission was actually saved against. Excludes
// rows with no recorded `tappedAreaId` (legacy rows from before drift
// instrumentation existed) so the rate isn't artificially inflated by
// pre-instrumentation history.
router.get(
  "/dashboard/area-detection-agreement",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const rawDays = parseInt(String(req.query.days ?? ""), 10);
    const days =
      Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 90 ? rawDays : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        areaId: submissionsTable.areaId,
        tappedAreaId: submissionsTable.tappedAreaId,
        userId: submissionsTable.userId,
      })
      .from(submissionsTable)
      .where(
        and(
          isNotNull(submissionsTable.tappedAreaId),
          gte(submissionsTable.createdAt, since),
        ),
      );

    const agreementPercent = (agreed: number, total: number): number | null =>
      total === 0 ? null : Math.round((agreed / total) * 100);

    const overallTotal = rows.length;
    const overallAgreed = rows.reduce(
      (acc, r) => acc + (r.tappedAreaId === r.areaId ? 1 : 0),
      0,
    );

    // Per-area: bucket each row under BOTH the tapped area and the chosen
    // area when they differ, so drift surfaces against whichever area the
    // manager is currently looking at. A row that agrees only contributes
    // to a single area (tapped == chosen).
    type AreaAgg = { total: number; agreed: number };
    const perAreaMap = new Map<number, AreaAgg>();
    const bumpArea = (areaId: number, agreed: boolean) => {
      const cur = perAreaMap.get(areaId) ?? { total: 0, agreed: 0 };
      cur.total += 1;
      if (agreed) cur.agreed += 1;
      perAreaMap.set(areaId, cur);
    };
    for (const r of rows) {
      const agreed = r.tappedAreaId === r.areaId;
      if (r.tappedAreaId != null) bumpArea(r.tappedAreaId, agreed);
      if (!agreed) bumpArea(r.areaId, false);
    }

    type OperatorAgg = { total: number; agreed: number };
    const perOperatorMap = new Map<number, OperatorAgg>();
    for (const r of rows) {
      const cur = perOperatorMap.get(r.userId) ?? { total: 0, agreed: 0 };
      cur.total += 1;
      if (r.tappedAreaId === r.areaId) cur.agreed += 1;
      perOperatorMap.set(r.userId, cur);
    }

    const areaIds = Array.from(perAreaMap.keys());
    const userIds = Array.from(perOperatorMap.keys());
    const [areaRows, userRows] = await Promise.all([
      areaIds.length
        ? db
            .select({ id: areasTable.id, name: areasTable.name })
            .from(areasTable)
            .where(inArray(areasTable.id, areaIds))
        : Promise.resolve([] as { id: number; name: string }[]),
      userIds.length
        ? db
            .select({ id: usersTable.id, email: usersTable.email })
            .from(usersTable)
            .where(inArray(usersTable.id, userIds))
        : Promise.resolve([] as { id: number; email: string }[]),
    ]);
    const areaNameById = new Map(areaRows.map((a) => [a.id, a.name]));
    const userEmailById = new Map(userRows.map((u) => [u.id, u.email]));

    const perArea = areaIds
      .map((areaId) => {
        const agg = perAreaMap.get(areaId)!;
        return {
          areaId,
          areaName: areaNameById.get(areaId) ?? `Area #${areaId}`,
          total: agg.total,
          agreed: agg.agreed,
          agreementPercent: agreementPercent(agg.agreed, agg.total),
        };
      })
      // Sort lowest agreement first so attention lands on the worst offenders.
      // Within ties, larger sample size first so the row is the most
      // statistically meaningful one to act on.
      .sort((a, b) => {
        const ap = a.agreementPercent ?? 100;
        const bp = b.agreementPercent ?? 100;
        if (ap !== bp) return ap - bp;
        return b.total - a.total;
      });

    const perOperator = userIds
      .map((userId) => {
        const agg = perOperatorMap.get(userId)!;
        return {
          userId,
          userEmail: userEmailById.get(userId) ?? `user#${userId}`,
          total: agg.total,
          agreed: agg.agreed,
          agreementPercent: agreementPercent(agg.agreed, agg.total),
        };
      })
      .sort((a, b) => {
        const ap = a.agreementPercent ?? 100;
        const bp = b.agreementPercent ?? 100;
        if (ap !== bp) return ap - bp;
        return b.total - a.total;
      });

    res.json({
      windowDays: days,
      overall: {
        total: overallTotal,
        agreed: overallAgreed,
        agreementPercent: agreementPercent(overallAgreed, overallTotal),
      },
      perArea,
      perOperator,
    });
  },
);

export default router;
