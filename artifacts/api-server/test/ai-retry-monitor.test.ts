import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gte } from "drizzle-orm";
import { db, aiScoringMetricsTable } from "@workspace/db";
import {
  setAiRetrySpikeNotifierForTesting,
  type AiRetrySpikeNotification,
} from "../src/lib/notifications.js";
import {
  resetRetrySpikeStateForTesting,
  runRetrySpikeCheck,
} from "../src/lib/ai-reliability.js";

/**
 * End-to-end coverage for the periodic retry-rate spike alert. We seed
 * synthetic metric rows (the real callVLM path is behind an external model
 * call we don't want to hit), invoke the sweep, and assert the recorder
 * receives the right payload — including the cooldown invariant ("once per
 * incident") that's the whole reason this monitor exists.
 *
 * We use the same swappable-notifier seam as the reping scheduler tests so
 * we don't have to monkey-patch fetch or stand up a fake Slack endpoint.
 */
function installRecorder(): {
  calls: AiRetrySpikeNotification[];
  restore: () => void;
} {
  const calls: AiRetrySpikeNotification[] = [];
  const prev = setAiRetrySpikeNotifierForTesting(async (payload) => {
    calls.push(payload);
  });
  return {
    calls,
    restore: () => {
      setAiRetrySpikeNotifierForTesting(prev);
    },
  };
}

describe("runRetrySpikeCheck", () => {
  let recorder: ReturnType<typeof installRecorder>;
  // Every metric row we insert during this suite is newer than `metricFloor`,
  // so cleanup can scope deletion to just the rows we created.
  let metricFloor: Date;
  const ENV_KEYS = [
    "AI_RETRY_ALERT_THRESHOLD",
    "AI_RETRY_ALERT_MIN_SAMPLE",
    "AI_RETRY_ALERT_WINDOW_MS",
    "AI_RETRY_ALERT_COOLDOWN_MS",
  ];
  const ORIGINAL_ENV: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
    // Pin to defaults so a developer with overrides in their shell can't
    // change the meaning of these tests.
    process.env.AI_RETRY_ALERT_THRESHOLD = "0.15";
    process.env.AI_RETRY_ALERT_MIN_SAMPLE = "20";
    process.env.AI_RETRY_ALERT_WINDOW_MS = String(60 * 60 * 1000);
    process.env.AI_RETRY_ALERT_COOLDOWN_MS = String(4 * 60 * 60 * 1000);

    resetRetrySpikeStateForTesting();
    recorder = installRecorder();
    metricFloor = new Date();
    // Wipe any rows newer than the start of the rolling window so a previous
    // suite's leftovers can't affect the totals we're about to assert on.
    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, windowStart));
  });

  afterEach(async () => {
    recorder.restore();
    resetRetrySpikeStateForTesting();
    await db
      .delete(aiScoringMetricsTable)
      .where(gte(aiScoringMetricsTable.createdAt, metricFloor));
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL_ENV[k];
    }
  });

  test("alerts managers once when the recent retry rate crosses the threshold", async () => {
    // 30 calls, 9 retried = 30% rate — comfortably above 15% threshold and
    // past the 20-sample minimum, so the very first sweep should fire.
    const rows = [];
    for (let i = 0; i < 21; i++) {
      rows.push({ modelVersion: "test-model", retried: false, validationError: null });
    }
    for (let i = 0; i < 9; i++) {
      rows.push({
        modelVersion: "test-model",
        retried: true,
        validationError: "missing object 'pillar_scores'",
      });
    }
    await db.insert(aiScoringMetricsTable).values(rows);

    const result = await runRetrySpikeCheck();

    assert.equal(result.alerted, true);
    assert.equal(result.decision.reason, "ALERT");
    assert.equal(recorder.calls.length, 1, "managers must be alerted exactly once");
    const payload = recorder.calls[0];
    assert.equal(payload.totalCalls, 30);
    assert.equal(payload.retriedCalls, 9);
    assert.equal(payload.retryRate, 9 / 30);
    assert.equal(payload.thresholdRate, 0.15);
    assert.equal(payload.windowMs, 60 * 60 * 1000);
  });

  test("stays quiet when the rate is healthy (below threshold)", async () => {
    // 100 calls with only 5 retried = 5% — well within tolerance.
    const rows = [];
    for (let i = 0; i < 95; i++) {
      rows.push({ modelVersion: "test-model", retried: false, validationError: null });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ modelVersion: "test-model", retried: true, validationError: "x" });
    }
    await db.insert(aiScoringMetricsTable).values(rows);

    const result = await runRetrySpikeCheck();

    assert.equal(result.alerted, false);
    assert.equal(result.decision.reason, "BELOW_THRESHOLD");
    assert.equal(recorder.calls.length, 0);
  });

  test("stays quiet when the sample is below the minimum (1/2 = 50% is noise)", async () => {
    await db.insert(aiScoringMetricsTable).values([
      { modelVersion: "test-model", retried: false, validationError: null },
      { modelVersion: "test-model", retried: true, validationError: "x" },
    ]);

    const result = await runRetrySpikeCheck();

    assert.equal(result.alerted, false);
    assert.equal(result.decision.reason, "INSUFFICIENT_SAMPLE");
    assert.equal(recorder.calls.length, 0);
  });

  test("cooldown suppresses a second alert in the same incident", async () => {
    // Bump the rolling window to 12h for this test specifically. The third
    // sweep below virtually fast-forwards `now` by 5 hours; with the default
    // 1h window the rows we just inserted would fall out of view, so the
    // test wouldn't actually be exercising the cooldown — it'd be measuring
    // "no rows in window" instead.
    process.env.AI_RETRY_ALERT_WINDOW_MS = String(12 * 60 * 60 * 1000);

    // Same 30%-retry seed as the happy-path test.
    const rows = [];
    for (let i = 0; i < 21; i++) {
      rows.push({ modelVersion: "test-model", retried: false, validationError: null });
    }
    for (let i = 0; i < 9; i++) {
      rows.push({ modelVersion: "test-model", retried: true, validationError: "x" });
    }
    await db.insert(aiScoringMetricsTable).values(rows);

    // First sweep: alert fires.
    const r1 = await runRetrySpikeCheck();
    assert.equal(r1.alerted, true);
    assert.equal(recorder.calls.length, 1);

    // Second sweep, immediately after: cooldown active, no second alert.
    const r2 = await runRetrySpikeCheck();
    assert.equal(r2.alerted, false);
    assert.equal(r2.decision.reason, "IN_COOLDOWN");
    assert.equal(recorder.calls.length, 1, "cooldown must prevent duplicate alerts");

    // Fast-forward past the cooldown by passing a `now` 5 hours ahead.
    // The rate is still elevated, so the monitor should re-alert.
    const fiveHoursLater = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const r3 = await runRetrySpikeCheck(fiveHoursLater);
    assert.equal(r3.alerted, true);
    assert.equal(r3.decision.reason, "ALERT");
    assert.equal(
      recorder.calls.length,
      2,
      "after cooldown elapses, a still-elevated rate re-alerts",
    );
  });

  test("ignores rows older than the rolling window", async () => {
    // 25 retried calls 2 hours ago — outside the 1h window, must not count.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const rows = [];
    for (let i = 0; i < 25; i++) {
      rows.push({
        modelVersion: "test-model",
        retried: true,
        validationError: "stale",
        createdAt: twoHoursAgo,
      });
    }
    // Plus 5 healthy calls inside the window — totals 5/0 retried = 0%.
    for (let i = 0; i < 5; i++) {
      rows.push({ modelVersion: "test-model", retried: false, validationError: null });
    }
    await db.insert(aiScoringMetricsTable).values(rows);

    const result = await runRetrySpikeCheck();

    // Window-scoped sample (5) is below minSample(20) — that's the right
    // suppression reason here, and proves the older rows didn't slip in.
    assert.equal(result.alerted, false);
    assert.equal(result.stats.totalCalls, 5);
    assert.equal(result.stats.retriedCalls, 0);
    assert.equal(recorder.calls.length, 0);
  });
});
