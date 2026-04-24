import {
  getShiftConfig,
  getCurrentShift,
  getISTShiftRange,
  getISTDayRange,
  getZonedParts,
  zonedToUtc,
  formatZonedDate,
  _resetShiftConfigCache,
} from "../src/lib/scoring.js";

function assertEq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n  actual:   ${a}\n  expected: ${e}`);
    process.exit(1);
  } else {
    console.log(`OK: ${msg}`);
  }
}

// 1) Defaults match the legacy IST schedule.
delete process.env.SHIFT_TIMEZONE;
delete process.env.SHIFT_A_START_HOUR;
delete process.env.SHIFT_B_START_HOUR;
delete process.env.SHIFT_C_START_HOUR;
_resetShiftConfigCache();
const cfg = getShiftConfig();
assertEq(cfg, { timeZone: "Asia/Kolkata", startHours: { A: 6, B: 14, C: 22 } }, "defaults");

// Shift A range on 2025-06-15 should be 06:00 IST → 14:00 IST (UTC 00:30 → 08:30).
const aRange = getISTShiftRange("2025-06-15", "A");
assertEq(aRange.start.toISOString(), "2025-06-15T00:30:00.000Z", "default A start");
assertEq(aRange.end.toISOString(), "2025-06-15T08:30:00.000Z", "default A end");

const cRange = getISTShiftRange("2025-06-15", "C");
assertEq(cRange.start.toISOString(), "2025-06-15T16:30:00.000Z", "default C start");
assertEq(cRange.end.toISOString(), "2025-06-16T00:30:00.000Z", "default C end");

const dayRange = getISTDayRange("2025-06-15");
assertEq(dayRange.start.toISOString(), "2025-06-14T18:30:00.000Z", "default day start");
assertEq(dayRange.end.toISOString(), "2025-06-15T18:30:00.000Z", "default day end");

// 2) Custom timezone and shift hours.
process.env.SHIFT_TIMEZONE = "America/New_York";
process.env.SHIFT_A_START_HOUR = "7";
process.env.SHIFT_B_START_HOUR = "15";
process.env.SHIFT_C_START_HOUR = "23";
_resetShiftConfigCache();
const cfg2 = getShiftConfig();
assertEq(cfg2, { timeZone: "America/New_York", startHours: { A: 7, B: 15, C: 23 } }, "custom config");

// Shift A on 2025-06-15 (NY EDT = UTC-4): 07:00 → 15:00 EDT = 11:00 → 19:00 UTC.
const aNy = getISTShiftRange("2025-06-15", "A");
assertEq(aNy.start.toISOString(), "2025-06-15T11:00:00.000Z", "NY A start (EDT)");
assertEq(aNy.end.toISOString(), "2025-06-15T19:00:00.000Z", "NY A end (EDT)");

// Shift C wrap: 2025-06-15 23:00 EDT → 2025-06-16 07:00 EDT = 2025-06-16 03:00 → 11:00 UTC.
const cNy = getISTShiftRange("2025-06-15", "C");
assertEq(cNy.start.toISOString(), "2025-06-16T03:00:00.000Z", "NY C start (EDT)");
assertEq(cNy.end.toISOString(), "2025-06-16T11:00:00.000Z", "NY C end (EDT)");

// Cross DST: 2025-03-09 (EST→EDT spring forward). Shift A on 2025-03-09 EST: 07:00 EST = 12:00 UTC.
const aDst = getISTShiftRange("2025-03-09", "A");
assertEq(aDst.start.toISOString(), "2025-03-09T11:00:00.000Z", "DST A start (EDT)");
// End at 15:00 ET — by then we're already in EDT (UTC-4). 15:00 EDT = 19:00 UTC.
assertEq(aDst.end.toISOString(), "2025-03-09T19:00:00.000Z", "DST A end (EDT)");

// 3) formatZonedDate respects the configured timezone.
// 2025-06-16T03:00:00Z is 2025-06-15 23:00 EDT.
assertEq(formatZonedDate(new Date("2025-06-16T03:00:00.000Z")), "2025-06-15", "formatZonedDate NY pre-midnight");

// 4) Invalid env vars fall back to defaults.
process.env.SHIFT_TIMEZONE = "Not/A_Real_Zone";
process.env.SHIFT_A_START_HOUR = "99";
process.env.SHIFT_B_START_HOUR = "abc";
process.env.SHIFT_C_START_HOUR = "";
_resetShiftConfigCache();
const cfg3 = getShiftConfig();
assertEq(cfg3, { timeZone: "Asia/Kolkata", startHours: { A: 6, B: 14, C: 22 } }, "invalid → defaults");

// 5) Out-of-order hours fall back to defaults entirely.
process.env.SHIFT_TIMEZONE = "Europe/London";
process.env.SHIFT_A_START_HOUR = "14";
process.env.SHIFT_B_START_HOUR = "6";
process.env.SHIFT_C_START_HOUR = "22";
_resetShiftConfigCache();
const cfg4 = getShiftConfig();
assertEq(cfg4.startHours, { A: 6, B: 14, C: 22 }, "out-of-order → default hours");
assertEq(cfg4.timeZone, "Europe/London", "tz still kept when only hours invalid");

console.log("\nAll smoke checks passed.");
