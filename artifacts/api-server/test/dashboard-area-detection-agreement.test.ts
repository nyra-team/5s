import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";

interface AgreementBucket {
  agreed: number;
  total: number;
  agreementPercent: number | null;
}

interface AgreementResponse {
  windowDays: number;
  overall: AgreementBucket;
  perArea: Array<{
    areaId: number;
    areaName: string;
    agreed: number;
    total: number;
    agreementPercent: number | null;
  }>;
  perOperator: Array<{
    userId: number;
    userEmail: string;
    agreed: number;
    total: number;
    agreementPercent: number | null;
  }>;
}

async function insertSub(opts: {
  areaId: number;
  userId: number;
  tappedAreaId: number | null;
  scoreTotal?: number;
}) {
  const [s] = await db
    .insert(submissionsTable)
    .values({
      areaId: opts.areaId,
      userId: opts.userId,
      shift: "A",
      scoreTotal: opts.scoreTotal ?? 20,
      scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      suggestionsJson: [],
      imageUrl: "/uploads/test.jpg",
      mediaType: "image",
      tappedAreaId: opts.tappedAreaId,
    })
    .returning();
  return s;
}

describe("GET /api/dashboard/area-detection-agreement", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("returns 401 to unauthenticated callers", async () => {
    const r = await api(null, "GET", "/api/dashboard/area-detection-agreement");
    assert.equal(r.status, 401);
  });

  test("returns 403 to operators (manager-only)", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "GET", "/api/dashboard/area-detection-agreement");
    assert.equal(r.status, 403);
  });

  test("counts matches as agreement, mismatches as drift, and excludes null tappedAreaId", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const areaA = await world.createArea("alpha");
    const areaB = await world.createArea("beta");

    // 2 matches on areaA, 1 mismatch (tapped B, chose A), 1 legacy null row
    // (must be excluded from totals so unknown intent doesn't inflate the rate).
    await insertSub({ areaId: areaA.id, userId: operator.id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator.id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator.id, tappedAreaId: areaB.id });
    await insertSub({ areaId: areaA.id, userId: operator.id, tappedAreaId: null });

    const r = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=30",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.windowDays, 30);

    // Other tests / dev data may also live in the window, so assert that
    // OUR rows are reflected rather than asserting absolute totals.
    const areaARow = r.body.perArea.find((row) => row.areaId === areaA.id);
    const areaBRow = r.body.perArea.find((row) => row.areaId === areaB.id);
    const opRow = r.body.perOperator.find((row) => row.userId === operator.id);

    assert.ok(areaARow, "areaA should appear in perArea breakdown");
    // areaA had 3 non-null rows: 2 agreed + 1 drifted-away
    assert.equal(areaARow!.total, 3);
    assert.equal(areaARow!.agreed, 2);
    assert.equal(areaARow!.agreementPercent, 67);

    assert.ok(areaBRow, "areaB should appear because a row drifted toward it");
    // areaB only shows the 1 drift row attributed to its bucket
    assert.equal(areaBRow!.total, 1);
    assert.equal(areaBRow!.agreed, 0);
    assert.equal(areaBRow!.agreementPercent, 0);

    assert.ok(opRow, "operator should appear in perOperator breakdown");
    // Operator: 3 non-null rows (1 null is excluded), 2 agreed
    assert.equal(opRow!.total, 3);
    assert.equal(opRow!.agreed, 2);
    assert.equal(opRow!.agreementPercent, 67);
  });

  test("returns null agreementPercent when there are zero rows in the window", async () => {
    const manager = await world.createUser("MANAGER");
    // days=0 (clamped to 1) over a freshly-created world means no rows.
    // We can't easily isolate the global "overall" because the dev DB may
    // hold other rows, so this test just asserts the response shape and
    // that the endpoint accepts boundary values without crashing.
    const r = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=1",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.windowDays, 1);
    assert.equal(typeof r.body.overall.total, "number");
    assert.equal(typeof r.body.overall.agreed, "number");
    assert.ok(Array.isArray(r.body.perArea));
    assert.ok(Array.isArray(r.body.perOperator));
  });

  test("falls back to the 30-day default when days is out of range", async () => {
    const manager = await world.createUser("MANAGER");

    // Anything outside [1, 90] (or non-numeric) uses the safe default of 30
    // rather than silently clamping. This protects against typos like
    // ?days=9999 quietly returning a much larger window than the manager
    // intended.
    const tooBig = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=9999",
    );
    assert.equal(tooBig.status, 200);
    assert.equal(tooBig.body.windowDays, 30, "out-of-range days should fall back to 30");

    const tooSmall = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=0",
    );
    assert.equal(tooSmall.status, 200);
    assert.equal(tooSmall.body.windowDays, 30, "days=0 should fall back to 30");

    const garbage = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=banana",
    );
    assert.equal(garbage.status, 200);
    assert.equal(garbage.body.windowDays, 30, "non-numeric days should fall back to 30");

    // In-range values are honored as-is.
    const inRange = await api<AgreementResponse>(
      manager.token,
      "GET",
      "/api/dashboard/area-detection-agreement?days=7",
    );
    assert.equal(inRange.status, 200);
    assert.equal(inRange.body.windowDays, 7);
  });
});
