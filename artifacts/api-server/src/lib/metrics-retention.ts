import { lt } from "drizzle-orm";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { logger } from "./logger.js";

/**
 * How many days of `ai_scoring_metrics` rows we keep on disk. The dashboard's
 * AI-reliability panel only ever reads aggregates over the last 24h / 7d, so
 * anything older is dead weight. Keep a comfortable buffer above 7d so a
 * widened window or a manual investigation still has data to look at.
 */
export const AI_SCORING_METRICS_RETENTION_DAYS = 30;

/** Daily cadence — once per 24h is plenty given the table is append-only. */
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete rows older than the retention window. Returns the row count that was
 * deleted (best-effort: pg may not report it for some configurations, in which
 * case we report 0). Errors are logged and swallowed so a transient DB blip
 * doesn't crash the recurring scheduler.
 */
export async function runMetricsRetentionSweep(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - AI_SCORING_METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  try {
    // Use the driver's rowCount instead of `.returning({ id })` so a large
    // backlog (e.g. the very first sweep on a long-running deployment) doesn't
    // pull every deleted row's id back into Node memory just to count them.
    const result = await db
      .delete(aiScoringMetricsTable)
      .where(lt(aiScoringMetricsTable.createdAt, cutoff));
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info(
        {
          deleted,
          retentionDays: AI_SCORING_METRICS_RETENTION_DAYS,
          cutoff: cutoff.toISOString(),
        },
        "ai_scoring_metrics: pruned rows older than retention window",
      );
    }
    return deleted;
  } catch (err) {
    logger.error(
      { err, cutoff: cutoff.toISOString() },
      "ai_scoring_metrics: retention sweep failed",
    );
    return 0;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start a daily background sweep. Also runs one sweep right away so a freshly
 * deployed server prunes any backlog without waiting 24h. Safe to call more
 * than once — subsequent calls are no-ops while a timer is already running.
 */
export function startMetricsRetentionScheduler(
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): () => void {
  if (timer) return stopMetricsRetentionScheduler;

  logger.info(
    {
      retentionDays: AI_SCORING_METRICS_RETENTION_DAYS,
      intervalMs,
    },
    "ai_scoring_metrics: retention scheduler started",
  );

  // Kick off an immediate sweep so we don't wait 24h after a deploy to prune.
  // Fire-and-forget — `runMetricsRetentionSweep` already swallows errors.
  void runMetricsRetentionSweep();

  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runMetricsRetentionSweep()
      .catch((err) =>
        logger.error({ err }, "ai_scoring_metrics: scheduled sweep crashed"),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Don't keep the process alive purely for this timer (lets tests exit cleanly).
  if (typeof timer.unref === "function") timer.unref();

  return stopMetricsRetentionScheduler;
}

export function stopMetricsRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
