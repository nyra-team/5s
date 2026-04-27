import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  recordFfmpegTimeout,
  getFfmpegTimeoutMonitorSnapshot,
  __resetFfmpegTimeoutMonitorForTests,
  __setClockForTests,
} from "../ffmpeg-timeout-monitor.js";
import {
  setOpsAlertNotifierForTesting,
  type OpsAlertPayload,
} from "../notifications.js";

const ENV_KEYS = [
  "FFMPEG_TIMEOUT_ALERT_WINDOW_MS",
  "FFMPEG_TIMEOUT_ALERT_THRESHOLD",
  "FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let captured: OpsAlertPayload[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  __resetFfmpegTimeoutMonitorForTests();
  captured = [];
  // Stub out the ops alert dispatcher so tests don't hit Slack/Resend or the
  // database. Each test asserts on `captured` directly.
  setOpsAlertNotifierForTesting(async (payload) => {
    captured.push(payload);
  });
});

afterEach(() => {
  __setClockForTests(null);
  setOpsAlertNotifierForTesting(null);
  // Reset the rolling window so we don't leak state into sibling test files
  // running in the same vitest fork (the suite uses `singleFork: true`).
  __resetFfmpegTimeoutMonitorForTests();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

function ctx(overrides: Partial<{ videoAbsPath: string; timeoutMs: number; vfilter: string }> = {}) {
  return {
    videoAbsPath: overrides.videoAbsPath ?? "/uploads/test.mp4",
    timeoutMs: overrides.timeoutMs ?? 60_000,
    vfilter: overrides.vfilter ?? "select='gt(scene,0.3)',scale=720:-2",
  };
}

describe("ffmpeg-timeout-monitor — counter", () => {
  it("ticks lifetime and in-window counters on each timeout", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "0"; // disable alert path

    recordFfmpegTimeout(ctx());
    now += 10;
    recordFfmpegTimeout(ctx());
    now += 10;
    recordFfmpegTimeout(ctx());

    const snap = getFfmpegTimeoutMonitorSnapshot();
    expect(snap.lifetimeCount).toBe(3);
    expect(snap.timeoutsInWindow).toBe(3);
    expect(snap.lastAlertAt).toBe(0);
  });

  it("evicts timestamps older than the rolling window", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "1000";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "0";

    recordFfmpegTimeout(ctx());
    now += 500;
    recordFfmpegTimeout(ctx());
    now += 800; // first timestamp now 1300ms old → evicted; second is 800ms old → kept
    recordFfmpegTimeout(ctx());

    const snap = getFfmpegTimeoutMonitorSnapshot();
    expect(snap.timeoutsInWindow).toBe(2);
    // Lifetime counter is monotonic — never decreases on eviction.
    expect(snap.lifetimeCount).toBe(3);
  });
});

describe("ffmpeg-timeout-monitor — alerting", () => {
  it("does not fire below the threshold", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "60000";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "5";
    process.env.FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS = "60000";

    for (let i = 0; i < 4; i++) {
      now += 100;
      recordFfmpegTimeout(ctx());
    }

    expect(captured).toHaveLength(0);
  });

  it("fires exactly once when the in-window count crosses the threshold", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "60000";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "3";
    process.env.FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS = "60000";

    recordFfmpegTimeout(ctx());
    now += 100;
    recordFfmpegTimeout(ctx());
    expect(captured).toHaveLength(0);

    now += 100;
    recordFfmpegTimeout(ctx({ videoAbsPath: "/uploads/last.mp4", timeoutMs: 60_000 }));
    expect(captured).toHaveLength(1);

    const payload = captured[0];
    expect(payload.title).toBe("ffmpeg timeouts spiking");
    expect(payload.message).toContain("3 ffmpeg invocations have timed out");
    expect(payload.message).toContain("threshold 3");
    expect(payload.details).toMatchObject({
      timeoutsInWindow: 3,
      threshold: 3,
      lastVideoAbsPath: "/uploads/last.mp4",
      lastTimeoutMs: 60_000,
    });

    // Subsequent timeouts inside the cooldown should NOT re-fire.
    now += 100;
    recordFfmpegTimeout(ctx());
    now += 100;
    recordFfmpegTimeout(ctx());
    expect(captured).toHaveLength(1);
  });

  it("re-fires after the cooldown expires", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "60000";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "2";
    process.env.FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS = "5000";

    recordFfmpegTimeout(ctx());
    recordFfmpegTimeout(ctx());
    expect(captured).toHaveLength(1);

    // Inside cooldown — suppressed.
    now += 1000;
    recordFfmpegTimeout(ctx());
    expect(captured).toHaveLength(1);

    // Past the cooldown — next breach fires again.
    now += 5000;
    recordFfmpegTimeout(ctx());
    expect(captured).toHaveLength(2);
  });

  it("threshold=0 disables alerting but lifetime counter still ticks", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "0";

    for (let i = 0; i < 50; i++) {
      now += 10;
      recordFfmpegTimeout(ctx());
    }

    expect(captured).toHaveLength(0);
    expect(getFfmpegTimeoutMonitorSnapshot().lifetimeCount).toBe(50);
  });

  it("garbage env values fall back to safe defaults rather than crashing", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "not-a-number";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "-7";
    process.env.FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS = "abc";

    // Default threshold is 5 — five timeouts should still fire one alert.
    for (let i = 0; i < 5; i++) {
      now += 10;
      recordFfmpegTimeout(ctx());
    }

    expect(captured).toHaveLength(1);
  });

  it("evictions can pull the in-window count back below the threshold", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    process.env.FFMPEG_TIMEOUT_ALERT_WINDOW_MS = "1000";
    process.env.FFMPEG_TIMEOUT_ALERT_THRESHOLD = "3";
    // Long cooldown so we can isolate the "did the recount fire?" question
    // from any cooldown effects.
    process.env.FFMPEG_TIMEOUT_ALERT_COOLDOWN_MS = "3600000";

    recordFfmpegTimeout(ctx());
    now += 100;
    recordFfmpegTimeout(ctx());
    // After eviction (window=1000ms), only 1 timeout remains in the window
    // when this third one lands at +1500ms — so we should NOT cross the
    // threshold even though lifetime count is 3.
    now += 1400;
    recordFfmpegTimeout(ctx());

    expect(captured).toHaveLength(0);
    const snap = getFfmpegTimeoutMonitorSnapshot();
    expect(snap.lifetimeCount).toBe(3);
    expect(snap.timeoutsInWindow).toBe(1);
  });
});
