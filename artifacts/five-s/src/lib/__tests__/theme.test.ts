/**
 * Locks in the contract of `getShiftLabels` so the operator-shift switcher's
 * time text can't silently drift when someone tweaks the night-shift window
 * config or the formatting helper. The helper is pure, so we feed it explicit
 * NightShiftWindow values rather than poking at import.meta.env.
 *
 * Cases covered:
 *   1. Default 22 → 6 (IST) window — keeps the legacy
 *      "6 AM – 2 PM / 2 PM – 10 PM / 10 PM – 6 AM" labels.
 *   2. Non-default 8-hour wrap-around window 23 → 7 — shifts everything by an
 *      hour ("7 AM – 3 PM / 3 PM – 11 PM / 11 PM – 7 AM").
 *   3. Midnight wrap-around 0 → 8 — exercises the 12 AM / 12 PM edge cases of
 *      formatHour12.
 *   4. Non-8-hour window (22 → 7, nine hours) — falls back to the legacy labels
 *      instead of producing uneven shifts.
 */
import { describe, test, expect } from "vitest";
import { getShiftLabels, type NightShiftWindow } from "../theme";

const FALLBACK = [
  { value: "A", label: "Shift A", time: "6 AM – 2 PM" },
  { value: "B", label: "Shift B", time: "2 PM – 10 PM" },
  { value: "C", label: "Shift C", time: "10 PM – 6 AM" },
];

function makeWindow(startHour: number, endHour: number): NightShiftWindow {
  return { startHour, endHour, timeZone: "Asia/Kolkata" };
}

describe("getShiftLabels", () => {
  test("default 22→6 window returns the legacy 6 AM / 2 PM / 10 PM labels", () => {
    expect(getShiftLabels(makeWindow(22, 6))).toEqual(FALLBACK);
  });

  test("non-default 8-hour 23→7 window shifts each label by one hour", () => {
    expect(getShiftLabels(makeWindow(23, 7))).toEqual([
      { value: "A", label: "Shift A", time: "7 AM – 3 PM" },
      { value: "B", label: "Shift B", time: "3 PM – 11 PM" },
      { value: "C", label: "Shift C", time: "11 PM – 7 AM" },
    ]);
  });

  test("midnight wrap-around 0→8 window formats 12 AM / 12 PM correctly", () => {
    expect(getShiftLabels(makeWindow(0, 8))).toEqual([
      { value: "A", label: "Shift A", time: "8 AM – 4 PM" },
      { value: "B", label: "Shift B", time: "4 PM – 12 AM" },
      { value: "C", label: "Shift C", time: "12 AM – 8 AM" },
    ]);
  });

  test("non-8-hour window (22→7, nine hours) falls back to legacy labels", () => {
    expect(getShiftLabels(makeWindow(22, 7))).toEqual(FALLBACK);
  });
});
