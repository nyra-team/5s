import { db, submissionsTable } from "@workspace/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * Mark stale PENDING submissions as FALLBACK on server startup.
 *
 * A row carries `scoringMode = 'PENDING'` from the moment POST /submissions
 * inserts it until the background scoring task updates it. If the process
 * crashed (or was killed) before that update lands, the row is orphaned —
 * the operator's UI would show "Scoring…" forever. This sweep collapses
 * those orphans into the existing FALLBACK state so the operator's recent
 * strip flips to "couldn't be scored, re-upload" instead of hanging.
 *
 * "Stale" = older than 10 minutes. The normal scoring window is 30-60s, so
 * a 10-minute floor leaves plenty of room for slow VLM calls while still
 * recovering quickly after a crash. Anything newer is assumed to be
 * actively scoring in the current process.
 */
export async function recoverOrphanedPendingSubmissions(): Promise<void> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  try {
    const updated = await db
      .update(submissionsTable)
      .set({ scoringMode: "FALLBACK" })
      .where(
        and(
          eq(sql`coalesce(${submissionsTable.scoringMode}, '')`, sql`'PENDING'`),
          lt(submissionsTable.createdAt, tenMinutesAgo),
        ),
      )
      .returning({ id: submissionsTable.id });
    if (updated.length > 0) {
      logger.warn(
        { count: updated.length, ids: updated.map((r) => r.id) },
        "scoring-recovery: marked stale PENDING submissions as FALLBACK",
      );
    }
  } catch (err) {
    logger.error({ err }, "scoring-recovery: sweep failed");
  }
}
