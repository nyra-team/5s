import { db, escalationsTable } from "@workspace/db";
import { and, isNull, isNotNull, sql } from "drizzle-orm";

// One-off backfill for the `notify_delivery_status` column on
// `escalations`. The column was introduced together with the manager-facing
// "Delivery skipped" badge, so every row that already existed in the
// database when the migration ran has `notify_delivery_status = NULL`. Two
// sub-populations matter for auditing:
//
//   1. Rows the previous startup recovery sweep silently stamped as notified
//      because they were older than the recovery window. These look like
//      successful deliveries in the UI even though no email/Slack was sent.
//   2. Rows that genuinely got dispatched before the column existed.
//
// We can recover the distinction from the timestamps we already have:
// `notified_at - created_at > recoveryWindowMs()` matches the recovery
// sweep's "too old to dispatch" branch, which stamps the row and bails out.
// Everything else is treated as a normal delivery so the badge doesn't
// flash on healthy historical alerts.
//
// Only NULL rows are touched, so the script is safe to re-run; rows the
// real notification path (or a previous backfill) already classified are
// left untouched.

const DEFAULT_RECOVERY_WINDOW_MS = 60 * 60 * 1000;

// Mirrors `recoveryWindowMs()` in
// `artifacts/api-server/src/lib/notifications.ts`. We can't import from the
// api-server artifact (different package), so we duplicate the env-var
// contract here. If you change the env-var name there, update it here too.
function recoveryWindowMs(): number {
  const raw = process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS?.trim();
  if (!raw) return DEFAULT_RECOVERY_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[backfill] invalid ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS=${JSON.stringify(raw)}, falling back to default`,
    );
    return DEFAULT_RECOVERY_WINDOW_MS;
  }
  return Math.floor(parsed);
}

async function backfill() {
  const windowMs = recoveryWindowMs();
  console.log(
    `Backfilling notify_delivery_status (recovery window = ${windowMs} ms)...`,
  );

  // Single SQL UPDATE keyed off NULL so re-runs are no-ops. We classify
  // inline rather than fetching + looping so the whole backfill is one
  // round-trip and atomic from the DB's point of view.
  const result = await db
    .update(escalationsTable)
    .set({
      notifyDeliveryStatus: sql`CASE
        WHEN EXTRACT(EPOCH FROM (${escalationsTable.notifiedAt} - ${escalationsTable.createdAt})) * 1000 > ${windowMs}
          THEN 'SKIPPED_RECOVERY_WINDOW'
        ELSE 'DELIVERED'
      END`,
    })
    .where(
      and(
        isNull(escalationsTable.notifyDeliveryStatus),
        isNotNull(escalationsTable.notifiedAt),
      ),
    )
    .returning({
      id: escalationsTable.id,
      status: escalationsTable.notifyDeliveryStatus,
    });

  const delivered = result.filter((r) => r.status === "DELIVERED").length;
  const skipped = result.filter(
    (r) => r.status === "SKIPPED_RECOVERY_WINDOW",
  ).length;

  console.log(
    `Backfill complete: ${result.length} row(s) updated (${delivered} DELIVERED, ${skipped} SKIPPED_RECOVERY_WINDOW).`,
  );

  // Sanity check: how many rows are still NULL? These are the
  // not-yet-dispatched ones (notified_at IS NULL) that the live recovery
  // sweep will pick up — we deliberately leave them alone.
  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(escalationsTable)
    .where(
      and(
        isNull(escalationsTable.notifyDeliveryStatus),
        isNull(escalationsTable.notifiedAt),
      ),
    );
  console.log(
    `Remaining rows with notify_delivery_status IS NULL (pending dispatch): ${pending?.count ?? 0}`,
  );
}

backfill()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  });
