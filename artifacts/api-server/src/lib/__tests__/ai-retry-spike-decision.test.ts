import { describe, expect, it } from "vitest";
import {
  evaluateRetrySpike,
  type AiRetryStats,
  type RetrySpikeConfig,
} from "../ai-reliability.js";

/**
 * Pure-function coverage for the retry-rate alert decision. Anchored on a
 * fixed `now` so cooldown maths is deterministic. The integration test
 * (`test/ai-retry-monitor.test.ts`) covers the database wiring; here we
 * just verify the four decision branches (alert, below threshold,
 * insufficient sample, in cooldown) so future tweaks to the policy can't
 * silently flip behaviour without a failing test.
 */

const NOW = new Date("2026-04-24T12:00:00Z");

const CONFIG: RetrySpikeConfig = {
  threshold: 0.15,
  minSample: 20,
  windowMs: 60 * 60 * 1000,
  cooldownMs: 4 * 60 * 60 * 1000,
  checkIntervalMs: 60 * 60 * 1000,
};

function stats(totalCalls: number, retriedCalls: number): AiRetryStats {
  return {
    totalCalls,
    retriedCalls,
    retryRate: totalCalls > 0 ? retriedCalls / totalCalls : 0,
  };
}

describe("evaluateRetrySpike", () => {
  it("alerts when the rate is above threshold and the sample is large enough", () => {
    // 25% retry rate over 100 calls — comfortably above 15% threshold and
    // well past the 20-sample minimum.
    const decision = evaluateRetrySpike(stats(100, 25), CONFIG, null, NOW);
    expect(decision).toEqual({ shouldAlert: true, reason: "ALERT" });
  });

  it("suppresses when the sample is too small to be signal", () => {
    // 50% over 4 calls is noise, not a regression — managers should not be
    // pinged about a model "misbehaving" we can't statistically detect yet.
    const decision = evaluateRetrySpike(stats(4, 2), CONFIG, null, NOW);
    expect(decision).toEqual({
      shouldAlert: false,
      reason: "INSUFFICIENT_SAMPLE",
    });
  });

  it("suppresses when the rate is below the misbehaving threshold", () => {
    // 10% retry rate over a healthy 50-call sample — within tolerance.
    const decision = evaluateRetrySpike(stats(50, 5), CONFIG, null, NOW);
    expect(decision).toEqual({
      shouldAlert: false,
      reason: "BELOW_THRESHOLD",
    });
  });

  it("respects the cooldown after a recent alert", () => {
    // We just paged 1 hour ago — the rate is still elevated, but we promised
    // managers one alert per incident, not one per sweep. Stay quiet.
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
    const decision = evaluateRetrySpike(stats(100, 25), CONFIG, oneHourAgo, NOW);
    expect(decision).toEqual({ shouldAlert: false, reason: "IN_COOLDOWN" });
  });

  it("re-alerts after the cooldown elapses if the rate is still elevated", () => {
    // 5h since last alert — past the 4h cooldown. If the rate is still
    // high it means the incident never recovered and managers should know.
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
    const decision = evaluateRetrySpike(stats(100, 25), CONFIG, fiveHoursAgo, NOW);
    expect(decision).toEqual({ shouldAlert: true, reason: "ALERT" });
  });

  it("treats the threshold as inclusive (rate exactly at threshold alerts)", () => {
    // 15.0% rate over 100 calls — sitting on the line. Treat the boundary
    // as "misbehaving" so a model regression that nudges right to the limit
    // is caught rather than silently tolerated.
    const decision = evaluateRetrySpike(stats(100, 15), CONFIG, null, NOW);
    expect(decision).toEqual({ shouldAlert: true, reason: "ALERT" });
  });

  it("treats the min-sample boundary as inclusive (sample = minSample alerts)", () => {
    // Exactly 20 calls with 20% retried — at the minimum sample, threshold
    // crossed, no cooldown active.
    const decision = evaluateRetrySpike(stats(20, 4), CONFIG, null, NOW);
    expect(decision).toEqual({ shouldAlert: true, reason: "ALERT" });
  });

  it("checks sample size before threshold (small but high rate suppressed as INSUFFICIENT_SAMPLE)", () => {
    // 100% retried over 1 call — both checks "fail", but the suppression
    // reason should reflect the sample-size guard so dashboards/logs report
    // the actual root cause, not a misleading "below threshold".
    const decision = evaluateRetrySpike(stats(1, 1), CONFIG, null, NOW);
    expect(decision).toEqual({
      shouldAlert: false,
      reason: "INSUFFICIENT_SAMPLE",
    });
  });
});
