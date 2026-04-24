import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, aiScoringMetricsTable } from "@workspace/db";
import { gte } from "drizzle-orm";
import { TestWorld, api } from "./helpers.js";

interface CostRow {
  modelVersion: string;
  callKind: string;
  requestCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  estimatedCostPerCallUsd: number | null;
  estimatedTokensPerCall: number | null;
}
interface CostResponse {
  last7d: CostRow[];
  last30d: CostRow[];
}

/**
 * Per-model cost / latency rollup that lets managers see the spend impact of
 * the gpt-5 upgrade. We cover the aggregation contract end-to-end by writing
 * synthetic metric rows and asserting on the rolled-up values — the real
 * VLM calls that produce them in production live behind a network hop we
 * deliberately don't take in tests.
 */
describe("GET /api/dashboard/ai-cost", () => {
  let world: TestWorld;
  // Other suites also write to ai_scoring_metrics, so we capture the row
  // floor before each test and clean only what we inserted ourselves.
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
    const r = await api(operator.token, "GET", "/api/dashboard/ai-cost");
    assert.equal(r.status, 403);
  });

  test("returns empty arrays when no calls are inside either window", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, thirtyDaysAgo));

    const manager = await world.createUser("MANAGER");
    const r = await api<CostResponse>(
      manager.token,
      "GET",
      "/api/dashboard/ai-cost",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.last7d, []);
    assert.deepEqual(r.body.last30d, []);
  });

  test("aggregates per modelVersion + callKind, computes avg/p95/cost correctly", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, thirtyDaysAgo));

    // Three flagship gpt-5 scoring rows with known latencies/tokens.
    // Latencies: 1000, 2000, 3000 -> avg 2000, p95 (cont) ~2900.
    // Prompt tokens: 1000 each -> 3000; completion: 500 each -> 1500.
    // Pricing: $0.005/1k prompt + $0.015/1k completion =>
    //   3000/1000 * 0.005 + 1500/1000 * 0.015 = 0.015 + 0.0225 = 0.0375 USD.
    await db.insert(aiScoringMetricsTable).values([
      { modelVersion: "gpt-5-factory-v1", retried: false, callKind: "scoring", latencyMs: 1000, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { modelVersion: "gpt-5-factory-v1", retried: false, callKind: "scoring", latencyMs: 2000, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { modelVersion: "gpt-5-factory-v1", retried: false, callKind: "scoring", latencyMs: 3000, promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      // One legacy gpt-5-mini row (so the upgrade impact renders side-by-side).
      // Latency 500ms, prompt 2000, completion 200 =>
      //   2000/1000 * 0.00025 + 200/1000 * 0.002 = 0.0005 + 0.0004 = 0.0009 USD.
      { modelVersion: "gpt-5-mini-factory-v3", retried: false, callKind: "scoring", latencyMs: 500, promptTokens: 2000, completionTokens: 200, totalTokens: 2200 },
      // One identification row at the same flagship modelVersion family —
      // priced under gpt-5 because the prefix matches; aggregated separately
      // because callKind is distinct.
      { modelVersion: "gpt-5-identification-v1", retried: false, callKind: "identification", latencyMs: 800, promptTokens: 500, completionTokens: 100, totalTokens: 600 },
    ]);

    const manager = await world.createUser("MANAGER");
    const r = await api<CostResponse>(
      manager.token,
      "GET",
      "/api/dashboard/ai-cost",
    );
    assert.equal(r.status, 200);

    // Both windows include all five rows (they're all "now").
    assert.equal(r.body.last7d.length, 3);
    assert.equal(r.body.last30d.length, 3);

    // Highest-cost row (flagship scoring) sorts first.
    const flagship = r.body.last7d[0];
    assert.equal(flagship.modelVersion, "gpt-5-factory-v1");
    assert.equal(flagship.callKind, "scoring");
    assert.equal(flagship.requestCount, 3);
    assert.equal(flagship.avgLatencyMs, 2000);
    // PERCENTILE_CONT(0.95) on [1000,2000,3000] linearly interpolates to 2900.
    assert.equal(flagship.p95LatencyMs, 2900);
    assert.equal(flagship.totalPromptTokens, 3000);
    assert.equal(flagship.totalCompletionTokens, 1500);
    assert.equal(flagship.totalTokens, 4500);
    assert.equal(flagship.estimatedCostUsd, 0.0375);
    // 0.0375 / 3 = 0.0125
    assert.equal(flagship.estimatedCostPerCallUsd, 0.0125);
    // 4500 totalTokens / 3 requests = 1500 tokens/call
    assert.equal(flagship.estimatedTokensPerCall, 1500);

    const mini = r.body.last7d.find((row) => row.modelVersion === "gpt-5-mini-factory-v3");
    assert.ok(mini, "expected the gpt-5-mini row to be present");
    assert.equal(mini.callKind, "scoring");
    assert.equal(mini.requestCount, 1);
    assert.equal(mini.avgLatencyMs, 500);
    assert.equal(mini.p95LatencyMs, 500);
    assert.equal(mini.estimatedCostUsd, 0.0009);
    // 2200 totalTokens / 1 request = 2200 tokens/call
    assert.equal(mini.estimatedTokensPerCall, 2200);

    const ident = r.body.last7d.find((row) => row.callKind === "identification");
    assert.ok(ident, "expected the identification row to be present");
    assert.equal(ident.modelVersion, "gpt-5-identification-v1");
    assert.equal(ident.requestCount, 1);
    // 500/1000 * 0.005 + 100/1000 * 0.015 = 0.0025 + 0.0015 = 0.004
    assert.equal(ident.estimatedCostUsd, 0.004);
  });

  test("excludes rows older than the 7d window from last7d but keeps them in last30d", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, thirtyDaysAgo));

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // One row inside last30d but outside last7d.
    await db.insert(aiScoringMetricsTable).values({
      modelVersion: "gpt-5-factory-v1",
      retried: false,
      callKind: "scoring",
      latencyMs: 1500,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      createdAt: tenDaysAgo,
    });
    // One fresh row inside both windows.
    await db.insert(aiScoringMetricsTable).values({
      modelVersion: "gpt-5-factory-v1",
      retried: false,
      callKind: "scoring",
      latencyMs: 2500,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });

    const manager = await world.createUser("MANAGER");
    const r = await api<CostResponse>(
      manager.token,
      "GET",
      "/api/dashboard/ai-cost",
    );
    assert.equal(r.status, 200);

    assert.equal(r.body.last7d.length, 1);
    assert.equal(r.body.last7d[0].requestCount, 1);
    assert.equal(r.body.last7d[0].avgLatencyMs, 2500);

    assert.equal(r.body.last30d.length, 1);
    assert.equal(r.body.last30d[0].requestCount, 2);
    assert.equal(r.body.last30d[0].avgLatencyMs, 2000);

    // Wipe the older row this test created (older than metricFloor).
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, tenDaysAgo));
  });

  test("returns null pricing/cost for unknown modelVersion families", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, thirtyDaysAgo));

    await db.insert(aiScoringMetricsTable).values({
      modelVersion: "claude-3-imaginary",
      retried: false,
      callKind: "scoring",
      latencyMs: 1000,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });

    const manager = await world.createUser("MANAGER");
    const r = await api<CostResponse>(
      manager.token,
      "GET",
      "/api/dashboard/ai-cost",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last7d.length, 1);
    assert.equal(r.body.last7d[0].estimatedCostUsd, null);
    assert.equal(r.body.last7d[0].estimatedCostPerCallUsd, null);
    // Latency + token totals still surface even when pricing is unknown.
    assert.equal(r.body.last7d[0].avgLatencyMs, 1000);
    assert.equal(r.body.last7d[0].totalTokens, 150);
    // Per-call token estimate is independent of pricing — managers still see
    // it for unpriced models so they can compare burn rates.
    assert.equal(r.body.last7d[0].estimatedTokensPerCall, 150);
  });

  test("legacy rows with null latency don't drag the average to 0", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, thirtyDaysAgo));

    // Two rows: one legacy (null latency) + one fresh (3000ms). avg(latency)
    // should ignore the null and return 3000, not 1500.
    await db.insert(aiScoringMetricsTable).values([
      {
        modelVersion: "gpt-5-factory-v1",
        retried: false,
        callKind: "scoring",
        latencyMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
      {
        modelVersion: "gpt-5-factory-v1",
        retried: false,
        callKind: "scoring",
        latencyMs: 3000,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
    ]);

    const manager = await world.createUser("MANAGER");
    const r = await api<CostResponse>(
      manager.token,
      "GET",
      "/api/dashboard/ai-cost",
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.last7d.length, 1);
    assert.equal(r.body.last7d[0].requestCount, 2);
    assert.equal(r.body.last7d[0].avgLatencyMs, 3000);
    assert.equal(r.body.last7d[0].totalTokens, 150);
  });
});
