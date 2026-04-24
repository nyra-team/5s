import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
  escalationsTable,
} from "@workspace/db";
import { recoverPendingEscalationNotifications } from "../notifications";

// Verifies the new "delivery skipped" breadcrumb that the manager UI relies on:
// when the startup recovery sweep gives up on an escalation older than the
// recovery window, the row's `notify_delivery_status` must end up as
// "SKIPPED_RECOVERY_WINDOW" (not just `notified_at = now()` with no signal of
// what happened). Recent rows that get re-dispatched should be tagged
// "DELIVERED" so the badge doesn't flash on healthy alerts.

const RUN_TAG = `recover-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGINAL_RECOVERY_WINDOW = process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS;
const ORIGINAL_GROUPING_WINDOW = process.env.ESCALATION_NOTIFICATION_WINDOW_MS;

let operatorId: number;
let area: { id: number; name: string };
let submissionId: number;
const inserted: number[] = [];

beforeAll(async () => {
  // Pin the recovery window to 1 hour for clarity. Disable grouping so the
  // recovery sweep dispatches recent rows synchronously instead of buffering
  // them past the test's lifetime.
  process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS = String(60 * 60 * 1000);
  process.env.ESCALATION_NOTIFICATION_WINDOW_MS = "0";

  const [u] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  operatorId = u.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area` })
    .returning();
  area = { id: a.id, name: a.name };

  const [sub] = await db
    .insert(submissionsTable)
    .values({
      userId: operatorId,
      areaId: area.id,
      shift: "A",
      scoreTotal: 8,
      scoreJson: { sort: 1, set: 1, shine: 2, standardize: 2, sustain: 2 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}.jpg`,
      mediaType: "image",
    })
    .returning();
  submissionId = sub.id;
});

afterAll(async () => {
  if (inserted.length > 0) {
    await db.delete(escalationsTable).where(inArray(escalationsTable.id, inserted));
  }
  if (submissionId) {
    await db.delete(submissionsTable).where(eq(submissionsTable.id, submissionId));
  }
  if (area?.id) {
    await db.delete(areasTable).where(eq(areasTable.id, area.id));
  }
  if (operatorId) {
    await db.delete(usersTable).where(eq(usersTable.id, operatorId));
  }
  if (ORIGINAL_RECOVERY_WINDOW === undefined) {
    delete process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS;
  } else {
    process.env.ESCALATION_NOTIFICATION_RECOVERY_WINDOW_MS = ORIGINAL_RECOVERY_WINDOW;
  }
  if (ORIGINAL_GROUPING_WINDOW === undefined) {
    delete process.env.ESCALATION_NOTIFICATION_WINDOW_MS;
  } else {
    process.env.ESCALATION_NOTIFICATION_WINDOW_MS = ORIGINAL_GROUPING_WINDOW;
  }
  await pool.end();
});

beforeEach(async () => {
  if (inserted.length > 0) {
    await db.delete(escalationsTable).where(inArray(escalationsTable.id, inserted));
    inserted.length = 0;
  }
});

async function insertEscalation(opts: {
  createdAt: Date;
  scorePercent?: number;
}): Promise<number> {
  const [row] = await db
    .insert(escalationsTable)
    .values({
      submissionId,
      areaId: area.id,
      operatorId,
      scoreTotal: 8,
      scorePercent: opts.scorePercent ?? 32,
      failingPillarsJson: ["sort", "set"],
      recommendedActionsJson: ["Reset workstation", "Re-label bins"],
      evidenceUrlsJson: [],
      status: "OPEN",
      createdAt: opts.createdAt,
    })
    .returning();
  inserted.push(row.id);
  return row.id;
}

describe("recoverPendingEscalationNotifications — delivery status", () => {
  it("stamps SKIPPED_RECOVERY_WINDOW on rows older than the recovery window", async () => {
    const tooOldId = await insertEscalation({
      // 2 hours ago — comfortably past the 1-hour recovery window.
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    await recoverPendingEscalationNotifications();

    const [row] = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, tooOldId));

    expect(row.notifiedAt).not.toBeNull();
    expect(row.notifyDeliveryStatus).toBe("SKIPPED_RECOVERY_WINDOW");
  });

  it("stamps DELIVERED on rows still inside the recovery window", async () => {
    const recentId = await insertEscalation({
      // 5 minutes ago — well inside the 1-hour recovery window, so the sweep
      // should re-dispatch (and stamp DELIVERED) rather than skip.
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    await recoverPendingEscalationNotifications();

    const [row] = await db
      .select({
        notifiedAt: escalationsTable.notifiedAt,
        notifyDeliveryStatus: escalationsTable.notifyDeliveryStatus,
      })
      .from(escalationsTable)
      .where(eq(escalationsTable.id, recentId));

    expect(row.notifiedAt).not.toBeNull();
    expect(row.notifyDeliveryStatus).toBe("DELIVERED");
  });
});
