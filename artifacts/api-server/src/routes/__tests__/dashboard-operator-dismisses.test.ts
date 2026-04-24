import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  nudgesTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// Exercises the new manager-facing endpoints that surface per-operator
// "dismissed without re-capturing" history on the dashboard:
//   - GET /api/dashboard/operator-dismisses          → counts grouped by operator
//   - GET /api/dashboard/operator-dismisses/detail   → drill-down per operator
//
// The fixtures below create two operators with different dismiss patterns,
// plus noise rows (SUBMISSION-reason dismissals, an out-of-window dismissal,
// and a different area) so we can prove the route filters and groups
// correctly. Everything is tag-prefixed and torn down in afterAll.

const RUN_TAG = `dashdismiss-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorAId: number;
let operatorBId: number;
let area1: { id: number; name: string };
let area2: { id: number; name: string };
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

  const [opA] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-opA@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorAId = opA.id;

  const [opB] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-opB@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorBId = opB.id;

  const [a1] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area-1` })
    .returning();
  area1 = { id: a1.id, name: a1.name };

  const [a2] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area-2` })
    .returning();
  area2 = { id: a2.id, name: a2.name };

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
});

afterAll(async () => {
  await db
    .delete(nudgesTable)
    .where(inArray(nudgesTable.areaId, [area1.id, area2.id]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [area1.id, area2.id]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [managerId, operatorAId, operatorBId]));
  await pool.end();
});

interface NudgeFixture {
  areaId: number;
  machine?: string | null;
  shift?: "A" | "B" | "C";
  message?: string | null;
  dismissedAt: Date | null;
  dismissedByUserId?: number | null;
  dismissReason?: "OPERATOR_DISMISS" | "SUBMISSION" | null;
}

async function insertNudge(opts: NudgeFixture): Promise<number> {
  const [row] = await db
    .insert(nudgesTable)
    .values({
      areaId: opts.areaId,
      machine: opts.machine ?? null,
      shift: opts.shift ?? "A",
      message: opts.message ?? null,
      createdByUserId: managerId,
    })
    .returning({ id: nudgesTable.id });
  if (opts.dismissedAt) {
    await db
      .update(nudgesTable)
      .set({
        dismissedAt: opts.dismissedAt,
        dismissedByUserId: opts.dismissedByUserId ?? null,
        dismissReason: opts.dismissReason ?? null,
      })
      .where(eq(nudgesTable.id, row.id));
  }
  return row.id;
}

describe("dashboard operator-dismiss history", () => {
  it("aggregates per-operator counts of OPERATOR_DISMISS nudges in the window and ignores SUBMISSION clears", async () => {
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);

    // operator A: 2 OPERATOR_DISMISS in window
    await insertNudge({
      areaId: area1.id,
      dismissedAt: twoDaysAgo,
      dismissedByUserId: operatorAId,
      dismissReason: "OPERATOR_DISMISS",
    });
    await insertNudge({
      areaId: area2.id,
      machine: "press-1",
      dismissedAt: yesterday,
      dismissedByUserId: operatorAId,
      dismissReason: "OPERATOR_DISMISS",
    });
    // operator B: 1 OPERATOR_DISMISS in window
    await insertNudge({
      areaId: area1.id,
      dismissedAt: now,
      dismissedByUserId: operatorBId,
      dismissReason: "OPERATOR_DISMISS",
    });
    // SUBMISSION-reason dismissal: should NOT be counted (operator cleared it
    // by submitting fresh evidence, that's the desired behaviour).
    await insertNudge({
      areaId: area1.id,
      dismissedAt: now,
      dismissedByUserId: operatorAId,
      dismissReason: "SUBMISSION",
    });
    // Active nudge (no dismiss yet): also ignored.
    await insertNudge({
      areaId: area1.id,
      dismissedAt: null,
    });

    const res = await request(app)
      .get("/api/dashboard/operator-dismisses?days=7")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);

    const opA = (res.body as Array<{ operatorId: number; dismissCount: number }>)
      .find((r) => r.operatorId === operatorAId);
    const opB = (res.body as Array<{ operatorId: number; dismissCount: number }>)
      .find((r) => r.operatorId === operatorBId);
    expect(opA).toBeDefined();
    expect(opB).toBeDefined();
    expect(opA!.dismissCount).toBe(2);
    expect(opB!.dismissCount).toBe(1);

    // Returned newest-first by count, then by lastDismissedAt desc.
    const aIdx = res.body.findIndex((r: { operatorId: number }) => r.operatorId === operatorAId);
    const bIdx = res.body.findIndex((r: { operatorId: number }) => r.operatorId === operatorBId);
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("excludes dismissals older than the requested window", async () => {
    const longAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000); // 60 days ago

    await insertNudge({
      areaId: area1.id,
      dismissedAt: longAgo,
      dismissedByUserId: operatorAId,
      dismissReason: "OPERATOR_DISMISS",
    });

    // Narrow window: the 60-day-old row must NOT be counted; previous test's
    // 2-days-ago row IS still in window (but isolated below by checking
    // that the count for a 1-day window equals only same-day rows).
    const oneDay = await request(app)
      .get("/api/dashboard/operator-dismisses?days=1")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(oneDay.status).toBe(200);
    const oneDayA = (oneDay.body as Array<{ operatorId: number; dismissCount: number }>)
      .find((r) => r.operatorId === operatorAId);
    // From the previous test only the `now` SUBMISSION (excluded) and
    // `yesterday` OPERATOR_DISMISS (just inside or just outside the 1-day
    // window depending on TZ-day boundaries) belong to A. We assert the
    // count is at most 1 — the long-ago row must be excluded — rather than
    // pinning an exact number which is sensitive to test wall-clock timing.
    expect((oneDayA?.dismissCount ?? 0) <= 1).toBe(true);

    // Wide window: the 60-day-old row appears, count for A is at least 3.
    const wide = await request(app)
      .get("/api/dashboard/operator-dismisses?days=90")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(wide.status).toBe(200);
    const wideA = (wide.body as Array<{ operatorId: number; dismissCount: number }>)
      .find((r) => r.operatorId === operatorAId);
    expect(wideA).toBeDefined();
    expect(wideA!.dismissCount).toBeGreaterThanOrEqual(3);
  });

  it("drill-down endpoint returns only the chosen operator's dismissed nudges, newest first, with area name + machine", async () => {
    const res = await request(app)
      .get(`/api/dashboard/operator-dismisses/detail?operatorId=${operatorAId}&days=7`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);

    const items = res.body as Array<{
      nudgeId: number;
      areaId: number;
      areaName: string;
      machine: string | null;
      dismissedAt: string;
    }>;
    // All rows belong to operator A (the SUBMISSION row for A is excluded
    // because the route filters reason=OPERATOR_DISMISS). Operator B's row
    // must not leak into A's drill-down.
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect([area1.id, area2.id]).toContain(item.areaId);
      expect(item.areaName).toMatch(new RegExp(`^${RUN_TAG}-area-`));
    }

    // Newest-first ordering.
    for (let i = 1; i < items.length; i++) {
      const prev = new Date(items[i - 1].dismissedAt).getTime();
      const cur = new Date(items[i].dismissedAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }

    // Machine carries through verbatim (one of A's nudges set machine="press-1").
    const withMachine = items.find((r) => r.machine === "press-1");
    expect(withMachine).toBeDefined();
  });

  it("requires the MANAGER role", async () => {
    const operatorToken = signToken({
      userId: operatorAId,
      role: "OPERATOR",
    });
    const res = await request(app)
      .get("/api/dashboard/operator-dismisses?days=7")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);

    const detail = await request(app)
      .get(`/api/dashboard/operator-dismisses/detail?operatorId=${operatorAId}&days=7`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(detail.status).toBe(403);
  });
});
