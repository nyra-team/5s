import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TestWorld, api } from "./helpers.js";
import { dismissNudgesForSubmission } from "../src/routes/nudges.js";

interface NudgeShape {
  id: number;
  areaId: number;
  machine: string | null;
  shift: string;
  dismissedAt: string | null;
}

describe("POST /api/nudges (de-dup)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("re-uses an active nudge for the same area+machine+shift", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const r1 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A", message: "first",
    });
    const r2 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A", message: "again",
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.body.id, r1.body.id, "second POST should re-use the existing active nudge");
  });

  test("creates a distinct nudge when the machine changes", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const r1 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A",
    });
    const r2 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-2", shift: "A",
    });
    assert.notEqual(r1.body.id, r2.body.id);
  });

  test("creates a distinct nudge when the shift changes", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const r1 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A",
    });
    const r2 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "B",
    });
    assert.notEqual(r1.body.id, r2.body.id);
  });

  test("treats null machine and explicit machine as separate de-dup buckets", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const r1 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const r2 = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A",
    });
    assert.equal(r1.body.machine, null);
    assert.equal(r2.body.machine, "M-1");
    assert.notEqual(r1.body.id, r2.body.id);
  });

  test("rejects an invalid shift", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const r = await api(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "Z",
    });
    assert.equal(r.status, 400);
  });

  test("rejects non-managers", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    const r = await api(operator.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    assert.equal(r.status, 403);
  });
});

describe("GET /api/nudges (per-operator atomic dismissal)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("each operator sees the nudge once and not on subsequent polls", async () => {
    const manager = await world.createUser("MANAGER");
    const opA = await world.createUser("OPERATOR", "alice");
    const opB = await world.createUser("OPERATOR", "bob");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A", machine: "M-1", message: "tidy up",
    });
    assert.equal(created.status, 201);

    const a1 = await api<NudgeShape[]>(opA.token, "GET", "/api/nudges");
    assert.equal(a1.status, 200);
    const a1Ids = a1.body.map((n) => n.id);
    assert.ok(a1Ids.includes(created.body.id), "operator A's first poll must include the nudge");

    const a2 = await api<NudgeShape[]>(opA.token, "GET", "/api/nudges");
    const a2Ids = a2.body.map((n) => n.id);
    assert.ok(!a2Ids.includes(created.body.id), "operator A must not see the nudge again");

    // Operator B has never polled, so the same nudge must still be visible.
    const b1 = await api<NudgeShape[]>(opB.token, "GET", "/api/nudges");
    const b1Ids = b1.body.map((n) => n.id);
    assert.ok(b1Ids.includes(created.body.id), "operator B must still see the nudge");

    const b2 = await api<NudgeShape[]>(opB.token, "GET", "/api/nudges");
    const b2Ids = b2.body.map((n) => n.id);
    assert.ok(!b2Ids.includes(created.body.id), "operator B must not see it again either");
  });

  test("rejects managers (they don't consume their own nudges)", async () => {
    const manager = await world.createUser("MANAGER");
    const r = await api(manager.token, "GET", "/api/nudges");
    assert.equal(r.status, 403);
  });

  test("requires authentication", async () => {
    const r = await api(null, "GET", "/api/nudges");
    assert.equal(r.status, 401);
  });
});

describe("POST /api/nudges/:id/dismiss (operator dismisses an addressed nudge)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("operator dismisses an active nudge so the persistent badge clears", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A", message: "tidy up",
    });
    assert.equal(created.status, 201);

    // Sanity: the persistent endpoint sees the nudge before dismiss.
    const before = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges/active-by-area?shift=A");
    assert.ok(before.body.some((n) => n.id === created.body.id));

    const dismissed = await api<NudgeShape & { dismissedAt: string | null }>(
      operator.token,
      "POST",
      `/api/nudges/${created.body.id}/dismiss`,
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.id, created.body.id);
    assert.ok(dismissed.body.dismissedAt, "response should reflect dismissedAt set");

    // After dismiss, persistent endpoint must no longer return it.
    const after = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges/active-by-area?shift=A");
    assert.ok(!after.body.some((n) => n.id === created.body.id), "dismissed nudge must drop from persistent list");
  });

  test("dismissing an already-dismissed nudge is idempotent (still 200)", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const r1 = await api(operator.token, "POST", `/api/nudges/${created.body.id}/dismiss`);
    const r2 = await api(operator.token, "POST", `/api/nudges/${created.body.id}/dismiss`);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
  });

  test("returns 404 for an unknown nudge id", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "POST", "/api/nudges/999999999/dismiss");
    assert.equal(r.status, 404);
  });

  test("rejects managers (operator-only)", async () => {
    const manager = await world.createUser("MANAGER");
    const area = await world.createArea();
    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const r = await api(manager.token, "POST", `/api/nudges/${created.body.id}/dismiss`);
    assert.equal(r.status, 403);
  });

  test("requires authentication", async () => {
    const r = await api(null, "POST", "/api/nudges/1/dismiss");
    assert.equal(r.status, 401);
  });
});

// These tests guard the implicit-clear behaviour that operator submissions
// must trigger. They invoke the dismissNudgesForSubmission helper directly
// rather than going through POST /api/submissions because the latter pulls
// in the full scoring pipeline (file upload + AI), which would make the
// regression check brittle. The helper is the single source of truth for the
// dismissal rules, so testing it in isolation catches schema/predicate
// regressions without binding the suite to scoring internals.
describe("dismissNudgesForSubmission (implicit clear on submit)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  // Helper: create a nudge via the public POST and return the active row
  // (active-by-area is the source we read from, so use it to verify state).
  async function activeForArea(token: string, areaId: number, shift?: string) {
    const path = shift
      ? `/api/nudges/active-by-area?shift=${shift}`
      : "/api/nudges/active-by-area";
    const r = await api<NudgeShape[]>(token, "GET", path);
    assert.equal(r.status, 200);
    return r.body.filter((n) => n.areaId === areaId);
  }

  test("area-level nudge (machine=null) is cleared by ANY submission to area+shift", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.machine, null);

    // Sanity: the nudge is visible before the dismissal.
    const before = await activeForArea(operator.token, area.id, "A");
    assert.equal(before.length, 1);

    // A submission with NO machineTag clears the area-level nudge.
    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: null });

    const after = await activeForArea(operator.token, area.id, "A");
    assert.equal(after.length, 0, "area-level nudge must be cleared by a no-machine submission");
  });

  test("area-level nudge is also cleared when the submission carries a machineTag", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });

    // Operator captured a specific machine; the area-level nudge still goes away
    // because "any submission to area+shift" satisfies it.
    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: "M-7" });

    const after = await activeForArea(operator.token, area.id, "A");
    assert.equal(after.length, 0, "area-level nudge must clear regardless of machineTag");
  });

  test("machine-specific nudge is NOT cleared by a non-matching machineTag (or by null)", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A",
    });
    assert.equal(created.status, 201);

    // Submission with no machine tag must not clear the machine-pinned nudge.
    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: null });
    let active = await activeForArea(operator.token, area.id, "A");
    assert.equal(active.length, 1, "no-machine submission must not clear M-1 nudge");

    // Submission for a different machine must not clear it either.
    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: "M-2" });
    active = await activeForArea(operator.token, area.id, "A");
    assert.equal(active.length, 1, "different-machine submission must not clear M-1 nudge");

    // Submission for the matching machine clears it.
    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: "M-1" });
    active = await activeForArea(operator.token, area.id, "A");
    assert.equal(active.length, 0, "matching-machine submission must clear M-1 nudge");
  });

  test("submission for one shift does not clear nudges in other shifts/areas", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const a = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const b = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "B",
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: null });

    const aRows = await activeForArea(operator.token, area.id, "A");
    const bRows = await activeForArea(operator.token, area.id, "B");
    assert.equal(aRows.length, 0, "shift A nudge must clear");
    assert.equal(bRows.length, 1, "shift B nudge must NOT clear");
  });
});

describe("GET /api/nudges/active-by-area (persistent badge feed)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("returns active nudges and does NOT mark them seen/dismissed across polls", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, machine: "M-1", shift: "A", message: "tidy up",
    });
    assert.equal(created.status, 201);

    // First poll: nudge is present.
    const r1 = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges/active-by-area");
    assert.equal(r1.status, 200);
    assert.ok(
      r1.body.some((n) => n.id === created.body.id),
      "first poll must include the active nudge",
    );

    // Second poll: still present — this endpoint must NOT auto-dismiss or mark seen,
    // unlike GET /api/nudges which is the read-once toast feed.
    const r2 = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges/active-by-area");
    assert.ok(
      r2.body.some((n) => n.id === created.body.id),
      "active-by-area must remain visible on subsequent polls",
    );

    // And after the persistent feed has been polled twice, the toast feed should
    // STILL show the nudge once (proves the persistent feed didn't bump
    // seen_by_user_ids_json behind our back).
    const toast = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges");
    assert.ok(
      toast.body.some((n) => n.id === created.body.id),
      "GET /api/nudges must still surface the nudge — active-by-area must not consume seen state",
    );
  });

  test("filters by shift query param", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const a = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const b = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "B",
    });

    const onlyA = await api<NudgeShape[]>(
      operator.token, "GET", "/api/nudges/active-by-area?shift=A",
    );
    const ids = onlyA.body.map((n) => n.id);
    assert.ok(ids.includes(a.body.id));
    assert.ok(!ids.includes(b.body.id));
  });

  test("excludes already-dismissed nudges", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    assert.equal(created.status, 201);

    await dismissNudgesForSubmission({ areaId: area.id, shift: "A", machineTag: null });

    const r = await api<NudgeShape[]>(operator.token, "GET", "/api/nudges/active-by-area");
    assert.ok(
      !r.body.some((n) => n.id === created.body.id),
      "dismissed nudges must not appear",
    );
  });

  test("rejects managers", async () => {
    const manager = await world.createUser("MANAGER");
    const r = await api(manager.token, "GET", "/api/nudges/active-by-area");
    assert.equal(r.status, 403);
  });

  test("requires authentication", async () => {
    const r = await api(null, "GET", "/api/nudges/active-by-area");
    assert.equal(r.status, 401);
  });

  test("rejects an invalid shift query param", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "GET", "/api/nudges/active-by-area?shift=Z");
    assert.equal(r.status, 400);
  });
});
