import { logger } from "./logger.js";
import {
  countBackfillReasoningRemaining,
  runBackfillReasoningBatch,
  type BackfillSummary,
} from "./backfill-reasoning.js";

/**
 * Nightly drain of the AI-explanation backfill queue.
 *
 * The companion admin endpoint (`POST /api/admin/backfill-reasoning`) is a
 * one-shot manual trigger; this scheduler picks off a small batch each night
 * during quiet hours so the legacy queue gradually drains without manager
 * intervention. We follow the same shape as `reping-scheduler.ts`: a polling
 * timer fires `runBackfillReasoningTick` periodically, and the tick decides
 * whether the current moment is inside the quiet-hours window AND whether we
 * have already run for *this* window. Once-per-window state is held in module
 * memory only — a server restart inside the window can produce a second run,
 * which is harmless because the underlying SQL is idempotent (only rows where
 * `aiReasoningJson IS NULL` are touched, with a guarded UPDATE).
 *
 * Configuration is environment-driven so the cadence can be tuned without a
 * redeploy:
 *
 *   BACKFILL_REASONING_ENABLED              "true" | "false"  (default true)
 *   BACKFILL_REASONING_BATCH_SIZE           positive int      (default 25, cap 100)
 *   BACKFILL_REASONING_QUIET_START_HOUR_UTC 0..23             (default 7  = ~02:00 ET)
 *   BACKFILL_REASONING_QUIET_END_HOUR_UTC   0..23             (default 11 = ~06:00 ET)
 *   BACKFILL_REASONING_CHECK_INTERVAL_MS    positive int      (default 5 minutes)
 *
 * Quiet-hours wrap-around is supported (e.g. start=22, end=5 → 22:00..05:00
 * UTC). Hours are interpreted in UTC because the API server has no concept of
 * the facility's local timezone — this is a system-wide drain, not a per-user
 * notification window.
 */

export interface BackfillSchedulerConfig {
  enabled: boolean;
  batchSize: number;
  quietStartHourUtc: number;
  quietEndHourUtc: number;
  checkIntervalMs: number;
}

const DEFAULTS: BackfillSchedulerConfig = {
  enabled: true,
  batchSize: 25,
  quietStartHourUtc: 7,
  quietEndHourUtc: 11,
  checkIntervalMs: 5 * 60_000,
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseHour(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
  return Math.floor(n);
}

export function readBackfillSchedulerConfig(): BackfillSchedulerConfig {
  const batch = parsePositiveInt(
    process.env.BACKFILL_REASONING_BATCH_SIZE,
    DEFAULTS.batchSize,
  );
  return {
    enabled: parseBool(process.env.BACKFILL_REASONING_ENABLED, DEFAULTS.enabled),
    // Cap at 100 to match the manual endpoint's MAX_BATCH_LIMIT.
    batchSize: Math.min(100, batch),
    quietStartHourUtc: parseHour(
      process.env.BACKFILL_REASONING_QUIET_START_HOUR_UTC,
      DEFAULTS.quietStartHourUtc,
    ),
    quietEndHourUtc: parseHour(
      process.env.BACKFILL_REASONING_QUIET_END_HOUR_UTC,
      DEFAULTS.quietEndHourUtc,
    ),
    checkIntervalMs: parsePositiveInt(
      process.env.BACKFILL_REASONING_CHECK_INTERVAL_MS,
      DEFAULTS.checkIntervalMs,
    ),
  };
}

/**
 * True when `now`'s UTC hour is inside [start, end). Wrap-around (start > end)
 * is supported so e.g. 22→5 means "22:00..04:59 UTC". start === end is
 * treated as an empty window (never active) to avoid an "always on" footgun.
 */
export function isInQuietHoursUtc(
  now: Date,
  startHourUtc: number,
  endHourUtc: number,
): boolean {
  if (startHourUtc === endHourUtc) return false;
  const h = now.getUTCHours();
  if (startHourUtc < endHourUtc) {
    return h >= startHourUtc && h < endHourUtc;
  }
  // Wrap-around window.
  return h >= startHourUtc || h < endHourUtc;
}

/**
 * Stable identifier for the quiet-hours window that contains `now` (or null
 * if `now` is outside the window). We use this as a "have we already run
 * this window?" key so a 5-minute polling interval doesn't fire the batch
 * over and over again until the window closes. The key is the UTC date of
 * the window's *start*, so a wrap-around window started "yesterday" still
 * shares one key with its early-morning continuation today.
 */
export function quietHoursWindowKey(
  now: Date,
  startHourUtc: number,
  endHourUtc: number,
): string | null {
  if (!isInQuietHoursUtc(now, startHourUtc, endHourUtc)) return null;
  // For a wrap-around window we are in the "next day" half whenever the
  // current UTC hour is below endHourUtc (i.e. before the window closes
  // tomorrow morning). Roll back one day to keep the key stable.
  const isWrap = startHourUtc > endHourUtc;
  const inMorningHalf = isWrap && now.getUTCHours() < endHourUtc;
  const startDay = new Date(now);
  if (inMorningHalf) startDay.setUTCDate(startDay.getUTCDate() - 1);
  const y = startDay.getUTCFullYear();
  const m = String(startDay.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startDay.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface TickResult {
  ran: boolean;
  reason: "disabled" | "outside_quiet_hours" | "already_ran_window" | "ran";
  summary?: BackfillSummary;
  remaining?: number;
  windowKey?: string;
}

// Module-scoped state: which window we have already drained. Persisted only
// in memory by design — see file-level comment.
let lastDrainedWindowKey: string | null = null;

/** Test-only: forget that we already ran this window. */
export function resetBackfillSchedulerStateForTesting(): void {
  lastDrainedWindowKey = null;
}

/**
 * Decide whether to run the backfill batch right now and, if so, run it
 * exactly once per quiet-hours window. Returns a structured result so callers
 * (and tests) can inspect why a tick did or did not fire.
 *
 * Pass an explicit `now` for deterministic tests; otherwise the wall clock
 * is used. Configuration is read fresh on every tick so an env override can
 * take effect without restarting the process.
 */
export async function runBackfillReasoningTick(
  now: Date = new Date(),
  config: BackfillSchedulerConfig = readBackfillSchedulerConfig(),
): Promise<TickResult> {
  if (!config.enabled) {
    return { ran: false, reason: "disabled" };
  }

  const windowKey = quietHoursWindowKey(
    now,
    config.quietStartHourUtc,
    config.quietEndHourUtc,
  );
  if (windowKey === null) {
    return { ran: false, reason: "outside_quiet_hours" };
  }
  if (windowKey === lastDrainedWindowKey) {
    return { ran: false, reason: "already_ran_window", windowKey };
  }

  // Mark *before* awaiting so two overlapping ticks can't both decide to run.
  // If the run itself throws we still treat the window as drained for this
  // process — better to wait for tomorrow than to retry on every tick and
  // hammer the VLM with the same failing input.
  lastDrainedWindowKey = windowKey;

  let summary: BackfillSummary;
  try {
    summary = await runBackfillReasoningBatch({ limit: config.batchSize });
  } catch (err) {
    logger.error({ err, windowKey }, "backfill-reasoning: batch crashed");
    return { ran: true, reason: "ran", windowKey };
  }

  let remaining: number | undefined;
  try {
    remaining = await countBackfillReasoningRemaining();
  } catch (err) {
    logger.error(
      { err, windowKey },
      "backfill-reasoning: failed to count remaining",
    );
  }

  if (summary.scanned === 0) {
    logger.info(
      { windowKey, remaining: remaining ?? 0 },
      "backfill-reasoning: queue empty, nothing to do",
    );
  } else {
    logger.info(
      {
        windowKey,
        scanned: summary.scanned,
        updated: summary.updated,
        missingMedia: summary.missingMedia,
        scoringFailed: summary.scoringFailed,
        remaining,
      },
      "backfill-reasoning: nightly batch complete",
    );
  }

  return { ran: true, reason: "ran", summary, remaining, windowKey };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startBackfillReasoningScheduler(): () => void {
  if (timer) return stopBackfillReasoningScheduler;
  const config = readBackfillSchedulerConfig();
  if (!config.enabled) {
    logger.info(
      "backfill-reasoning: scheduler disabled (BACKFILL_REASONING_ENABLED=false)",
    );
    return () => {};
  }

  logger.info(
    {
      batchSize: config.batchSize,
      quietStartHourUtc: config.quietStartHourUtc,
      quietEndHourUtc: config.quietEndHourUtc,
      checkIntervalMs: config.checkIntervalMs,
    },
    "backfill-reasoning: scheduler started",
  );

  timer = setInterval(() => {
    if (running) return;
    running = true;
    runBackfillReasoningTick()
      .catch((err) =>
        logger.error({ err }, "backfill-reasoning: tick crashed"),
      )
      .finally(() => {
        running = false;
      });
  }, config.checkIntervalMs);
  // Don't keep the process alive purely for this timer (lets tests exit cleanly).
  if (typeof timer.unref === "function") timer.unref();

  return stopBackfillReasoningScheduler;
}

export function stopBackfillReasoningScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
