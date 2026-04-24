import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";
import { AI_UNAVAILABLE_FALLBACK_ACTION } from "../src/lib/ai-scoring.js";

interface SubmissionRow {
  id: number;
  scoreTotal: number;
}

async function insertSub(opts: {
  areaId: number;
  userId: number;
  scoreTotal: number;
  machineTag?: string | null;
  suggestionsJson?: string[];
}) {
  const [s] = await db
    .insert(submissionsTable)
    .values({
      areaId: opts.areaId,
      userId: opts.userId,
      shift: "A",
      scoreTotal: opts.scoreTotal,
      scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      suggestionsJson: opts.suggestionsJson ?? [],
      imageUrl: "/uploads/test.jpg",
      mediaType: "image",
      machineTag: opts.machineTag ?? null,
    })
    .returning();
  return s;
}

describe("GET /api/submissions (q + score-range filters)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("q matches the area name (case-insensitive substring)", async () => {
    const operator = await world.createUser("OPERATOR");
    const target = await world.createArea("targetzone");
    const other = await world.createArea("other");

    const inA = await insertSub({ areaId: target.id, userId: operator.id, scoreTotal: 15 });
    const inB = await insertSub({ areaId: other.id, userId: operator.id, scoreTotal: 15 });

    // The area's tag is unique to this test run, so a tag-suffix match
    // will only ever return our row.
    const r = await api<SubmissionRow[]>(operator.token, "GET", `/api/submissions?q=${target.tag}`);
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(inA.id), "area-name match must include the matching row");
    assert.ok(!ids.includes(inB.id), "non-matching area must be excluded");
  });

  test("q matches the operator email", async () => {
    const operator = await world.createUser("OPERATOR", "needle");
    const otherOp = await world.createUser("OPERATOR", "haystack");
    const area = await world.createArea();

    const mine = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 12 });
    const theirs = await insertSub({ areaId: area.id, userId: otherOp.id, scoreTotal: 12 });

    // The user's email contains a unique random suffix; search by that suffix.
    const tag = operator.email.split("-")[1].split("@")[0];
    const r = await api<SubmissionRow[]>(operator.token, "GET", `/api/submissions?q=${tag}`);
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(theirs.id));
  });

  test("q matches the machine tag", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    // Use a unique machine tag so we don't collide with any other data.
    const uniqueMachine = `MX-${area.tag.slice(0, 6)}`;
    const tagged = await insertSub({
      areaId: area.id, userId: operator.id, scoreTotal: 14, machineTag: uniqueMachine,
    });
    const untagged = await insertSub({
      areaId: area.id, userId: operator.id, scoreTotal: 14, machineTag: null,
    });

    const r = await api<SubmissionRow[]>(operator.token, "GET", `/api/submissions?q=${uniqueMachine}`);
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(tagged.id));
    assert.ok(!ids.includes(untagged.id));
  });

  test("minScorePercent is inclusive at the boundary", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("scoreband");

    // 60% boundary maps to scoreTotal 15. 64% (16) is above, 56% (14) below.
    const at = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 15 }); // 60%
    const above = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 20 }); // 80%
    const below = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 10 }); // 40%

    const r = await api<SubmissionRow[]>(
      operator.token,
      "GET",
      `/api/submissions?q=${area.tag}&minScorePercent=60`,
    );
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(at.id), "60% boundary must be included");
    assert.ok(ids.includes(above.id), "80% must be included");
    assert.ok(!ids.includes(below.id), "40% must be excluded");
  });

  test("maxScorePercent is inclusive at the boundary", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("ceilband");

    const at = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 15 }); // 60%
    const above = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 20 }); // 80%
    const below = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 10 }); // 40%

    const r = await api<SubmissionRow[]>(
      operator.token,
      "GET",
      `/api/submissions?q=${area.tag}&maxScorePercent=60`,
    );
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(at.id), "60% boundary must be included");
    assert.ok(ids.includes(below.id), "40% must be included");
    assert.ok(!ids.includes(above.id), "80% must be excluded");
  });

  test("min + max combine to a closed score range", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("rangeband");

    const low = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 10 }); // 40%
    const mid = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 15 }); // 60%
    const high = await insertSub({ areaId: area.id, userId: operator.id, scoreTotal: 22 }); // 88%

    const r = await api<SubmissionRow[]>(
      operator.token,
      "GET",
      `/api/submissions?q=${area.tag}&minScorePercent=60&maxScorePercent=80`,
    );
    assert.equal(r.status, 200);
    const ids = r.body.map((row) => row.id);
    assert.ok(ids.includes(mid.id));
    assert.ok(!ids.includes(low.id));
    assert.ok(!ids.includes(high.id));
  });
});

interface RecentRow {
  id: number;
  topActions: string[];
}

describe("GET /api/operator/recent (topActions filtering)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("hides the AI-unavailable fallback from inline action chips", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("fallbackzone");

    // The scoring pipeline writes exactly this single string when the VLM
    // call fails. Operators should see no chips for this row — the chip
    // slot is reserved for actionable re-capture decisions.
    const sub = await insertSub({
      areaId: area.id,
      userId: operator.id,
      scoreTotal: 10,
      suggestionsJson: [AI_UNAVAILABLE_FALLBACK_ACTION],
    });

    const r = await api<RecentRow[]>(operator.token, "GET", "/api/operator/recent");
    assert.equal(r.status, 200);
    const row = r.body.find((x) => x.id === sub.id);
    assert.ok(row, "submission should appear in the recent strip");
    assert.deepEqual(row!.topActions, [], "fallback must not surface as a chip");
  });

  test("keeps real suggestions and only filters out the fallback", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("mixedzone");

    // Mix the fallback alongside real, actionable suggestions. Only the
    // fallback should be removed; the real items still populate up to two
    // chips in their original order.
    const sub = await insertSub({
      areaId: area.id,
      userId: operator.id,
      scoreTotal: 12,
      suggestionsJson: [
        AI_UNAVAILABLE_FALLBACK_ACTION,
        "Wipe down conveyor belt",
        "Re-label chemical bottles",
        "Restock PPE station",
      ],
    });

    const r = await api<RecentRow[]>(operator.token, "GET", "/api/operator/recent");
    assert.equal(r.status, 200);
    const row = r.body.find((x) => x.id === sub.id);
    assert.ok(row, "submission should appear in the recent strip");
    assert.deepEqual(row!.topActions, [
      "Wipe down conveyor belt",
      "Re-label chemical bottles",
    ]);
  });
});
