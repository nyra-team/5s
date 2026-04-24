import { and, eq, lt, or, sql } from "drizzle-orm";
import { db, escalationsTable, areasTable, usersTable } from "@workspace/db";
import { logger } from "./logger.js";
import { notifyEscalationReping } from "./notifications.js";

interface RepingConfig {
  thresholdMinutes: number;
  maxRepings: number;
  checkIntervalMs: number;
}

function readConfig(): RepingConfig {
  const thresholdMinutes = parsePositiveInt(
    process.env.ESCALATION_REPING_THRESHOLD_MINUTES,
    15,
  );
  const maxRepings = parseNonNegativeInt(
    process.env.ESCALATION_REPING_MAX_COUNT,
    2,
  );
  const checkIntervalMs = parsePositiveInt(
    process.env.ESCALATION_REPING_CHECK_INTERVAL_MS,
    60_000,
  );
  return { thresholdMinutes, maxRepings, checkIntervalMs };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Find escalations that are still OPEN, have not exceeded the re-ping cap, and
 * whose most recent activity (createdAt or lastRepingAt) is older than the
 * configured threshold. Returns rows joined with area name + operator email so
 * we can build the notification payload without an extra query.
 */
async function findRepingCandidates(config: RepingConfig, now: Date) {
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
  const config = readConfig();
  if (config.maxRepings === 0) return 0;

  let rows: Awaited<ReturnType<typeof findRepingCandidates>>;
  try {
    rows = await findRepingCandidates(config, now);
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
        maxAttempts: config.maxRepings,
      },
    ).catch((err) =>
      logger.error({ err, escalationId: row.id }, "reping: notify failed"),
    );

    dispatched += 1;
    logger.info(
      { escalationId: row.id, ageMinutes, attempt: nextAttempt, maxAttempts: config.maxRepings },
      "reping: re-notified managers",
    );
  }

  return dispatched;
}

let timer: NodeJS.Timeout | null = null;

export function startRepingScheduler(): () => void {
  if (timer) return stopRepingScheduler;
  const config = readConfig();
  if (config.maxRepings === 0) {
    logger.info("reping: scheduler disabled (ESCALATION_REPING_MAX_COUNT=0)");
    return () => {};
  }

  logger.info(
    {
      thresholdMinutes: config.thresholdMinutes,
      maxRepings: config.maxRepings,
      checkIntervalMs: config.checkIntervalMs,
    },
    "reping: scheduler started",
  );

  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runRepingSweep()
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
}
