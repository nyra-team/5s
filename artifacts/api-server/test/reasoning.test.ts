import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";

interface SubmissionResponse {
  id: number;
  aiReasoningJson: { sort: string; set: string; shine: string; standardize: string; sustain: string } | null;
}

describe("submission reasoning persistence and surfacing", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("aiReasoningJson round-trips through the DB and is returned by GET /api/submissions/:id", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const reasoning = {
      sort: "frame 1: workspace mostly free of clutter, only a few non-essential items",
      set: "frame 2: tool board labeled, walkways clear",
      shine: "frame 1: floor swept, no visible dust",
      standardize: "frame 3: visual standards posted",
      sustain: "frame 2: today's checklist signed",
    };

    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 18,
        scoreJson: { sort: 4, set: 3, shine: 4, standardize: 3, sustain: 4 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        aiTotalScore: 18,
        aiPillarsJson: { sort: 4, set: 3, shine: 4, standardize: 3, sustain: 4 },
        aiReasoningJson: reasoning,
        scoringMode: "VLM_RUBRIC",
      })
      .returning();

    const r = await api<SubmissionResponse>(operator.token, "GET", `/api/submissions/${sub.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.aiReasoningJson, reasoning);
  });

  test("legacy submissions without reasoning return aiReasoningJson: null", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "B",
        scoreTotal: 10,
        scoreJson: { sort: 2, set: 2, shine: 2, standardize: 2, sustain: 2 },
        suggestionsJson: [],
        imageUrl: "/uploads/legacy.jpg",
        mediaType: "image",
      })
      .returning();

    const r = await api<SubmissionResponse>(operator.token, "GET", `/api/submissions/${sub.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.aiReasoningJson, null);
  });

  test("aiReasoningJson is also returned by the audit-log list endpoint", async () => {
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();
    const reasoning = {
      sort: "r1", set: "r2", shine: "r3", standardize: "r4", sustain: "r5",
    };
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 20,
        scoreJson: { sort: 4, set: 4, shine: 4, standardize: 4, sustain: 4 },
        suggestionsJson: [],
        imageUrl: "/uploads/list.jpg",
        mediaType: "image",
        aiReasoningJson: reasoning,
      })
      .returning();

    const list = await api<SubmissionResponse[]>(operator.token, "GET", `/api/submissions?areaId=${area.id}`);
    assert.equal(list.status, 200);
    const row = list.body.find((r) => r.id === sub.id);
    assert.ok(row, "the freshly-inserted submission should appear in the list");
    assert.deepEqual(row!.aiReasoningJson, reasoning);
  });
});
