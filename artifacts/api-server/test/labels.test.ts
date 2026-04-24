import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";

interface LabelShape {
  id: number;
  submissionId: number;
  pillarsJson: { sort: number; set: number; shine: number; standardize: number; sustain: number };
  totalScore: number;
}

describe("POST /api/labels/quick-approve", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("copies aiPillarsJson into the label and recomputes totalScore", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const aiPillars = { sort: 4, set: 3, shine: 5, standardize: 2, sustain: 4 };
    // The displayed scoreJson differs from the AI breakdown — quick-approve
    // must take the AI scores, never the displayed ones.
    const displayed = { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 };
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 5,
        scoreJson: displayed,
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        aiTotalScore: 18,
        aiPillarsJson: aiPillars,
      })
      .returning();

    const r = await api<LabelShape>(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: sub.id,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.submissionId, sub.id);
    assert.deepEqual(r.body.pillarsJson, aiPillars);
    assert.equal(
      r.body.totalScore,
      aiPillars.sort + aiPillars.set + aiPillars.shine + aiPillars.standardize + aiPillars.sustain,
    );
  });

  test("falls back to scoreJson when aiPillarsJson is missing (legacy submissions)", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const score = { sort: 2, set: 2, shine: 2, standardize: 2, sustain: 2 };
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 10,
        scoreJson: score,
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
      })
      .returning();

    const r = await api<LabelShape>(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: sub.id,
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.pillarsJson, score);
    assert.equal(r.body.totalScore, 10);
  });

  test("clamps out-of-range pillar values to 0..5", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const wonky = { sort: 9, set: -2, shine: 3.7, standardize: null, sustain: 4 };
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 0,
        scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        aiPillarsJson: wonky,
      })
      .returning();

    const r = await api<LabelShape>(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: sub.id,
    });
    assert.equal(r.status, 201);
    // sort 9 -> 5, set -2 -> 0, shine 3.7 -> 4 (rounded), standardize null -> 0, sustain 4 -> 4
    assert.deepEqual(r.body.pillarsJson, { sort: 5, set: 0, shine: 4, standardize: 0, sustain: 4 });
    assert.equal(r.body.totalScore, 5 + 0 + 4 + 0 + 4);
  });

  test("a second quick-approve from the same manager updates the existing label", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const aiPillars = { sort: 3, set: 3, shine: 3, standardize: 3, sustain: 3 };
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 15,
        scoreJson: aiPillars,
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        aiPillarsJson: aiPillars,
      })
      .returning();

    const r1 = await api<LabelShape>(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: sub.id,
    });
    const r2 = await api<LabelShape>(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: sub.id,
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r2.body.id, r1.body.id, "second approve must update, not duplicate");
  });

  test("returns 404 for a missing submission", async () => {
    const manager = await world.createUser("MANAGER");
    const r = await api(manager.token, "POST", "/api/labels/quick-approve", {
      submissionId: 999_999_999,
    });
    assert.equal(r.status, 404);
  });

  test("rejects non-managers", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "POST", "/api/labels/quick-approve", {
      submissionId: 1,
    });
    assert.equal(r.status, 403);
  });
});
