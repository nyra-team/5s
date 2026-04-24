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
import { dismissNudgesForSubmission } from "../nudges";

// Exercises the new dismissal-attribution behaviour added for showing
// managers when an operator silenced a nudge without re-capturing evidence.
//   - operator dismiss endpoint: writes dismissReason=OPERATOR_DISMISS + dismissedByUserId=caller
//   - dismissNudgesForSubmission: writes dismissReason=SUBMISSION  + dismissedByUserId=submitter
//   - GET /shift/live surfaces lastOperatorDismissedNudgeAt on pendingAreas (and overdueChecks)
//
// Tests use unique tag-prefixed rows and clean themselves up.

const RUN_TAG = `nudge-attr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let area: { id: number; name: string };
let operatorToken: string;
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

  const [o] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorId = o.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area` })
    .returning();
  area = { id: a.id, name: a.name };

  operatorToken = signToken({ userId: operatorId, role: "OPERATOR" });
  managerToken = signToken({ userId: managerId, role: "MANAGER" });
});

afterAll(async () => {
  await db.delete(nudgesTable).where(eq(nudgesTable.areaId, area.id));
  await db.delete(areasTable).where(eq(areasTable.id, area.id));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [managerId, operatorId]));
  await pool.end();
});

async function createNudge(opts: { machine?: string | null; shift?: "A" | "B" | "C" } = {}): Promise<number> {
  const [row] = await db
    .insert(nudgesTable)
    .values({
      areaId: area.id,
      machine: opts.machine ?? null,
      shift: opts.shift ?? "A",
      message: null,
      createdByUserId: managerId,
    })
    .returning({ id: nudgesTable.id });
  return row.id;
}

describe("nudge dismissal attribution", () => {
  it("operator dismiss endpoint records the operator and an OPERATOR_DISMISS reason", async () => {
    const id = await createNudge();

    const res = await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));
    expect(row.dismissedAt).not.toBeNull();
    expect(row.dismissedByUserId).toBe(operatorId);
    expect(row.dismissReason).toBe("OPERATOR_DISMISS");
  });

  it("operator dismiss endpoint is idempotent: a second call does not overwrite attribution", async () => {
    const id = await createNudge();

    await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);

    // Have a different user (manager token can't, since route is OPERATOR-only).
    // Hit the same endpoint again as the same operator: the existing
    // dismissedAt/reason should be preserved unchanged.
    const [first] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));

    const res = await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);

    const [second] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));
    expect(second.dismissedAt?.getTime()).toBe(first.dismissedAt?.getTime());
    expect(second.dismissedByUserId).toBe(operatorId);
    expect(second.dismissReason).toBe("OPERATOR_DISMISS");
  });

  it("dismissNudgesForSubmission stamps the submitter and a SUBMISSION reason", async () => {
    const id = await createNudge();
    await dismissNudgesForSubmission({
      areaId: area.id,
      shift: "A",
      machineTag: null,
      userId: operatorId,
    });
    const [row] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));
    expect(row.dismissedAt).not.toBeNull();
    expect(row.dismissedByUserId).toBe(operatorId);
    expect(row.dismissReason).toBe("SUBMISSION");
  });

  it("GET /shift/live exposes lastOperatorDismissedNudgeAt for areas the operator silenced", async () => {
    // Pre-clean any leftover nudges for this test's area to keep the assertion
    // about THIS dismissal unambiguous.
    await db.delete(nudgesTable).where(eq(nudgesTable.areaId, area.id));

    // Pick the current shift so the live endpoint considers our nudge in-window.
    // The dismissal will be stamped with new Date() and live.ts filters by
    // dismissedAt >= shift.start, so we have to use the same shift the route
    // computes. Probe /shift/live first to learn the shift.
    const probe = await request(app)
      .get("/api/shift/live")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(probe.status).toBe(200);
    const shift = probe.body.shift as "A" | "B" | "C";

    const id = await createNudge({ shift });
    const dismiss = await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(dismiss.status).toBe(200);

    const live = await request(app)
      .get("/api/shift/live")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(live.status).toBe(200);

    const pending = (live.body.pendingAreas as Array<{
      areaId: number;
      lastOperatorDismissedNudgeAt: string | null;
    }>).find((p) => p.areaId === area.id);
    expect(pending).toBeDefined();
    expect(pending!.lastOperatorDismissedNudgeAt).not.toBeNull();
  });

  it("GET /shift/live leaves lastOperatorDismissedNudgeAt null when the nudge was cleared by a submission", async () => {
    await db.delete(nudgesTable).where(eq(nudgesTable.areaId, area.id));

    const probe = await request(app)
      .get("/api/shift/live")
      .set("Authorization", `Bearer ${managerToken}`);
    const shift = probe.body.shift as "A" | "B" | "C";

    await createNudge({ shift });
    await dismissNudgesForSubmission({
      areaId: area.id,
      shift,
      machineTag: null,
      userId: operatorId,
    });

    const live = await request(app)
      .get("/api/shift/live")
      .set("Authorization", `Bearer ${managerToken}`);
    const pending = (live.body.pendingAreas as Array<{
      areaId: number;
      lastOperatorDismissedNudgeAt: string | null;
    }>).find((p) => p.areaId === area.id);
    // The area is still pending (no submission row was created in this test —
    // we called the helper directly), so it should be in pendingAreas with
    // lastOperatorDismissedNudgeAt=null because the dismissal reason was SUBMISSION.
    expect(pending).toBeDefined();
    expect(pending!.lastOperatorDismissedNudgeAt).toBeNull();
  });
});
