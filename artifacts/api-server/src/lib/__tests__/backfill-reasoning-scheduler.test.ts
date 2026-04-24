import { describe, it, expect } from "vitest";
import {
  isInQuietHoursUtc,
  quietHoursWindowKey,
  readBackfillSchedulerConfig,
} from "../backfill-reasoning-scheduler";

/**
 * Pure-logic tests for the nightly backfill scheduler. Database-touching
 * behaviour (the actual batch run + per-window dedup) is covered by
 * `test/backfill-reasoning-scheduler.test.ts` against the per-run Postgres
 * fixture so the timing predicates here can be exercised without standing
 * up the integration harness.
 */

function utc(iso: string): Date {
  // iso looks like "2026-04-22T03:30" — interpreted as UTC.
  return new Date(`${iso}:00Z`);
}

describe("isInQuietHoursUtc", () => {
  it("same-day window: includes start, excludes end", () => {
    expect(isInQuietHoursUtc(utc("2026-04-22T07:00"), 7, 11)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-22T10:59"), 7, 11)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-22T11:00"), 7, 11)).toBe(false);
    expect(isInQuietHoursUtc(utc("2026-04-22T06:59"), 7, 11)).toBe(false);
  });

  it("wrap-around window: matches both halves", () => {
    // 22:00 → 05:00 UTC (i.e. late night to early morning).
    expect(isInQuietHoursUtc(utc("2026-04-22T22:00"), 22, 5)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-22T23:30"), 22, 5)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-23T00:30"), 22, 5)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-23T04:59"), 22, 5)).toBe(true);
    expect(isInQuietHoursUtc(utc("2026-04-23T05:00"), 22, 5)).toBe(false);
    expect(isInQuietHoursUtc(utc("2026-04-22T21:59"), 22, 5)).toBe(false);
  });

  it("start === end is treated as an empty window (never active)", () => {
    // Footgun guard: don't let "always on" sneak in via a config typo.
    expect(isInQuietHoursUtc(utc("2026-04-22T07:00"), 7, 7)).toBe(false);
    expect(isInQuietHoursUtc(utc("2026-04-22T18:00"), 7, 7)).toBe(false);
  });
});

describe("quietHoursWindowKey", () => {
  it("returns null outside the window", () => {
    expect(quietHoursWindowKey(utc("2026-04-22T18:00"), 7, 11)).toBeNull();
    expect(quietHoursWindowKey(utc("2026-04-22T11:00"), 7, 11)).toBeNull();
  });

  it("same-day window: keyed to the day the window opens", () => {
    expect(quietHoursWindowKey(utc("2026-04-22T07:00"), 7, 11)).toBe("2026-04-22");
    expect(quietHoursWindowKey(utc("2026-04-22T10:59"), 7, 11)).toBe("2026-04-22");
  });

  it("wrap-around window: late-night and next-morning halves share one key", () => {
    // Both readings should point at the day the window opened (2026-04-22).
    expect(quietHoursWindowKey(utc("2026-04-22T23:30"), 22, 5)).toBe("2026-04-22");
    expect(quietHoursWindowKey(utc("2026-04-23T03:00"), 22, 5)).toBe("2026-04-22");
    // The next window opens that evening and is keyed to 2026-04-23.
    expect(quietHoursWindowKey(utc("2026-04-23T22:30"), 22, 5)).toBe("2026-04-23");
  });
});

describe("readBackfillSchedulerConfig", () => {
  it("falls back to defaults when nothing is set", () => {
    const KEYS = [
      "BACKFILL_REASONING_ENABLED",
      "BACKFILL_REASONING_BATCH_SIZE",
      "BACKFILL_REASONING_QUIET_START_HOUR_UTC",
      "BACKFILL_REASONING_QUIET_END_HOUR_UTC",
      "BACKFILL_REASONING_CHECK_INTERVAL_MS",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const config = readBackfillSchedulerConfig();
      expect(config.enabled).toBe(true);
      expect(config.batchSize).toBe(25);
      expect(config.quietStartHourUtc).toBe(7);
      expect(config.quietEndHourUtc).toBe(11);
      expect(config.checkIntervalMs).toBe(5 * 60_000);
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("applies overrides and caps batch size at 100", () => {
    const saved = {
      enabled: process.env.BACKFILL_REASONING_ENABLED,
      batch: process.env.BACKFILL_REASONING_BATCH_SIZE,
      start: process.env.BACKFILL_REASONING_QUIET_START_HOUR_UTC,
      end: process.env.BACKFILL_REASONING_QUIET_END_HOUR_UTC,
      tick: process.env.BACKFILL_REASONING_CHECK_INTERVAL_MS,
    };
    try {
      process.env.BACKFILL_REASONING_ENABLED = "false";
      process.env.BACKFILL_REASONING_BATCH_SIZE = "9999";
      process.env.BACKFILL_REASONING_QUIET_START_HOUR_UTC = "22";
      process.env.BACKFILL_REASONING_QUIET_END_HOUR_UTC = "5";
      process.env.BACKFILL_REASONING_CHECK_INTERVAL_MS = "60000";
      const config = readBackfillSchedulerConfig();
      expect(config.enabled).toBe(false);
      expect(config.batchSize).toBe(100);
      expect(config.quietStartHourUtc).toBe(22);
      expect(config.quietEndHourUtc).toBe(5);
      expect(config.checkIntervalMs).toBe(60_000);
    } finally {
      for (const [k, v] of Object.entries({
        BACKFILL_REASONING_ENABLED: saved.enabled,
        BACKFILL_REASONING_BATCH_SIZE: saved.batch,
        BACKFILL_REASONING_QUIET_START_HOUR_UTC: saved.start,
        BACKFILL_REASONING_QUIET_END_HOUR_UTC: saved.end,
        BACKFILL_REASONING_CHECK_INTERVAL_MS: saved.tick,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("ignores out-of-range hours and falls back to defaults", () => {
    const saved = {
      start: process.env.BACKFILL_REASONING_QUIET_START_HOUR_UTC,
      end: process.env.BACKFILL_REASONING_QUIET_END_HOUR_UTC,
    };
    try {
      process.env.BACKFILL_REASONING_QUIET_START_HOUR_UTC = "99";
      process.env.BACKFILL_REASONING_QUIET_END_HOUR_UTC = "-1";
      const config = readBackfillSchedulerConfig();
      expect(config.quietStartHourUtc).toBe(7);
      expect(config.quietEndHourUtc).toBe(11);
    } finally {
      for (const [k, v] of Object.entries({
        BACKFILL_REASONING_QUIET_START_HOUR_UTC: saved.start,
        BACKFILL_REASONING_QUIET_END_HOUR_UTC: saved.end,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
