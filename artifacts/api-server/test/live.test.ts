import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, submissionsTable, escalationsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";
import { getCurrentShift, getISTShiftRange } from "../src/lib/scoring.js";

interface LiveResp {
  shift: string;
  pendingAreas: { areaId: number }[];
  lowScoring: { submissionId: number; areaId: number; scorePercent: number }[];
  openEscalations: {
    id: number;
    repingCount: number;
    lastRepingAt: string | null;
  }[];
}

describe("GET /api/shift/live (IST shift filtering)", () => {
  let world: TestWorld;
  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => { await world.cleanup(); });

  test("only counts submissions whose shift label matches AND whose timestamp is in the IST window", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");

    // Three test areas: in-shift (with submission), other-shift (with
    // submission whose shift label differs), and pending (no submission).
    const inShiftArea = await world.createArea("InShift");
    const otherShiftArea = await world.createArea("OtherShift");
    const pendingArea = await world.createArea("Pending");

    const { shift } = getCurrentShift();
    const otherShift = shift === "A" ? "B" : "A";
    const { start, end } = getISTShiftRange(undefined, shift);
    const inWindow = new Date((start.getTime() + end.getTime()) / 2);
    const beforeWindow = new Date(start.getTime() - 60 * 60 * 1000);

    // 1) In current shift, in window, low score (40%) — should count.
    const [inShiftLow] = await db
      .insert(submissionsTable)
      .values({
        areaId: inShiftArea.id,
        userId: operator.id,
        shift,
        scoreTotal: 10,
        scoreJson: { sort: 2, set: 2, shine: 2, standardize: 2, sustain: 2 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        createdAt: inWindow,
      })
      .returning();

    // 2) Other shift label, but timestamp lands in the current window — must
    // be excluded by the shift filter, AND must NOT mark its area as
    // "submitted" for the current shift.
    const [otherShiftSub] = await db
      .insert(submissionsTable)
      .values({
        areaId: otherShiftArea.id,
        userId: operator.id,
        shift: otherShift,
        scoreTotal: 5,
        scoreJson: { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        createdAt: inWindow,
      })
      .returning();

    // 3) Same area as #1 but timestamp is before the current window — must
    // be excluded by the time filter (it's a previous occurrence of the same
    // shift label, e.g. yesterday's shift A).
    const [outOfWindowSub] = await db
      .insert(submissionsTable)
      .values({
        areaId: inShiftArea.id,
        userId: operator.id,
        shift,
        scoreTotal: 8,
        scoreJson: { sort: 2, set: 2, shine: 2, standardize: 1, sustain: 1 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
        createdAt: beforeWindow,
      })
      .returning();

    const r = await api<LiveResp>(manager.token, "GET", "/api/shift/live");
    assert.equal(r.status, 200);
    assert.equal(r.body.shift, shift, "response shift must match the server's current shift");

    // pendingAreas: the one with NO in-window-current-shift submission must
    // be pending; the one whose only submission has the wrong shift label
    // must also be pending; the one with a matching submission must NOT.
    const pendingIds = new Set(r.body.pendingAreas.map((p) => p.areaId));
    assert.ok(pendingIds.has(pendingArea.id), "untouched area must be pending");
    assert.ok(
      pendingIds.has(otherShiftArea.id),
      "area whose submission is from a different shift must still be pending",
    );
    assert.ok(
      !pendingIds.has(inShiftArea.id),
      "area with an in-window matching-shift submission must NOT be pending",
    );

    // lowScoring: only the in-window matching-shift low submission should
    // appear; the other-shift and out-of-window ones must be filtered out.
    const lowIds = new Set(r.body.lowScoring.map((l) => l.submissionId));
    assert.ok(lowIds.has(inShiftLow.id), "in-window low-score submission should appear");
    assert.ok(!lowIds.has(otherShiftSub.id), "other-shift submission must be excluded");
    assert.ok(!lowIds.has(outOfWindowSub.id), "out-of-window submission must be excluded");

    // Sanity check on the score percent math (10 * 4 = 40).
    const ours = r.body.lowScoring.find((l) => l.submissionId === inShiftLow.id);
    assert.ok(ours);
    assert.equal(ours.scorePercent, 40);
  });

  test("openEscalations surfaces repingCount and lastRepingAt for the live page badge", async () => {
    // Mirrors the inbox's "Reminded Nx · 12m ago" badge: managers triaging
    // from the live snapshot need the same signal so they don't double-poke
    // a team that the re-ping scheduler already auto-reminded.
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea("Reping");

    const { shift } = getCurrentShift();
    const [sub] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift,
        scoreTotal: 10,
        scoreJson: { sort: 2, set: 2, shine: 2, standardize: 2, sustain: 2 },
        suggestionsJson: [],
        imageUrl: "/uploads/test.jpg",
        mediaType: "image",
      })
      .returning();

    const lastRepingAt = new Date(Date.now() - 12 * 60_000);
    const [esc] = await db
      .insert(escalationsTable)
      .values({
        submissionId: sub.id,
        areaId: area.id,
        operatorId: operator.id,
        scoreTotal: 10,
        scorePercent: 40,
        failingPillarsJson: ["sort"],
        recommendedActionsJson: ["wipe down"],
        status: "OPEN",
        repingCount: 2,
        lastRepingAt,
      })
      .returning();

    const r = await api<LiveResp>(manager.token, "GET", "/api/shift/live");
    assert.equal(r.status, 200);
    const ours = r.body.openEscalations.find((e) => e.id === esc.id);
    assert.ok(ours, "seeded open escalation must appear in openEscalations");
    assert.equal(ours.repingCount, 2);
    assert.ok(ours.lastRepingAt, "lastRepingAt must be present when set");
    assert.equal(
      new Date(ours.lastRepingAt).getTime(),
      lastRepingAt.getTime(),
      "lastRepingAt must round-trip through JSON serialization",
    );
  });

  test("rejects non-managers", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "GET", "/api/shift/live");
    assert.equal(r.status, 403);
  });

  test("requires authentication", async () => {
    const r = await api(null, "GET", "/api/shift/live");
    assert.equal(r.status, 401);
  });
});
