import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  areaAssignmentsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// End-to-end coverage for the manager dashboard widget that surfaces
// operators whose area-assignment list is empty (or only contains a
// single area). Operators with zero rows in area_assignments fall back
// to the legacy "see every area" path; that's intentional for fresh
// installs but almost always a forgotten teammate once any assignments
// have been wired up, so they need to be visible to the manager.

const RUN_TAG = `coverage-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let opNoneId: number;
let opOneId: number;
let opTwoId: number;
let areaA: { id: number; name: string };
let areaB: { id: number; name: string };
let areaC: { id: number; name: string };
let managerToken: string;
let opNoneToken: string;

beforeAll(async () => {
  const [m] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-mgr@test.local`, passwordHash: "x", role: "MANAGER" })
    .returning();
  managerId = m.id;

  // Three operators in deliberate alphabetical order (`a-`, `b-`, `c-`)
  // so the email-tiebreaker assertion is stable regardless of Postgres'
  // physical row ordering.
  const [op0] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-a-none@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  opNoneId = op0.id;
  const [op1] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-b-one@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  opOneId = op1.id;
  const [op2] = await db
    .insert(usersTable)
    .values({ email: `${RUN_TAG}-c-two@test.local`, passwordHash: "x", role: "OPERATOR" })
    .returning();
  opTwoId = op2.id;

  const [a] = await db.insert(areasTable).values({ name: `${RUN_TAG}-A` }).returning();
  areaA = { id: a.id, name: a.name };
  const [b] = await db.insert(areasTable).values({ name: `${RUN_TAG}-B` }).returning();
  areaB = { id: b.id, name: b.name };
  const [c] = await db.insert(areasTable).values({ name: `${RUN_TAG}-C` }).returning();
  areaC = { id: c.id, name: c.name };

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
  opNoneToken = signToken({ userId: opNoneId, role: "OPERATOR" });
});

afterAll(async () => {
  await db
    .delete(areaAssignmentsTable)
    .where(inArray(areaAssignmentsTable.userId, [opNoneId, opOneId, opTwoId]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [areaA.id, areaB.id, areaC.id]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [managerId, opNoneId, opOneId, opTwoId]));
  await pool.end();
});

beforeEach(async () => {
  // Reset assignments between tests so each one stages exactly the rows it
  // needs without leaking state from the previous case.
  await db
    .delete(areaAssignmentsTable)
    .where(inArray(areaAssignmentsTable.userId, [opNoneId, opOneId, opTwoId]));
});

interface CoverageRow {
  operatorId: number;
  operatorEmail: string;
  assignedCount: number;
  assignedAreaNames: string[];
}
interface CoverageBody {
  totalOperators: number;
  totalAreas: number;
  maxAreas: number;
  operators: CoverageRow[];
}

function rowFor(body: CoverageBody, opId: number): CoverageRow | undefined {
  return body.operators.find((r) => r.operatorId === opId);
}

describe("GET /dashboard/operator-coverage", () => {
  it("requires a manager token", async () => {
    const noAuth = await request(app).get("/api/dashboard/operator-coverage");
    expect(noAuth.status).toBe(401);

    const asOperator = await request(app)
      .get("/api/dashboard/operator-coverage")
      .set("Authorization", `Bearer ${opNoneToken}`);
    expect(asOperator.status).toBe(403);
  });

  it("flags operators with zero assignments and surfaces the legacy 'sees-all' fallback", async () => {
    // opNone: nothing assigned (zero rows → legacy see-all)
    // opOne:  one area
    // opTwo:  two areas (above the maxAreas=1 cutoff → must NOT appear)
    await db.insert(areaAssignmentsTable).values({ userId: opOneId, areaId: areaA.id });
    await db.insert(areaAssignmentsTable).values({ userId: opTwoId, areaId: areaA.id });
    await db.insert(areaAssignmentsTable).values({ userId: opTwoId, areaId: areaB.id });

    const res = await request(app)
      .get("/api/dashboard/operator-coverage")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as CoverageBody;

    // Headline stats reflect the global state so the UI can render
    // "X of Y operators" copy without a second round-trip.
    expect(body.maxAreas).toBe(1);
    expect(body.totalOperators).toBeGreaterThanOrEqual(3);
    expect(body.totalAreas).toBeGreaterThanOrEqual(3);

    const noneRow = rowFor(body, opNoneId);
    const oneRow = rowFor(body, opOneId);
    const twoRow = rowFor(body, opTwoId);

    expect(noneRow).toBeDefined();
    expect(noneRow!.assignedCount).toBe(0);
    expect(noneRow!.assignedAreaNames).toEqual([]);

    expect(oneRow).toBeDefined();
    expect(oneRow!.assignedCount).toBe(1);
    expect(oneRow!.assignedAreaNames).toEqual([areaA.name]);

    // Two-area operator is healthy at the default threshold and must not leak
    // into the panel.
    expect(twoRow).toBeUndefined();

    // Worst-coverage-first ordering: the zero-area operator outranks the
    // one-area operator regardless of email.
    const noneIdx = body.operators.findIndex((r) => r.operatorId === opNoneId);
    const oneIdx = body.operators.findIndex((r) => r.operatorId === opOneId);
    expect(noneIdx).toBeLessThan(oneIdx);
  });

  it("excludes manager accounts from the coverage list", async () => {
    const res = await request(app)
      .get("/api/dashboard/operator-coverage")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as CoverageBody;

    // Managers have no rows in area_assignments by definition; if we forgot
    // to filter on role they'd flood the panel with false positives.
    expect(rowFor(body, managerId)).toBeUndefined();
  });

  it("respects maxAreas=0 to show only zero-assignment operators", async () => {
    await db.insert(areaAssignmentsTable).values({ userId: opOneId, areaId: areaA.id });

    const res = await request(app)
      .get("/api/dashboard/operator-coverage?maxAreas=0")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const body = res.body as CoverageBody;
    expect(body.maxAreas).toBe(0);

    expect(rowFor(body, opNoneId)?.assignedCount).toBe(0);
    // opOne has exactly one area → above the strict 0-only threshold.
    expect(rowFor(body, opOneId)).toBeUndefined();
  });

  it("returns assigned area names alongside the count for one-area operators", async () => {
    await db.insert(areaAssignmentsTable).values({ userId: opOneId, areaId: areaC.id });

    const res = await request(app)
      .get("/api/dashboard/operator-coverage")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const oneRow = rowFor(res.body as CoverageBody, opOneId);
    expect(oneRow?.assignedAreaNames).toEqual([areaC.name]);
  });
});
