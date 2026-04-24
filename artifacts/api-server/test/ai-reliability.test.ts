import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { gte } from "drizzle-orm";
import { TestWorld, api } from "./helpers.js";

interface ReliabilityWindow {
  totalCalls: number;
  retriedCalls: number;
  retryRate: number;
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
    assert.equal(r.body.last7d.totalCalls, 0);
    assert.equal(r.body.last7d.retriedCalls, 0);
    assert.equal(r.body.last7d.retryRate, 0);
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
    // 7d window includes the same rows.
    assert.equal(r.body.last7d.totalCalls, 4);
    assert.equal(r.body.last7d.retriedCalls, 1);
    assert.equal(r.body.last7d.retryRate, 0.25);
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
