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

// Exercises POST /nudges/:id/undismiss — the endpoint that backs the operator's
// "Undo" toast after they dismiss a manager nudge by mistake. Confirms:
//   - happy path: a freshly OPERATOR_DISMISS-cleared nudge becomes active again
//   - guard: a nudge cleared by a SUBMISSION cannot be undone (409)
//   - idempotency: undoing an already-active nudge is a no-op 200
//   - 404 on unknown id
//   - role guard: managers can't call it
// Tests use unique tag-prefixed rows and clean themselves up.

const RUN_TAG = `nudge-undo-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

async function createNudge(opts: { shift?: "A" | "B" | "C" } = {}): Promise<number> {
  const [row] = await db
    .insert(nudgesTable)
    .values({
      areaId: area.id,
      machine: null,
      shift: opts.shift ?? "A",
      message: null,
      createdByUserId: managerId,
    })
    .returning({ id: nudgesTable.id });
  return row.id;
}

describe("POST /nudges/:id/undismiss", () => {
  it("restores a nudge the operator just dismissed (clears dismissedAt and attribution)", async () => {
    const id = await createNudge();

    // Dismiss first so there is something to undo.
    await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);

    const res = await request(app)
      .post(`/api/nudges/${id}/undismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.dismissedAt).toBeNull();

    const [row] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));
    expect(row.dismissedAt).toBeNull();
    expect(row.dismissedByUserId).toBeNull();
    expect(row.dismissReason).toBeNull();
  });

  it("refuses (409) to restore a nudge that was cleared by a submission", async () => {
    const id = await createNudge();
    await dismissNudgesForSubmission({
      areaId: area.id,
      shift: "A",
      machineTag: null,
      userId: operatorId,
    });

    const res = await request(app)
      .post(`/api/nudges/${id}/undismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(409);

    // The dismissal attribution must be preserved (no silent partial update).
    const [row] = await db
      .select()
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));
    expect(row.dismissedAt).not.toBeNull();
    expect(row.dismissReason).toBe("SUBMISSION");
  });

  it("is idempotent: calling undismiss on an already-active nudge returns 200", async () => {
    const id = await createNudge();

    await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    await request(app)
      .post(`/api/nudges/${id}/undismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);

    // Second undismiss — already active, should still 200 with the active row.
    const res = await request(app)
      .post(`/api/nudges/${id}/undismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.dismissedAt).toBeNull();
  });

  it("returns 404 when the nudge does not exist", async () => {
    const res = await request(app)
      .post(`/api/nudges/999999999/undismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects callers without the OPERATOR role", async () => {
    const id = await createNudge();
    await request(app)
      .post(`/api/nudges/${id}/dismiss`)
      .set("Authorization", `Bearer ${operatorToken}`);

    const res = await request(app)
      .post(`/api/nudges/${id}/undismiss`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(403);
  });
});
