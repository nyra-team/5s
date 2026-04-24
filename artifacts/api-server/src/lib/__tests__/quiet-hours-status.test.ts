import { describe, it, expect } from "vitest";
import { quietHoursStatus, isInQuietHours } from "../notifications";

// All scenarios are anchored in IST (+05:30). To pick a "now", we construct a
// Date from a UTC instant whose IST clock reading is the value we want.
//
// Helper: an IST clock value Y-M-D HH:MM corresponds to UTC = (HH:MM - 05:30)
// on the same Y-M-D (modulo midnight rollover). For these tests we pick days
// far from DST and well inside the month so arithmetic stays trivial.
function istMoment(isoLocal: string): Date {
  // isoLocal looks like "2026-04-22T22:30" — interpreted as IST clock time.
  return new Date(`${isoLocal}:00+05:30`);
}

const allDays = 0b1111111; // 127

const baseEnabled = {
  quietHoursEnabled: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  quietHoursWeekdayMask: allDays,
};

describe("quietHoursStatus", () => {
  it("returns inactive when quiet hours are off", () => {
    const status = quietHoursStatus(
      { ...baseEnabled, quietHoursEnabled: false },
      istMoment("2026-04-22T23:00"),
    );
    expect(status).toEqual({ active: false, activeUntil: null, nextStart: null });
  });

  it("returns inactive when the weekday mask is empty", () => {
    const status = quietHoursStatus(
      { ...baseEnabled, quietHoursWeekdayMask: 0 },
      istMoment("2026-04-22T23:00"),
    );
    expect(status).toEqual({ active: false, activeUntil: null, nextStart: null });
  });

  it("inside a wrapping window: reports activeUntil at end-of-window the next morning", () => {
    // 2026-04-22 is a Wednesday. Window is 22:00–07:00 every day.
    const now = istMoment("2026-04-22T23:30");
    const status = quietHoursStatus(baseEnabled, now);
    expect(status.active).toBe(true);
    expect(status.nextStart).toBeNull();
    // Window ends at 07:00 IST on 2026-04-23.
    expect(status.activeUntil).toBe(new Date("2026-04-23T07:00:00+05:30").toISOString());
  });

  it("inside the early-morning half of a wrapping window: activeUntil is today's end", () => {
    const now = istMoment("2026-04-23T03:00"); // Thu 03:00 IST
    const status = quietHoursStatus(baseEnabled, now);
    expect(status.active).toBe(true);
    expect(status.activeUntil).toBe(new Date("2026-04-23T07:00:00+05:30").toISOString());
  });

  it("same-day window: activeUntil is today's end", () => {
    // Window 13:00–14:00 every day, now 13:30 IST.
    const prefs = { ...baseEnabled, quietHoursStart: "13:00", quietHoursEnd: "14:00" };
    const now = istMoment("2026-04-22T13:30");
    const status = quietHoursStatus(prefs, now);
    expect(status.active).toBe(true);
    expect(status.activeUntil).toBe(new Date("2026-04-22T14:00:00+05:30").toISOString());
  });

  it("outside the window same day: nextStart is today's start", () => {
    const now = istMoment("2026-04-22T18:00"); // Wed 18:00 IST
    const status = quietHoursStatus(baseEnabled, now);
    expect(status.active).toBe(false);
    expect(status.activeUntil).toBeNull();
    expect(status.nextStart).toBe(new Date("2026-04-22T22:00:00+05:30").toISOString());
  });

  it("today's start has already passed but bit unset: skips to next gated day", () => {
    // Window 22:00–07:00, only Mondays (Mon = bit 1).
    const monOnly = { ...baseEnabled, quietHoursWeekdayMask: 1 << 1 };
    // 2026-04-22 is a Wednesday at 23:00 IST. Today's start is in the past
    // and Wednesday isn't gated, so the next Monday at 22:00 IST is the
    // answer (Mon 2026-04-27).
    const now = istMoment("2026-04-22T23:00");
    const status = quietHoursStatus(monOnly, now);
    expect(status.active).toBe(false);
    expect(status.nextStart).toBe(new Date("2026-04-27T22:00:00+05:30").toISOString());
  });

  it("agrees with isInQuietHours on the active flag", () => {
    const samples = [
      istMoment("2026-04-22T21:59"),
      istMoment("2026-04-22T22:00"),
      istMoment("2026-04-23T06:59"),
      istMoment("2026-04-23T07:00"),
      istMoment("2026-04-23T12:00"),
    ];
    for (const now of samples) {
      const status = quietHoursStatus(baseEnabled, now);
      expect(status.active).toBe(isInQuietHours(baseEnabled, now));
    }
  });

  it("ignores malformed start/end strings", () => {
    const status = quietHoursStatus(
      { ...baseEnabled, quietHoursStart: "garbage", quietHoursEnd: "07:00" },
      istMoment("2026-04-22T23:00"),
    );
    expect(status).toEqual({ active: false, activeUntil: null, nextStart: null });
  });

  it("accepts HH:MM:SS as well as HH:MM (Postgres `time` round-trips include seconds)", () => {
    // Same scenario as the wrapping-window active case, but with the times
    // shaped the way Postgres returns them.
    const prefs = { ...baseEnabled, quietHoursStart: "22:00:00", quietHoursEnd: "07:00:00" };
    const now = istMoment("2026-04-22T23:30");
    const status = quietHoursStatus(prefs, now);
    expect(status.active).toBe(true);
    expect(status.activeUntil).toBe(new Date("2026-04-23T07:00:00+05:30").toISOString());
  });
});
