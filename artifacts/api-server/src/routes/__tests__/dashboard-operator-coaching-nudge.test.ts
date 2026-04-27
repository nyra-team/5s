import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray, and, gte } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  nudgesTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// Exercises POST /api/dashboard/operator-coaching-nudge — the manager-facing
// "Send reminder" action on the operator-dismiss panel. The endpoint:
//   1. picks the operator's most-dismissed area in the configured window
//   2. drops a fresh shift-scoped, area-only nudge (with a default or
//      manager-supplied message)
//   3. throttles a second send for the same (area, shift) within an hour so
//      double-taps / two managers acting at once don't pile reminders on the
//      operator. The throttle response carries lastSentAt so the UI can
//      render "reminded N min ago" without a separate fetch.

const RUN_TAG = `coaching-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let lonelyOperatorId: number;
let topArea: { id: number; name: string };
let secondaryArea: { id: number; name: string };
let managerToken: string;

beforeAll(async () => {
  const [m] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = m.id;

  const [op] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorId = op.id;

  const [lonely] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-lonely@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  lonelyOperatorId = lonely.id;

  const [a1] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-top-area` })
    .returning();
  topArea = { id: a1.id, name: a1.name };

  const [a2] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-secondary-area` })
    .returning();
  secondaryArea = { id: a2.id, name: a2.name };

  managerToken = signToken({ userId: managerId, role: "MANAGER" });

  // Operator has 3 dismisses in topArea + 1 in secondaryArea over the last
  // 2 days. The endpoint must pick topArea (highest count) regardless of
  // recency.
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3600 * 1000);
  const twoDaysAgo = new Date(now - 2 * 24 * 3600 * 1000);

  async function dismissedNudge(areaId: number, dismissedAt: Date) {
    // Pin createdAt to the dismissal time so the fixture rows look like
    // genuine historical nudges. If we let createdAt default to "now", every
    // fixture row falls inside the route's 1-hour throttle window for shift
    // "A" — and when the current shift happens to be A, the very first
    // POST under test trips the throttle on its OWN seed data, returning
    // 429 instead of 201 (a flaky time-of-day failure).
    const [row] = await db
      .insert(nudgesTable)
      .values({
        areaId,
        machine: null,
        shift: "A",
        message: null,
        createdByUserId: managerId,
        createdAt: dismissedAt,
      })
      .returning({ id: nudgesTable.id });
    await db
      .update(nudgesTable)
      .set({
        dismissedAt,
        dismissedByUserId: operatorId,
        dismissReason: "OPERATOR_DISMISS",
      })
      .where(eq(nudgesTable.id, row.id));
  }

  await dismissedNudge(topArea.id, twoDaysAgo);
  await dismissedNudge(topArea.id, dayAgo);
  await dismissedNudge(topArea.id, new Date(now - 3 * 3600 * 1000));
  await dismissedNudge(secondaryArea.id, dayAgo);
});

afterAll(async () => {
  await db
    .delete(nudgesTable)
    .where(inArray(nudgesTable.areaId, [topArea.id, secondaryArea.id]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [topArea.id, secondaryArea.id]));
  await db
    .delete(usersTable)
    .where(
      inArray(usersTable.id, [managerId, operatorId, lonelyOperatorId]),
    );
  await pool.end();
});

describe("POST /api/dashboard/operator-coaching-nudge", () => {
  it("creates a fresh nudge on the operator's most-dismissed area with the manager's message", async () => {
    const sentAtFloor = new Date();
    const res = await request(app)
      .post("/api/dashboard/operator-coaching-nudge")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        operatorId,
        days: 7,
        message: "Please run a fresh walk-through this shift.",
      });

    expect(res.status).toBe(201);
    expect(res.body.targetOperatorId).toBe(operatorId);
    // Most-dismissed in window is topArea (3 vs 1).
    expect(res.body.targetAreaId).toBe(topArea.id);
    expect(res.body.targetAreaName).toBe(topArea.name);
    expect(res.body.targetShift).toMatch(/^[ABC]$/);
    expect(typeof res.body.sentAt).toBe("string");
    expect(new Date(res.body.sentAt).getTime()).toBeGreaterThanOrEqual(
      sentAtFloor.getTime() - 1000,
    );
    expect(res.body.nudge).toBeDefined();
    expect(res.body.nudge.areaId).toBe(topArea.id);
    expect(res.body.nudge.machine).toBeNull();
    expect(res.body.nudge.message).toBe(
      "Please run a fresh walk-through this shift.",
    );
    expect(res.body.nudge.createdByEmail).toBe(`${RUN_TAG}-mgr@test.local`);

    // The route actually inserted a row into the nudges table.
    const created = await db
      .select({ id: nudgesTable.id, message: nudgesTable.message })
      .from(nudgesTable)
      .where(eq(nudgesTable.id, res.body.nudge.id));
    expect(created).toHaveLength(1);
    expect(created[0].message).toBe(
      "Please run a fresh walk-through this shift.",
    );
  });

  it("throttles a second send within the hour and surfaces lastSentAt for the UI badge", async () => {
    // The first test in this file already created a coaching nudge for this
    // operator+topArea on the current shift, so a follow-up POST must trip
    // the throttle. Snapshot the row count beforehand so we can assert the
    // throttled call did not insert a duplicate (the fixture rows live in
    // the same table so a raw COUNT isn't useful — capture the delta).
    const before = await db
      .select({ id: nudgesTable.id })
      .from(nudgesTable)
      .where(eq(nudgesTable.areaId, topArea.id));
    const beforeCount = before.length;

    const res = await request(app)
      .post("/api/dashboard/operator-coaching-nudge")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorId, days: 7 });

    expect(res.status).toBe(429);
    expect(res.body.targetOperatorId).toBe(operatorId);
    expect(res.body.targetAreaId).toBe(topArea.id);
    expect(res.body.targetAreaName).toBe(topArea.name);
    expect(typeof res.body.lastSentAt).toBe("string");
    expect(typeof res.body.nextEligibleAt).toBe("string");
    const lastSent = new Date(res.body.lastSentAt).getTime();
    const nextEligible = new Date(res.body.nextEligibleAt).getTime();
    // nextEligibleAt = lastSentAt + ~1h.
    expect(nextEligible - lastSent).toBeGreaterThan(55 * 60 * 1000);
    expect(nextEligible - lastSent).toBeLessThan(65 * 60 * 1000);

    // The throttled call must not have inserted another row on topArea.
    const after = await db
      .select({ id: nudgesTable.id })
      .from(nudgesTable)
      .where(eq(nudgesTable.areaId, topArea.id));
    expect(after.length).toBe(beforeCount);
  });

  it("falls back to a default coaching message when none is supplied (uses a different operator/area to avoid the throttle)", async () => {
    // Set up a one-off operator+area so this case doesn't collide with the
    // throttled topArea/operator from the earlier tests.
    const [op] = await db
      .insert(usersTable)
      .values({
        email: `${RUN_TAG}-op-default@test.local`,
        passwordHash: "x",
        role: "OPERATOR",
      })
      .returning();
    const [area] = await db
      .insert(areasTable)
      .values({ name: `${RUN_TAG}-default-area` })
      .returning();
    // Backdate both createdAt and dismissedAt so this seed row sits well
    // outside the route's 1-hour throttle window — otherwise a fresh
    // fixture nudge on shift "A" trips the throttle on the very POST we're
    // about to make whenever the current shift happens to be A.
    const seededAt = new Date(Date.now() - 2 * 3600 * 1000);
    const [n] = await db
      .insert(nudgesTable)
      .values({
        areaId: area.id,
        machine: null,
        shift: "A",
        message: null,
        createdByUserId: managerId,
        createdAt: seededAt,
      })
      .returning({ id: nudgesTable.id });
    await db
      .update(nudgesTable)
      .set({
        dismissedAt: seededAt,
        dismissedByUserId: op.id,
        dismissReason: "OPERATOR_DISMISS",
      })
      .where(eq(nudgesTable.id, n.id));

    try {
      const res = await request(app)
        .post("/api/dashboard/operator-coaching-nudge")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ operatorId: op.id, days: 7 });

      expect(res.status).toBe(201);
      expect(res.body.targetAreaId).toBe(area.id);
      // Default message mentions the area name.
      expect(res.body.nudge.message).toContain(area.name);
      expect(res.body.nudge.message).toMatch(/coaching/i);
    } finally {
      await db.delete(nudgesTable).where(eq(nudgesTable.areaId, area.id));
      await db.delete(areasTable).where(eq(areasTable.id, area.id));
      await db.delete(usersTable).where(eq(usersTable.id, op.id));
    }
  });

  it("returns 404 when the operator has no OPERATOR_DISMISS history in the window", async () => {
    const res = await request(app)
      .post("/api/dashboard/operator-coaching-nudge")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorId: lonelyOperatorId, days: 7 });

    expect(res.status).toBe(404);
    expect(typeof res.body.error).toBe("string");
  });

  it("rejects callers who aren't a MANAGER", async () => {
    const operatorToken = signToken({ userId: operatorId, role: "OPERATOR" });
    const res = await request(app)
      .post("/api/dashboard/operator-coaching-nudge")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ operatorId, days: 7 });
    expect(res.status).toBe(403);
  });
});
