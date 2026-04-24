import { count, gte, sql } from "drizzle-orm";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { notifyAiRetrySpike } from "./notifications.js";

// Default monitoring config. The AI scoring pipeline retries every VLM call
// whose first response fails JSON validation, doubling our per-audit cost
// while it does so. The dashboard already shows the retry rate; this module
// proactively pings managers when it crosses the "misbehaving" threshold so
// they don't have to discover it themselves.
const DEFAULT_THRESHOLD = 0.15; // 15% — same threshold the dashboard chip uses
const DEFAULT_MIN_SAMPLE = 20; // need at least N calls before alerting (avoid 1/2 = 50% panic)
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // recent rolling window: last 1 hour
const DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // suppress repeat alerts for 4h
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // sweep hourly

export interface AiRetryStats {
  totalCalls: number;
  retriedCalls: number;
  /** retriedCalls / totalCalls (0 when totalCalls = 0). */
  retryRate: number;
}

export interface RetrySpikeConfig {
  threshold: number;
  minSample: number;
  windowMs: number;
  cooldownMs: number;
  checkIntervalMs: number;
}

export interface RetrySpikeDecision {
  shouldAlert: boolean;
  /**
   * Why the decision was made. Useful for logging without re-deriving the
   * predicate at the log site. "ALERT" means we should fire; everything else
   * is a suppression reason.
   */
  reason:
    | "ALERT"
    | "BELOW_THRESHOLD"
    | "INSUFFICIENT_SAMPLE"
    | "IN_COOLDOWN";
}

/**
 * Pure helper for the dashboard endpoint and the spike monitor: count rows
 * in [since, now] and split into retried vs. clean. The metrics table is
 * append-only and indexed on `created_at` so this scans a single b-tree
 * range; the SUM(CASE …) collapses the second pass into the same row.
 *
 * Exported so `routes/dashboard.ts` and the monitor share one query and
 * can't drift apart on future schema changes.
 */
export async function computeRetryStatsSince(since: Date): Promise<AiRetryStats> {
  const [row] = await db
    .select({
      totalCalls: count(),
      retriedCalls: sql<number>`COALESCE(SUM(CASE WHEN ${aiScoringMetricsTable.retried} THEN 1 ELSE 0 END), 0)`,
    })
    .from(aiScoringMetricsTable)
    .where(gte(aiScoringMetricsTable.createdAt, since));

  const totalCalls = Number(row?.totalCalls ?? 0);
  const retriedCalls = Number(row?.retriedCalls ?? 0);
  const retryRate = totalCalls > 0 ? retriedCalls / totalCalls : 0;
  return { totalCalls, retriedCalls, retryRate };
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parsePositiveNumber(raw, fallback);
  return Math.floor(n);
}

function parseUnitInterval(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return fallback;
  return n;
}

export function readRetrySpikeConfig(): RetrySpikeConfig {
  return {
    threshold: parseUnitInterval(process.env.AI_RETRY_ALERT_THRESHOLD, DEFAULT_THRESHOLD),
    minSample: parsePositiveInt(process.env.AI_RETRY_ALERT_MIN_SAMPLE, DEFAULT_MIN_SAMPLE),
    windowMs: parsePositiveInt(process.env.AI_RETRY_ALERT_WINDOW_MS, DEFAULT_WINDOW_MS),
    cooldownMs: parsePositiveInt(process.env.AI_RETRY_ALERT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
    checkIntervalMs: parsePositiveInt(
      process.env.AI_RETRY_ALERT_CHECK_INTERVAL_MS,
      DEFAULT_CHECK_INTERVAL_MS,
    ),
  };
}

/**
 * Pure decision function — given the current stats, the last alert time
 * (if any), and `now`, decide whether to fire a fresh alert. Three things
 * suppress an alert:
 *   1. Sample too small — a 50% rate over 2 calls is not signal.
 *   2. Rate below the misbehaving threshold.
 *   3. Cooldown still active — we already pinged managers; one alert per
 *      incident, not one per sweep.
 *
 * Cooldown is interval-based, not edge-based: as long as the rate stays
 * elevated we re-alert every `cooldownMs` so managers know it never
 * recovered. If the rate dips and comes back later, we re-alert as soon
 * as the window expires too. (Edge detection would require persistent
 * "last seen below" state we deliberately don't keep.)
 */
export function evaluateRetrySpike(
  stats: AiRetryStats,
  config: RetrySpikeConfig,
  lastAlertAt: Date | null,
  now: Date,
): RetrySpikeDecision {
  if (stats.totalCalls < config.minSample) {
    return { shouldAlert: false, reason: "INSUFFICIENT_SAMPLE" };
  }
  if (stats.retryRate < config.threshold) {
    return { shouldAlert: false, reason: "BELOW_THRESHOLD" };
  }
  if (lastAlertAt && now.getTime() - lastAlertAt.getTime() < config.cooldownMs) {
    return { shouldAlert: false, reason: "IN_COOLDOWN" };
  }
  return { shouldAlert: true, reason: "ALERT" };
}

// In-memory cooldown state. A process restart resets this — the worst case
// is one extra alert per restart while the rate is elevated, which is much
// better than persisting a new schema for one boolean. Documented in the
// task brief and acceptable for a once-per-incident-with-cooldown design.
let lastAlertAt: Date | null = null;

/** Test seam: reset the in-memory cooldown timer. */
export function resetRetrySpikeStateForTesting(): void {
  lastAlertAt = null;
}

/** Test seam: read the current in-memory cooldown timer. */
export function getLastAlertAtForTesting(): Date | null {
  return lastAlertAt;
}

export interface RetrySpikeRunResult {
  stats: AiRetryStats;
  decision: RetrySpikeDecision;
  /** True iff the notifier was invoked (mirrors decision.shouldAlert). */
  alerted: boolean;
}

/**
 * One sweep tick: compute the recent retry stats, decide whether to alert,
 * and (if so) ask the notifications module to dispatch. Returns the
 * computed values for tests + log lines. Failures inside the notifier are
 * swallowed and logged so a flaky provider doesn't crash the scheduler.
 */
export async function runRetrySpikeCheck(
  now: Date = new Date(),
): Promise<RetrySpikeRunResult> {
  const config = readRetrySpikeConfig();
  const since = new Date(now.getTime() - config.windowMs);

  let stats: AiRetryStats;
  try {
    stats = await computeRetryStatsSince(since);
  } catch (err) {
    logger.error({ err }, "ai-retry-monitor: failed to compute stats");
    return {
      stats: { totalCalls: 0, retriedCalls: 0, retryRate: 0 },
      decision: { shouldAlert: false, reason: "INSUFFICIENT_SAMPLE" },
      alerted: false,
    };
  }

  const decision = evaluateRetrySpike(stats, config, lastAlertAt, now);
  if (!decision.shouldAlert) {
    logger.info(
      {
        totalCalls: stats.totalCalls,
        retriedCalls: stats.retriedCalls,
        retryRate: stats.retryRate,
        threshold: config.threshold,
        reason: decision.reason,
      },
      "ai-retry-monitor: no alert this tick",
    );
    return { stats, decision, alerted: false };
  }

  // Stamp the cooldown BEFORE awaiting dispatch so a long-running notifier
  // (or a notifier crash) can't cause a sibling tick to fire a duplicate
  // alert. If dispatch later throws we still consume the cooldown — the
  // alternative (re-alerting on every sweep until provider recovers) is
  // strictly worse for managers.
  lastAlertAt = now;

  try {
    await notifyAiRetrySpike({
      retryRate: stats.retryRate,
      retriedCalls: stats.retriedCalls,
      totalCalls: stats.totalCalls,
      thresholdRate: config.threshold,
      windowMs: config.windowMs,
    });
    logger.warn(
      {
        totalCalls: stats.totalCalls,
        retriedCalls: stats.retriedCalls,
        retryRate: stats.retryRate,
        threshold: config.threshold,
      },
      "ai-retry-monitor: retry rate above threshold — managers alerted",
    );
  } catch (err) {
    logger.error(
      { err, retryRate: stats.retryRate },
      "ai-retry-monitor: notifier crashed (cooldown still consumed to avoid spam)",
    );
  }

  return { stats, decision, alerted: true };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Background sweep — re-evaluates the retry rate every `checkIntervalMs`.
 * Designed as a long-lived setInterval (no overlap guard needed at the
 * default cadence — a single read of the metrics table is well under a
 * second — but we still guard for safety). Returns a stop function so tests
 * and graceful shutdown can tear it down deterministically.
 */
export function startAiReliabilityMonitor(): () => void {
  if (timer) return stopAiReliabilityMonitor;
  const config = readRetrySpikeConfig();

  logger.info(
    {
      threshold: config.threshold,
      minSample: config.minSample,
      windowMs: config.windowMs,
      cooldownMs: config.cooldownMs,
      checkIntervalMs: config.checkIntervalMs,
    },
    "ai-retry-monitor: scheduler started",
  );

  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runRetrySpikeCheck()
      .catch((err) => logger.error({ err }, "ai-retry-monitor: sweep crashed"))
      .finally(() => {
        running = false;
      });
  }, config.checkIntervalMs);
  // Don't keep the process alive purely for this timer (lets tests exit cleanly).
  if (typeof timer.unref === "function") timer.unref();

  return stopAiReliabilityMonitor;
}

export function stopAiReliabilityMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
