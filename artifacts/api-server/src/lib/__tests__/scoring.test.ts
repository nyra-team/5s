import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetShiftConfigCache,
  formatZonedDate,
  getCurrentShift,
  getISTDayRange,
  getISTShiftRange,
  getShiftConfig,
  getZonedParts,
  zonedToUtc,
} from "../scoring";

/**
 * Pure-function tests for the configurable shift schedule. These intentionally
 * do not touch the database — the helpers under test work entirely off env
 * vars and Intl.DateTimeFormat, so we can exercise multiple timezones and
 * DST boundaries without integration setup.
 */

const SHIFT_ENV_KEYS = [
  "SHIFT_TIMEZONE",
  "SHIFT_A_START_HOUR",
  "SHIFT_B_START_HOUR",
  "SHIFT_C_START_HOUR",
];

function clearShiftEnv() {
  for (const k of SHIFT_ENV_KEYS) delete process.env[k];
  _resetShiftConfigCache();
}

function setShiftEnv(env: Record<string, string | undefined>) {
  for (const k of SHIFT_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  _resetShiftConfigCache();
}

describe("getShiftConfig (env-driven)", () => {
  beforeEach(() => clearShiftEnv());

  it("falls back to legacy IST schedule when no env vars are set", () => {
    expect(getShiftConfig()).toEqual({
      timeZone: "Asia/Kolkata",
      startHours: { A: 6, B: 14, C: 22 },
    });
  });

  it("uses configured timezone and shift start hours", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    expect(getShiftConfig()).toEqual({
      timeZone: "America/New_York",
      startHours: { A: 7, B: 15, C: 23 },
    });
  });

  it("invalid timezone and out-of-range hours fall back to defaults", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "Not/A_Real_Zone",
      SHIFT_A_START_HOUR: "99",
      SHIFT_B_START_HOUR: "abc",
      SHIFT_C_START_HOUR: "-1",
    });
    expect(getShiftConfig()).toEqual({
      timeZone: "Asia/Kolkata",
      startHours: { A: 6, B: 14, C: 22 },
    });
  });

  it("out-of-order hours fall back to default hours but keep the valid timezone", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "Europe/London",
      SHIFT_A_START_HOUR: "14",
      SHIFT_B_START_HOUR: "6",
      SHIFT_C_START_HOUR: "22",
    });
    const cfg = getShiftConfig();
    expect(cfg.timeZone).toBe("Europe/London");
    expect(cfg.startHours).toEqual({ A: 6, B: 14, C: 22 });
  });
});

describe("getISTShiftRange / getISTDayRange (timezone-aware UTC windows)", () => {
  beforeEach(() => clearShiftEnv());

  it("default IST: shift A on 2025-06-15 → 06:00–14:00 IST = 00:30–08:30 UTC", () => {
    const { start, end } = getISTShiftRange("2025-06-15", "A");
    expect(start.toISOString()).toBe("2025-06-15T00:30:00.000Z");
    expect(end.toISOString()).toBe("2025-06-15T08:30:00.000Z");
  });

  it("default IST: shift C on 2025-06-15 wraps to next day → 22:00–06:00 IST", () => {
    const { start, end } = getISTShiftRange("2025-06-15", "C");
    expect(start.toISOString()).toBe("2025-06-15T16:30:00.000Z");
    expect(end.toISOString()).toBe("2025-06-16T00:30:00.000Z");
  });

  it("default IST: getISTDayRange covers 00:00–24:00 IST = 18:30 prev → 18:30 same UTC", () => {
    const { start, end } = getISTDayRange("2025-06-15");
    expect(start.toISOString()).toBe("2025-06-14T18:30:00.000Z");
    expect(end.toISOString()).toBe("2025-06-15T18:30:00.000Z");
  });

  it("custom New_York facility (07/15/23): shift A on summer day uses EDT", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    const { start, end } = getISTShiftRange("2025-06-15", "A");
    expect(start.toISOString()).toBe("2025-06-15T11:00:00.000Z"); // 07:00 EDT
    expect(end.toISOString()).toBe("2025-06-15T19:00:00.000Z"); // 15:00 EDT
  });

  it("custom New_York facility: shift C wraps midnight using EDT", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    const { start, end } = getISTShiftRange("2025-06-15", "C");
    expect(start.toISOString()).toBe("2025-06-16T03:00:00.000Z"); // 23:00 EDT
    expect(end.toISOString()).toBe("2025-06-16T11:00:00.000Z"); // next day 07:00 EDT
  });

  it("DST spring-forward (NY 2025-03-09): shift A starts at 07:00 EDT", () => {
    // On 2025-03-09 the clock jumps 02:00 → 03:00 EDT, so 07:00 local that
    // day is already EDT (UTC-4). 07:00 - (-4) = 11:00 UTC.
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    const { start, end } = getISTShiftRange("2025-03-09", "A");
    expect(start.toISOString()).toBe("2025-03-09T11:00:00.000Z");
    expect(end.toISOString()).toBe("2025-03-09T19:00:00.000Z");
  });

  it("DST fall-back (NY 2025-11-02): a single local day spans 25 UTC hours", () => {
    // On 2025-11-02 the clock falls 02:00 EDT → 01:00 EST, so the local day
    // is 25 hours long. getISTDayRange must return start at 04:00 UTC
    // (00:00 EDT) and end at 05:00 UTC the next day (24:00 EST).
    setShiftEnv({ SHIFT_TIMEZONE: "America/New_York" });
    const { start, end } = getISTDayRange("2025-11-02");
    expect(start.toISOString()).toBe("2025-11-02T04:00:00.000Z");
    expect(end.toISOString()).toBe("2025-11-03T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("DST spring-forward (NY 2025-03-09): a single local day spans 23 UTC hours", () => {
    setShiftEnv({ SHIFT_TIMEZONE: "America/New_York" });
    const { start, end } = getISTDayRange("2025-03-09");
    expect(start.toISOString()).toBe("2025-03-09T05:00:00.000Z"); // 00:00 EST
    expect(end.toISOString()).toBe("2025-03-10T04:00:00.000Z"); // 24:00 EDT
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});

describe("calendar-day iteration (mirrors /dashboard/trends day stepping)", () => {
  beforeEach(() => clearShiftEnv());

  it("walking back 5 days across NY spring-forward gives 5 distinct local-calendar dates", () => {
    setShiftEnv({ SHIFT_TIMEZONE: "America/New_York" });
    // Pretend "today" in NY is 2025-03-12 (Wed), so the 5-day window covers
    // 03-08, 03-09 (spring forward), 03-10, 03-11, 03-12.
    const today = { year: 2025, month: 2, day: 12 }; // March is month index 2
    const labels: string[] = [];
    for (let i = 4; i >= 0; i--) {
      const stepped = new Date(Date.UTC(today.year, today.month, today.day - i));
      const y = stepped.getUTCFullYear();
      const m = String(stepped.getUTCMonth() + 1).padStart(2, "0");
      const d = String(stepped.getUTCDate()).padStart(2, "0");
      labels.push(`${y}-${m}-${d}`);
    }
    expect(labels).toEqual([
      "2025-03-08",
      "2025-03-09",
      "2025-03-10",
      "2025-03-11",
      "2025-03-12",
    ]);
    // And each of those local-day windows resolves to a strictly increasing
    // UTC range, with the spring-forward day being only 23h long.
    const ranges = labels.map((l) => getISTDayRange(l));
    for (let i = 1; i < ranges.length; i++) {
      expect(
        ranges[i].start.getTime(),
        `day ${labels[i]} start must equal previous day's end`,
      ).toBe(ranges[i - 1].end.getTime());
    }
    const springForwardLen = ranges[1].end.getTime() - ranges[1].start.getTime();
    expect(springForwardLen).toBe(23 * 60 * 60 * 1000);
  });
});

describe("getCurrentShift (driven by configured hours and timezone)", () => {
  beforeEach(() => clearShiftEnv());

  it("returns A/B/C based on configured boundaries", () => {
    // Without monkey-patching Date we can at least assert that the returned
    // shift is one of the three known labels and the start/end labels are
    // formatted consistently (no fractional/military format).
    const r = getCurrentShift();
    expect(["A", "B", "C"]).toContain(r.shift);
    expect(r.startTime).toMatch(/^\d{1,2}:00 (AM|PM)$/);
    expect(r.endTime).toMatch(/^\d{1,2}:00 (AM|PM)$/);
  });

  it("custom hours format the boundary labels with AM/PM", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    // Just sanity-check formatting; we can't pin the actual returned shift
    // without freezing time, but the labels must come from {7,15,23}.
    const r = getCurrentShift();
    expect(["A", "B", "C"]).toContain(r.shift);
    const validLabels = new Set(["7:00 AM", "3:00 PM", "11:00 PM"]);
    expect(validLabels.has(r.startTime), `start label ${r.startTime}`).toBe(true);
    expect(validLabels.has(r.endTime), `end label ${r.endTime}`).toBe(true);
  });
});

describe("DST fall-back (NY 2025-11-02) shift A and shift C UTC ranges", () => {
  beforeEach(() => clearShiftEnv());

  it("shift A on the fall-back day starts at 07:00 EST (after the rollback)", () => {
    // 02:00 EDT becomes 01:00 EST that morning, so by 07:00 local we are
    // already in EST (UTC-5). 07:00 - (-5) = 12:00 UTC; 15:00 EST = 20:00 UTC.
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    const { start, end } = getISTShiftRange("2025-11-02", "A");
    expect(start.toISOString()).toBe("2025-11-02T12:00:00.000Z");
    expect(end.toISOString()).toBe("2025-11-02T20:00:00.000Z");
  });

  it("shift C wrap on the fall-back day uses EST on both sides of midnight", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    const { start, end } = getISTShiftRange("2025-11-02", "C");
    // 23:00 EST Nov 2 = 04:00 UTC Nov 3; 07:00 EST Nov 3 = 12:00 UTC Nov 3.
    expect(start.toISOString()).toBe("2025-11-03T04:00:00.000Z");
    expect(end.toISOString()).toBe("2025-11-03T12:00:00.000Z");
    // A standard-length 8h shift, since both ends are now in EST.
    expect(end.getTime() - start.getTime()).toBe(8 * 60 * 60 * 1000);
  });
});

describe("getISTShiftRange shift C anchoring (no dateStr)", () => {
  beforeEach(() => clearShiftEnv());
  afterEach(() => {
    vi.useRealTimers();
    clearShiftEnv();
  });

  it("anchors to YESTERDAY when 'now' is before A-start (early morning of shift C)", () => {
    // Default IST schedule. Pretend "now" is 2025-06-15 03:00 IST
    // (= 2025-06-14T21:30:00Z), which is mid-shift C that started the
    // previous evening. Without an explicit dateStr the helper must pick the
    // window that contains us, not the one starting tonight.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-14T21:30:00.000Z"));
    const { start, end } = getISTShiftRange(undefined, "C");
    expect(start.toISOString()).toBe("2025-06-14T16:30:00.000Z"); // 22:00 IST 06-14
    expect(end.toISOString()).toBe("2025-06-15T00:30:00.000Z"); //   06:00 IST 06-15
  });

  it("anchors to TODAY when 'now' is after A-start (shift C starts tonight)", () => {
    // Default IST schedule. "Now" is 2025-06-15 23:30 IST
    // (= 2025-06-15T18:00:00Z) — squarely inside shift C of 06-15. The
    // helper should return today's C window (22:00 IST 06-15 → 06:00 IST 06-16).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T18:00:00.000Z"));
    const { start, end } = getISTShiftRange(undefined, "C");
    expect(start.toISOString()).toBe("2025-06-15T16:30:00.000Z"); // 22:00 IST 06-15
    expect(end.toISOString()).toBe("2025-06-16T00:30:00.000Z"); //   06:00 IST 06-16
  });

  it("an explicit dateStr disables the 'anchor to yesterday' behavior even pre-dawn", () => {
    // Same pre-dawn instant as the first test, but with dateStr="2025-06-15".
    // With the date pinned the helper must always return that day's
    // C-start → next-day A-start, regardless of where "now" falls.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-14T21:30:00.000Z"));
    const { start, end } = getISTShiftRange("2025-06-15", "C");
    expect(start.toISOString()).toBe("2025-06-15T16:30:00.000Z");
    expect(end.toISOString()).toBe("2025-06-16T00:30:00.000Z");
  });

  it("anchor logic respects the configured (non-IST) timezone", () => {
    // NY facility (EDT in June, A=7). "Now" is 2025-06-15 04:00 EDT
    // (= 2025-06-15T08:00:00Z). hour 4 < A 7 → must anchor to yesterday.
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T08:00:00.000Z"));
    const { start, end } = getISTShiftRange(undefined, "C");
    // Yesterday C-start = 23:00 EDT 06-14 = 03:00 UTC 06-15.
    // Today A-start = 07:00 EDT 06-15 = 11:00 UTC 06-15.
    expect(start.toISOString()).toBe("2025-06-15T03:00:00.000Z");
    expect(end.toISOString()).toBe("2025-06-15T11:00:00.000Z");
  });
});

describe("getCurrentShift (with frozen system time)", () => {
  beforeEach(() => clearShiftEnv());
  afterEach(() => {
    vi.useRealTimers();
    clearShiftEnv();
  });

  it("returns shift C in the small hours of the morning under default IST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-14T21:30:00.000Z")); // 03:00 IST 06-15
    const r = getCurrentShift();
    expect(r.shift).toBe("C");
    expect(r.startTime).toBe("10:00 PM");
    expect(r.endTime).toBe("6:00 AM");
  });

  it("returns shift A under custom NY hours when 'now' is mid-morning EDT", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T18:00:00.000Z")); // 14:00 EDT
    const r = getCurrentShift();
    expect(r.shift).toBe("A");
    expect(r.startTime).toBe("7:00 AM");
    expect(r.endTime).toBe("3:00 PM");
  });

  it("returns shift B at the B-start boundary (inclusive on B-start)", () => {
    setShiftEnv({
      SHIFT_TIMEZONE: "America/New_York",
      SHIFT_A_START_HOUR: "7",
      SHIFT_B_START_HOUR: "15",
      SHIFT_C_START_HOUR: "23",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T19:00:00.000Z")); // 15:00 EDT exactly
    const r = getCurrentShift();
    expect(r.shift).toBe("B");
    expect(r.startTime).toBe("3:00 PM");
    expect(r.endTime).toBe("11:00 PM");
  });
});

describe("zonedToUtc / getZonedParts / formatZonedDate round-trips", () => {
  beforeEach(() => clearShiftEnv());

  it("formatZonedDate of a UTC instant returns the local calendar date", () => {
    setShiftEnv({ SHIFT_TIMEZONE: "America/New_York" });
    // 2025-06-16 03:00 UTC = 2025-06-15 23:00 EDT.
    expect(formatZonedDate(new Date("2025-06-16T03:00:00.000Z"))).toBe("2025-06-15");
  });

  it("zonedToUtc + getZonedParts round-trip through the configured timezone", () => {
    setShiftEnv({ SHIFT_TIMEZONE: "America/New_York" });
    const utc = zonedToUtc(2025, 6, 15, 14, 30);
    const back = getZonedParts(utc);
    expect(back).toEqual({ year: 2025, month: 6, day: 15, hour: 14, minute: 30 });
  });
});
