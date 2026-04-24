import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  areaAssignmentsTable,
  areaProfilesTable,
  submissionsTable,
  escalationsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// End-to-end coverage for the operator → area assignment model:
//
//   - Manager-only CRUD (`/users/operators`, `GET/PUT /areas/:id/assignments`)
//   - Operator-facing scoping (`/operator/status`,
//     `POST /submissions/identify-area`, `POST /submissions`)
//
// The route uses a "no rows for this user → see all areas" backward-compat
// rule so existing single-line setups don't break, and these tests pin both
// halves of that rule (default-all and explicit narrowing).

const RUN_TAG = `assignments-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorAId: number;
let operatorBId: number;
let areaA: { id: number; name: string };
let areaB: { id: number; name: string };
let areaC: { id: number; name: string };
let managerToken: string;
let opAToken: string;
let opBToken: string;

beforeAll(async () => {
  const [m] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-mgr@test.local`, passwordHash: "x", role: "MANAGER" })
    .returning();
  managerId = m.id;

  const [o1] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-op1@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  operatorAId = o1.id;

  const [o2] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-op2@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  operatorBId = o2.id;

  const [a] = await db.insert(areasTable).values({ name: `${RUN_TAG}-A` }).returning();
  areaA = { id: a.id, name: a.name };
  const [b] = await db.insert(areasTable).values({ name: `${RUN_TAG}-B` }).returning();
  areaB = { id: b.id, name: b.name };
  const [c] = await db.insert(areasTable).values({ name: `${RUN_TAG}-C` }).returning();
  areaC = { id: c.id, name: c.name };

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
  opAToken = signToken({ userId: operatorAId, role: "OPERATOR" });
  opBToken = signToken({ userId: operatorBId, role: "OPERATOR" });
});

afterAll(async () => {
  // Clean up in FK-safe order. Submissions may have been written by the
  // POST /submissions test (the AI scoring path runs against the test users
  // in this suite even though we only assert on the assignment guard). They
  // have to go before users.
  await db.delete(areaAssignmentsTable).where(inArray(areaAssignmentsTable.userId, [operatorAId, operatorBId]));
  const ourSubs = await db
    .select({ id: submissionsTable.id })
    .from(submissionsTable)
    .where(inArray(submissionsTable.userId, [operatorAId, operatorBId]));
  if (ourSubs.length > 0) {
    await db.delete(escalationsTable).where(
      inArray(escalationsTable.submissionId, ourSubs.map((s) => s.id)),
    );
  }
  await db.delete(submissionsTable).where(inArray(submissionsTable.userId, [operatorAId, operatorBId]));
  await db.delete(areaProfilesTable).where(inArray(areaProfilesTable.areaId, [areaA.id, areaB.id, areaC.id]));
  await db.delete(usersTable).where(inArray(usersTable.id, [managerId, operatorAId, operatorBId]));
  await db.delete(areasTable).where(inArray(areasTable.id, [areaA.id, areaB.id, areaC.id]));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(areaAssignmentsTable).where(inArray(areaAssignmentsTable.userId, [operatorAId, operatorBId]));
});

describe("GET /users/operators", () => {
  it("requires a manager token", async () => {
    const noAuth = await request(app).get("/api/users/operators");
    expect(noAuth.status).toBe(401);

    const asOperator = await request(app)
      .get("/api/users/operators")
      .set("Authorization", `Bearer ${opAToken}`);
    expect(asOperator.status).toBe(403);
  });

  it("lists every OPERATOR user but no managers", async () => {
    const res = await request(app)
      .get("/api/users/operators")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: number; email: string }>).map((u) => u.id);
    expect(ids).toContain(operatorAId);
    expect(ids).toContain(operatorBId);
    expect(ids).not.toContain(managerId);
  });
});

describe("PUT /areas/:id/assignments", () => {
  it("requires a manager token", async () => {
    const res = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${opAToken}`)
      .send({ operatorIds: [operatorAId] });
    expect(res.status).toBe(403);
  });

  it("rejects unknown ids and ids belonging to managers", async () => {
    const unknown = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId, 9_999_999] });
    expect(unknown.status).toBe(400);

    const isMgr = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [managerId] });
    expect(isMgr.status).toBe(400);

    // Make sure neither attempt left rows behind.
    const rows = await db
      .select()
      .from(areaAssignmentsTable)
      .where(eq(areaAssignmentsTable.areaId, areaA.id));
    expect(rows).toHaveLength(0);
  });

  it("replaces the assignment set on each call and dedupes ids", async () => {
    // First write: A and B.
    let res = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId, operatorBId, operatorAId] });
    expect(res.status).toBe(200);
    expect(new Set(res.body.operatorIds)).toEqual(new Set([operatorAId, operatorBId]));

    // Replace with just A.
    res = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId] });
    expect(res.status).toBe(200);
    expect(res.body.operatorIds).toEqual([operatorAId]);

    const get = await request(app)
      .get(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.status).toBe(200);
    expect(get.body.operatorIds).toEqual([operatorAId]);

    // Empty assignment set is allowed.
    res = await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.operatorIds).toEqual([]);
  });
});

describe("GET /operator/status (assignment scoping)", () => {
  it("returns every area for an operator with no assignments configured", async () => {
    const res = await request(app)
      .get("/api/operator/status")
      .set("Authorization", `Bearer ${opAToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ areaId: number }>).map((s) => s.areaId);
    // We only assert our seeded areas are present (the fixture template may
    // contain unrelated areas added by other tests in the same template).
    expect(ids).toEqual(expect.arrayContaining([areaA.id, areaB.id, areaC.id]));
  });

  it("narrows the home grid to assigned areas only once any assignment exists", async () => {
    await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId] })
      .expect(200);
    await request(app)
      .put(`/api/areas/${areaC.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId] })
      .expect(200);

    const res = await request(app)
      .get("/api/operator/status")
      .set("Authorization", `Bearer ${opAToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ areaId: number }>).map((s) => s.areaId).sort();
    expect(ids).toEqual([areaA.id, areaC.id].sort());

    // Operator B has no assignments — should still see everything.
    const bRes = await request(app)
      .get("/api/operator/status")
      .set("Authorization", `Bearer ${opBToken}`);
    expect(bRes.status).toBe(200);
    const bIds = (bRes.body as Array<{ areaId: number }>).map((s) => s.areaId);
    expect(bIds).toEqual(expect.arrayContaining([areaA.id, areaB.id, areaC.id]));
  });
});

describe("POST /submissions/identify-area (assignment scoping)", () => {
  beforeEach(async () => {
    // Reset profiles between tests so the TRAINED filter starts clean.
    await db.delete(areaProfilesTable).where(inArray(areaProfilesTable.areaId, [areaA.id, areaB.id, areaC.id]));
  });

  async function trainArea(areaId: number) {
    await db.insert(areaProfilesTable).values({
      areaId,
      status: "TRAINED",
      submissionsCount: 5,
      summary: "test",
      itemsJson: ["item"],
      machinesJson: [],
      layoutJson: [],
      commonIssuesJson: [],
    });
  }

  it("returns hasTrainedAreas:false when the operator has assignments but none are TRAINED", async () => {
    await trainArea(areaB.id); // trained but NOT assigned to opA
    await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId] })
      .expect(200);

    const res = await request(app)
      .post("/api/submissions/identify-area")
      .set("Authorization", `Bearer ${opAToken}`)
      .attach("photo", Buffer.from("fake-jpeg-bytes"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.hasTrainedAreas).toBe(false);
    expect(res.body.candidates).toEqual([]);
  });
});

describe("POST /submissions (assignment enforcement)", () => {
  // We only assert the 403 path here — the success path runs the AI scoring
  // pipeline and creates downstream rows (submissions, escalations, area
  // schedules) that are awkward to clean up in shared test fixtures. The
  // backward-compat "no rows = see everything" rule is already pinned by
  // the GET /operator/status and identify-area tests above, which exercise
  // the same `getAssignedAreaIds()` helper.
  it("rejects a submission for an area the operator is not assigned to", async () => {
    await request(app)
      .put(`/api/areas/${areaA.id}/assignments`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ operatorIds: [operatorAId] })
      .expect(200);

    const res = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${opAToken}`)
      .field("areaId", String(areaB.id))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(403);
  });
});
