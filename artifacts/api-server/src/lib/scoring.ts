export interface ScoreJson {
  sort: number;
  set: number;
  shine: number;
  standardize: number;
  sustain: number;
}

const SUGGESTIONS: Record<keyof ScoreJson, string[]> = {
  sort: [
    "Remove unnecessary items from the workspace",
    "Label items that belong and discard the rest",
    "Conduct a red-tag exercise to identify unneeded items",
  ],
  set: [
    "Designate specific locations for all tools and materials",
    "Use shadow boards or labels for tool placement",
    "Ensure frequently used items are within arm's reach",
  ],
  shine: [
    "Clean all work surfaces and equipment thoroughly",
    "Establish a daily cleaning routine for the area",
    "Inspect equipment during cleaning for early defect detection",
  ],
  standardize: [
    "Create visual standards for how the area should look",
    "Post reference photos at the workstation",
    "Document cleaning and organizing procedures",
  ],
  sustain: [
    "Schedule regular 5S audits for this area",
    "Recognize teams that maintain high 5S standards",
    "Include 5S in shift handover checklists",
  ],
};

export function generateScore(): { scoreJson: ScoreJson; scoreTotal: number; suggestions: string[] } {
  const scoreJson: ScoreJson = {
    sort: Math.floor(Math.random() * 4) + 2,
    set: Math.floor(Math.random() * 4) + 2,
    shine: Math.floor(Math.random() * 4) + 2,
    standardize: Math.floor(Math.random() * 4) + 2,
    sustain: Math.floor(Math.random() * 4) + 2,
  };

  const scoreTotal = scoreJson.sort + scoreJson.set + scoreJson.shine + scoreJson.standardize + scoreJson.sustain;

  const pillars = Object.entries(scoreJson) as [keyof ScoreJson, number][];
  pillars.sort((a, b) => a[1] - b[1]);

  const suggestions: string[] = [];
  for (const [pillar] of pillars) {
    if (suggestions.length >= 3) break;
    const pool = SUGGESTIONS[pillar];
    suggestions.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  while (suggestions.length < 3) {
    const randomPillar = pillars[Math.floor(Math.random() * pillars.length)][0];
    const pool = SUGGESTIONS[randomPillar];
    const s = pool[Math.floor(Math.random() * pool.length)];
    if (!suggestions.includes(s)) suggestions.push(s);
  }

  return { scoreJson, scoreTotal, suggestions };
}

// IST is Asia/Kolkata, UTC+5:30 with no DST. We use a fixed offset everywhere
// instead of new Date()/getHours()/getDate() (which read the server's local
// clock — UTC on Replit) so the shift suggestion, the operator's per-shift
// area list, and dashboard "today"/shift filters all line up with what an
// Indian operator would expect.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

/** Calendar parts (year, month [0-11], day, hour, minute) for the given instant in IST. */
export function getISTParts(now: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** UTC instant corresponding to the given IST clock time. */
export function istToUtc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MINUTES * 60 * 1000);
}

export function getCurrentShift(): { shift: string; startTime: string; endTime: string } {
  const { hour } = getISTParts();
  if (hour >= 6 && hour < 14) {
    return { shift: "A", startTime: "6:00 AM", endTime: "2:00 PM" };
  } else if (hour >= 14 && hour < 22) {
    return { shift: "B", startTime: "2:00 PM", endTime: "10:00 PM" };
  } else {
    return { shift: "C", startTime: "10:00 PM", endTime: "6:00 AM" };
  }
}

/** YYYY-MM-DD calendar date in IST. */
export function getTodayDateString(): string {
  const { year, month, day } = getISTParts();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseISTDate(dateStr?: string): { year: number; month: number; day: number } {
  if (dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return { year: y, month: m - 1, day: d };
  }
  const p = getISTParts();
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC range covering the given IST calendar day (00:00–24:00 IST). */
export function getISTDayRange(dateStr?: string): { start: Date; end: Date } {
  const { year, month, day } = parseISTDate(dateStr);
  return {
    start: istToUtc(year, month, day, 0, 0),
    end: istToUtc(year, month, day + 1, 0, 0),
  };
}

/**
 * UTC range covering the given IST shift on the given IST calendar day.
 * Shift C straddles midnight (22:00 → next-day 06:00 IST). When dateStr is
 * omitted and shift is "C" while it's currently before 6 AM IST, the window
 * is anchored to "yesterday 22:00 IST → today 06:00 IST" so operators see the
 * shift they're actually in, not the one starting that night.
 */
export function getISTShiftRange(
  dateStr: string | undefined,
  shift: string
): { start: Date; end: Date } {
  const { year, month, day } = parseISTDate(dateStr);
  if (shift === "A") {
    return { start: istToUtc(year, month, day, 6), end: istToUtc(year, month, day, 14) };
  }
  if (shift === "B") {
    return { start: istToUtc(year, month, day, 14), end: istToUtc(year, month, day, 22) };
  }
  if (!dateStr) {
    const { hour } = getISTParts();
    if (hour < 6) {
      return { start: istToUtc(year, month, day - 1, 22), end: istToUtc(year, month, day, 6) };
    }
  }
  return { start: istToUtc(year, month, day, 22), end: istToUtc(year, month, day + 1, 6) };
}
