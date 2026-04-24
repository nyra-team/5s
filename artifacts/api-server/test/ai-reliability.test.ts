import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { gte } from "drizzle-orm";
import { TestWorld, api } from "./helpers.js";

interface ReliabilityErrorBreakdown {
  message: string;
  count: number;
}
interface ReliabilityWindow {
  totalCalls: number;
  retriedCalls: number;
  retryRate: number;
  topErrors: ReliabilityErrorBreakdown[];
}
interface ReliabilityShape {
  last24h: ReliabilityWindow;
  last7d: ReliabilityWindow;
}

/**
 * The dashboard surfaces how often the AI scoring pipeline had to retry its
 * first response. We exercise the rolling 24h / 7d aggregates by writing
 * synthetic metric rows directly — the real callVLM path that produces them
 * lives behind an external model call we don't want to hit in tests.
 */
describe("GET /api/dashboard/ai-reliability", () => {
  let world: TestWorld;
  // We only assert on rows we just inserted within the windows below, so we
  // capture the row floor before each test and filter to it during cleanup.
  // Other suites in the run may also write metric rows.
  let metricFloor: Date;

  beforeEach(() => {
    world = new TestWorld();
    metricFloor = new Date();
  });

  afterEach(async () => {
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, metricFloor));
    await world.cleanup();
  });

  test("requires a manager", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "GET", "/api/dashboard/ai-reliability");
    assert.equal(r.status, 403);
  });

  test("returns zero stats and rate=0 when no calls have happened in the window", async () => {
    // To make the windows reliably empty we ensure no rows exist newer than
    // the last 7d. Other tests may have left rows older than that — those
    // legitimately fall outside both windows, so we don't need to delete them.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last24h.totalCalls, 0);
    assert.equal(r.body.last24h.retriedCalls, 0);
    assert.equal(r.body.last24h.retryRate, 0);
    assert.deepEqual(r.body.last24h.topErrors, []);
    assert.equal(r.body.last7d.totalCalls, 0);
    assert.equal(r.body.last7d.retriedCalls, 0);
    assert.equal(r.body.last7d.retryRate, 0);
    assert.deepEqual(r.body.last7d.topErrors, []);
  });

  test("counts retried vs clean calls inside the rolling 24h window", async () => {
    // Wipe the slate inside the 7d window so we can assert exact counts.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    // 3 clean calls (today) + 1 retried call (today) = 25% retry rate
    await db.insert(aiScoringMetricsTable).values([
      { modelVersion: "test-model", retried: false, validationError: null },
      { modelVersion: "test-model", retried: false, validationError: null },
      { modelVersion: "test-model", retried: false, validationError: null },
      {
        modelVersion: "test-model",
        retried: true,
        validationError: "missing object 'pillar_scores'",
      },
    ]);

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last24h.totalCalls, 4);
    assert.equal(r.body.last24h.retriedCalls, 1);
    assert.equal(r.body.last24h.retryRate, 0.25);
    // The single retried row's validation message shows up in the breakdown.
    assert.deepEqual(r.body.last24h.topErrors, [
      { message: "missing object 'pillar_scores'", count: 1 },
    ]);
    // 7d window includes the same rows.
    assert.equal(r.body.last7d.totalCalls, 4);
    assert.equal(r.body.last7d.retriedCalls, 1);
    assert.equal(r.body.last7d.retryRate, 0.25);
    assert.deepEqual(r.body.last7d.topErrors, [
      { message: "missing object 'pillar_scores'", count: 1 },
    ]);
  });

  test("groups distinct validation messages and orders them by frequency", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    // Three messages with different frequencies, plus a clean call to prove
    // it's excluded, plus a retried row with a NULL message to prove that's
    // also excluded from the breakdown (but still counted in retriedCalls).
    await db.insert(aiScoringMetricsTable).values([
      { modelVersion: "test-model", retried: true, validationError: "missing object 'pillar_scores'" },
      { modelVersion: "test-model", retried: true, validationError: "missing object 'pillar_scores'" },
      { modelVersion: "test-model", retried: true, validationError: "missing object 'pillar_scores'" },
      { modelVersion: "test-model", retried: true, validationError: "score out of range" },
      { modelVersion: "test-model", retried: true, validationError: "score out of range" },
      { modelVersion: "test-model", retried: true, validationError: "reasoning is not a string" },
      { modelVersion: "test-model", retried: true, validationError: null },
      { modelVersion: "test-model", retried: false, validationError: null },
    ]);

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last24h.totalCalls, 8);
    // 7 retried rows total, regardless of whether their message is null.
    assert.equal(r.body.last24h.retriedCalls, 7);
    // Sorted by count desc; the clean row and the null-message retried row
    // never appear in the breakdown.
    assert.deepEqual(r.body.last24h.topErrors, [
      { message: "missing object 'pillar_scores'", count: 3 },
      { message: "score out of range", count: 2 },
      { message: "reasoning is not a string", count: 1 },
    ]);
  });

  test("caps the breakdown at the top-N most frequent messages", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    // 7 distinct messages — more than the server's top-N cap of 5.
    const distinctMessages = [
      "err-a", "err-b", "err-c", "err-d", "err-e", "err-f", "err-g",
    ];
    await db.insert(aiScoringMetricsTable).values(
      distinctMessages.map((m) => ({
        modelVersion: "test-model",
        retried: true,
        validationError: m,
      })),
    );

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    // Each message appears once, so we can't predict which 5 of 7 ties win,
    // but we can assert the cap and that every returned message is one of
    // the originals with count=1.
    assert.equal(r.body.last24h.topErrors.length, 5);
    for (const e of r.body.last24h.topErrors) {
      assert.equal(e.count, 1);
      assert.ok(distinctMessages.includes(e.message));
    }
  });

  test("identification rows do not dilute the scoring retry-rate denominator", async () => {
    // Regression: ai_scoring_metrics is now shared by both the scoring and
    // identification pipelines. Identification calls always have
    // retried=false (no JSON-validation retry loop), so if the reliability
    // rollup counted them they'd quietly push the retry rate down whenever
    // identification traffic spiked. The endpoint must filter to
    // callKind="scoring" to keep this KPI honest.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    // 1 retried scoring call out of 2 scoring calls -> 50% retry rate.
    // Plus 8 identification calls that should be IGNORED entirely (they'd
    // otherwise drop the rate to 1/10 = 10%).
    await db.insert(aiScoringMetricsTable).values([
      { modelVersion: "gpt-5-factory-v1", retried: false, callKind: "scoring", validationError: null },
      { modelVersion: "gpt-5-factory-v1", retried: true, callKind: "scoring", validationError: "missing object 'pillar_scores'" },
      ...Array.from({ length: 8 }, () => ({
        modelVersion: "gpt-5-identification-v1",
        retried: false,
        callKind: "identification" as const,
        validationError: null,
      })),
    ]);

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last24h.totalCalls, 2);
    assert.equal(r.body.last24h.retriedCalls, 1);
    assert.equal(r.body.last24h.retryRate, 0.5);
    assert.equal(r.body.last7d.totalCalls, 2);
    assert.equal(r.body.last7d.retriedCalls, 1);
    assert.equal(r.body.last7d.retryRate, 0.5);
  });

  test("excludes rows older than the rolling 7d window", async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, sevenDaysAgo));

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // Insert one ancient row (outside both windows) and one fresh one (inside both).
    await db.insert(aiScoringMetricsTable).values({
      modelVersion: "test-model",
      retried: true,
      validationError: "ancient",
      createdAt: eightDaysAgo,
    });
    await db.insert(aiScoringMetricsTable).values({
      modelVersion: "test-model",
      retried: false,
      validationError: null,
    });

    const manager = await world.createUser("MANAGER");
    const r = await api<ReliabilityShape>(
      manager.token,
      "GET",
      "/api/dashboard/ai-reliability",
    );
    assert.equal(r.status, 200);
    // Only the fresh clean row falls inside both windows.
    assert.equal(r.body.last24h.totalCalls, 1);
    assert.equal(r.body.last24h.retriedCalls, 0);
    assert.equal(r.body.last24h.retryRate, 0);
    assert.equal(r.body.last7d.totalCalls, 1);
    assert.equal(r.body.last7d.retriedCalls, 0);
    assert.equal(r.body.last7d.retryRate, 0);

    // Manually wipe the older-than-floor row this test created.
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, eightDaysAgo));
  });
});
