import { and, eq, lt, or, sql } from "drizzle-orm";
import { db, escalationsTable, areasTable, usersTable } from "@workspace/db";
import { logger } from "./logger.js";
import { notifyEscalationReping } from "./notifications.js";
import {
  type EffectiveRepingCadence,
  loadEffectiveRepingCadence,
} from "./facility-settings.js";

interface RepingConfig extends EffectiveRepingCadence {
  /**
   * The setInterval cadence remains env-only: changing how often the timer
   * fires would require tearing down and re-arming the JS timer, which is
   * out of scope for "managers tune aggressiveness". Threshold + cap take
   * effect on the *next* sweep tick because they're re-loaded inside
   * `runRepingSweep`.
   */
  checkIntervalMs: number;
  stuckThresholdMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readBootConfig(): RepingConfig {
  // Boot-time read sizes the JS timer + watchdog and is logged once at
  // startup. The sweep itself re-resolves threshold + cap on every tick
  // via `loadEffectiveRepingCadence`, so the threshold/cap fields here
  // are unused placeholders.
  const checkIntervalMs = parsePositiveInt(
    process.env.ESCALATION_REPING_CHECK_INTERVAL_MS,
    60_000,
  );
  // Default to 5x the check interval so a sweep that takes longer than five
  // missed ticks is treated as stuck and surfaces a loud warning. Operators
  // can tighten or loosen this at runtime without a code change.
  const stuckThresholdMs = parsePositiveInt(
    process.env.ESCALATION_REPING_STUCK_THRESHOLD_MS,
    checkIntervalMs * 5,
  );
  return {
    thresholdMinutes: 0,
    maxRepings: 0,
    checkIntervalMs,
    stuckThresholdMs,
  };
}

/**
 * Find escalations that are still OPEN, have not exceeded the re-ping cap, and
 * whose most recent activity (createdAt or lastRepingAt) is older than the
 * configured threshold. Returns rows joined with area name + operator email so
 * we can build the notification payload without an extra query.
 */
async function findRepingCandidates(config: EffectiveRepingCadence, now: Date) {
  const cutoff = new Date(now.getTime() - config.thresholdMinutes * 60_000);

  return db
    .select({
      id: escalationsTable.id,
      submissionId: escalationsTable.submissionId,
      areaId: escalationsTable.areaId,
      areaName: areasTable.name,
      operatorEmail: usersTable.email,
      scorePercent: escalationsTable.scorePercent,
      failingPillarsJson: escalationsTable.failingPillarsJson,
      recommendedActionsJson: escalationsTable.recommendedActionsJson,
      createdAt: escalationsTable.createdAt,
      repingCount: escalationsTable.repingCount,
    })
    .from(escalationsTable)
    .innerJoin(areasTable, eq(escalationsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(escalationsTable.operatorId, usersTable.id))
    .where(
      and(
        eq(escalationsTable.status, "OPEN"),
        lt(escalationsTable.repingCount, config.maxRepings),
        or(
          and(
            sql`${escalationsTable.lastRepingAt} IS NULL`,
            lt(escalationsTable.createdAt, cutoff),
          ),
          lt(escalationsTable.lastRepingAt, cutoff),
        ),
      ),
    );
}

export async function runRepingSweep(now: Date = new Date()): Promise<number> {
  // Re-read the cadence on every tick so manager edits to the
  // `facility_settings` row (threshold + cap) take effect within one sweep
  // — no process restart required. The lookup is a single small select on
  // a singleton table; the env layer is a couple of `process.env` reads.
  let cadence: EffectiveRepingCadence;
  try {
    cadence = await loadEffectiveRepingCadence();
  } catch (err) {
    logger.error({ err }, "reping: failed to load cadence (skipping tick)");
    return 0;
  }
  if (cadence.maxRepings === 0) return 0;

  let rows: Awaited<ReturnType<typeof findRepingCandidates>>;
  try {
    rows = await findRepingCandidates(cadence, now);
  } catch (err) {
    logger.error({ err }, "reping: failed to query candidates");
    return 0;
  }

  if (rows.length === 0) return 0;

  let dispatched = 0;
  for (const row of rows) {
    const nextAttempt = row.repingCount + 1;
    // Atomically claim this re-ping slot. The WHERE guards against:
    //   * status flipping to ACKNOWLEDGED/RESOLVED between query and update
    //   * a parallel sweep (in another process) bumping the counter first
    // If 0 rows are returned we skip this escalation and try again next tick.
    const claimed = await db
      .update(escalationsTable)
      .set({ repingCount: nextAttempt, lastRepingAt: now })
      .where(
        and(
          eq(escalationsTable.id, row.id),
          eq(escalationsTable.status, "OPEN"),
          eq(escalationsTable.repingCount, row.repingCount),
        ),
      )
      .returning({ id: escalationsTable.id });

    if (claimed.length === 0) {
      logger.info(
        { escalationId: row.id },
        "reping: skipped (status changed or already re-pinged)",
      );
      continue;
    }

    const ageMinutes = Math.max(
      1,
      Math.round((now.getTime() - row.createdAt.getTime()) / 60_000),
    );

    void notifyEscalationReping(
      {
        escalationId: row.id,
        submissionId: row.submissionId,
        areaId: row.areaId,
        areaName: row.areaName,
        scorePercent: row.scorePercent,
        failingPillars: (row.failingPillarsJson as string[]) ?? [],
        operatorEmail: row.operatorEmail,
        recommendedActions: (row.recommendedActionsJson as string[]) ?? [],
      },
      {
        ageMinutes,
        attempt: nextAttempt,
        maxAttempts: cadence.maxRepings,
      },
    ).catch((err) =>
      logger.error({ err, escalationId: row.id }, "reping: notify failed"),
    );

    dispatched += 1;
    logger.info(
      { escalationId: row.id, ageMinutes, attempt: nextAttempt, maxAttempts: cadence.maxRepings },
      "reping: re-notified managers",
    );
  }

  return dispatched;
}

/**
 * Snapshot of scheduler liveness exposed for operator visibility. This is
 * deliberately a flat shape so it can be logged or surfaced through a
 * health route without further translation.
 */
export interface RepingSchedulerHealth {
  /** Wall-clock time the scheduler interval was started; null if not running. */
  startedAt: Date | null;
  /** Total ticks the interval has fired (including ones skipped by overlap). */
  ticks: number;
  /** Sweeps that actually began running (i.e. no overlap skip). */
  sweepsStarted: number;
  /** Sweeps that returned successfully. */
  sweepsCompleted: number;
  /** Sweeps that threw before completing. */
  sweepsFailed: number;
  /** Ticks that found a previous sweep still running and bailed out. */
  ticksSkippedByOverlap: number;
  /** Times the watchdog flagged a sweep as stuck. */
  watchdogWarnings: number;
  /** Start time of the in-flight sweep, if one is running right now. */
  currentSweepStartedAt: Date | null;
  /** Start time of the most recently begun sweep (running or finished). */
  lastSweepStartedAt: Date | null;
  /** Completion time of the most recent successful sweep. */
  lastSweepCompletedAt: Date | null;
  /** Duration of the most recent completed sweep, in milliseconds. */
  lastSweepDurationMs: number | null;
  /** Number of escalations dispatched by the most recent completed sweep. */
  lastSweepDispatched: number | null;
  /** Most recent failure summary so operators can see why sweeps are erroring. */
  lastSweepError: { message: string; at: Date } | null;
}

function createInitialHealth(): RepingSchedulerHealth {
  return {
    startedAt: null,
    ticks: 0,
    sweepsStarted: 0,
    sweepsCompleted: 0,
    sweepsFailed: 0,
    ticksSkippedByOverlap: 0,
    watchdogWarnings: 0,
    currentSweepStartedAt: null,
    lastSweepStartedAt: null,
    lastSweepCompletedAt: null,
    lastSweepDurationMs: null,
    lastSweepDispatched: null,
    lastSweepError: null,
  };
}

let health: RepingSchedulerHealth = createInitialHealth();

export function getRepingSchedulerHealth(): Readonly<RepingSchedulerHealth> {
  return { ...health };
}

/**
 * Test seam — node:test cases share a process, so the scheduler's module-level
 * counters need an explicit reset between cases to keep assertions independent.
 */
export function resetRepingSchedulerHealthForTesting(): void {
  health = createInitialHealth();
}

/**
 * Wrap a single sweep in the bookkeeping every operator-visible signal needs:
 * tracks start/finish timestamps, duration, dispatched count, and arms a
 * one-shot watchdog timer that emits a loud warning if the sweep exceeds
 * `stuckThresholdMs`. Exported so tests can exercise the watchdog without
 * standing up the full setInterval loop.
 */
export async function runMonitoredRepingSweep(opts?: {
  stuckThresholdMs?: number;
  now?: Date;
  /**
   * Test-only seam: lets a unit test substitute a slow / hanging inner sweep
   * so the watchdog code path can be exercised deterministically without
   * having to stall the real database.
   */
  runner?: (now?: Date) => Promise<number>;
}): Promise<number> {
  const config = readBootConfig();
  const stuckThresholdMs =
    opts?.stuckThresholdMs ?? config.stuckThresholdMs;
  const runner = opts?.runner ?? runRepingSweep;

  const startedAt = new Date();
  health.sweepsStarted += 1;
  health.currentSweepStartedAt = startedAt;
  health.lastSweepStartedAt = startedAt;

  // One-shot watchdog: if the sweep is still in flight when this fires, the
  // process is most likely blocked on a never-resolving promise (slow notifier,
  // hung DB connection, etc.) and every subsequent tick will be silently
  // skipped by the `running` flag. Make that situation loud.
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    health.watchdogWarnings += 1;
    logger.warn(
      {
        stuckThresholdMs,
        sweepStartedAt: startedAt.toISOString(),
        elapsedMs: Date.now() - startedAt.getTime(),
        lastSweepCompletedAt:
          health.lastSweepCompletedAt?.toISOString() ?? null,
        watchdogWarnings: health.watchdogWarnings,
      },
      "reping: sweep is taking longer than expected — scheduler may be stalled",
    );
  }, stuckThresholdMs);
  // Don't keep the event loop alive solely for the watchdog (matches the
  // unref() on the interval timer below — important for clean test exits).
  if (typeof watchdog.unref === "function") watchdog.unref();

  try {
    const dispatched = await runner(opts?.now);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    health.sweepsCompleted += 1;
    health.lastSweepCompletedAt = completedAt;
    health.lastSweepDurationMs = durationMs;
    health.lastSweepDispatched = dispatched;
    if (watchdogFired) {
      // The watchdog already screamed; emit the matching "recovered" signal
      // so log readers can pair them up and confirm the scheduler unstuck
      // itself rather than being silently restarted.
      logger.warn(
        { durationMs, dispatched, stuckThresholdMs },
        "reping: previously-stuck sweep finally completed",
      );
    } else {
      logger.info(
        { durationMs, dispatched },
        "reping: sweep completed",
      );
    }
    return dispatched;
  } catch (err) {
    health.sweepsFailed += 1;
    health.lastSweepError = {
      message: err instanceof Error ? err.message : String(err),
      at: new Date(),
    };
    throw err;
  } finally {
    clearTimeout(watchdog);
    health.currentSweepStartedAt = null;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startRepingScheduler(opts?: {
  /**
   * Test-only seam: pass through the same `runner` override accepted by
   * `runMonitoredRepingSweep`. Lets a test drive the real interval loop with
   * a controllable inner sweep so overlap behavior can be observed end-to-end.
   */
  runner?: (now?: Date) => Promise<number>;
}): () => void {
  if (timer) return stopRepingScheduler;
  const config = readBootConfig();
  // Note: we no longer short-circuit at boot when the cap is 0 — the cap
  // is now reloaded inside `runRepingSweep`, so a manager later raising it
  // from 0 to e.g. 2 must be able to take effect without a restart. The
  // sweep itself returns early on a cap of 0, so the timer is essentially
  // a no-op until that point.
  health = createInitialHealth();
  health.startedAt = new Date();

  logger.info(
    {
      checkIntervalMs: config.checkIntervalMs,
      stuckThresholdMs: config.stuckThresholdMs,
    },
    "reping: scheduler started (threshold + cap loaded per-tick from facility_settings)",
  );

  let running = false;
  timer = setInterval(() => {
    health.ticks += 1;
    if (running) {
      // Don't silently swallow overlap — operators need to see when sweeps
      // are piling up, which is the early signal that something is hung.
      health.ticksSkippedByOverlap += 1;
      logger.warn(
        {
          ticksSkippedByOverlap: health.ticksSkippedByOverlap,
          currentSweepStartedAt:
            health.currentSweepStartedAt?.toISOString() ?? null,
          elapsedMs: health.currentSweepStartedAt
            ? Date.now() - health.currentSweepStartedAt.getTime()
            : null,
        },
        "reping: skipping tick — previous sweep still running",
      );
      return;
    }
    running = true;
    runMonitoredRepingSweep({
      stuckThresholdMs: config.stuckThresholdMs,
      runner: opts?.runner,
    })
      .catch((err) => logger.error({ err }, "reping: sweep crashed"))
      .finally(() => {
        running = false;
      });
  }, config.checkIntervalMs);
  // Don't keep the process alive purely for this timer (lets tests exit cleanly).
  if (typeof timer.unref === "function") timer.unref();

  return stopRepingScheduler;
}

export function stopRepingScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Clear `startedAt` so a downstream consumer (health route, dashboard, etc.)
  // doesn't keep reporting the scheduler as "running since X" after shutdown.
  health.startedAt = null;
}
