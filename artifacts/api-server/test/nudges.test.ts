import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TestWorld, api } from "./helpers.js";

interface NudgeShape {
  id: number;
  areaId: number;
  machine: string | null;
  shift: string;
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
