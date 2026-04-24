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

// ---------------------------------------------------------------------------
// Shift configuration
//
// Per-facility shift hours and timezone are read from env vars at startup so
// facilities outside India (or running different shift windows) don't need to
// patch server code. Falls back to the legacy 06/14/22 IST schedule when
// nothing is set.
//
//   SHIFT_TIMEZONE        IANA timezone the shift clock is anchored to.
//                         Default "Asia/Kolkata".
//   SHIFT_A_START_HOUR    Hour-of-day (0–23) shift A starts. Default 6.
//   SHIFT_B_START_HOUR    Hour-of-day (0–23) shift B starts. Default 14.
//   SHIFT_C_START_HOUR    Hour-of-day (0–23) shift C starts. Default 22.
//
// Constraints: 0 ≤ A < B < C ≤ 23. If any value is invalid or the ordering
// is violated we silently fall back to the defaults rather than ship a
// half-broken schedule.
// ---------------------------------------------------------------------------

export interface ShiftConfig {
  timeZone: string;
  startHours: { A: number; B: number; C: number };
}

const DEFAULT_SHIFT_CONFIG: ShiftConfig = {
  timeZone: "Asia/Kolkata",
  startHours: { A: 6, B: 14, C: 22 },
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseHourEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const h = Math.trunc(n);
  if (h < 0 || h > 23) return fallback;
  return h;
}

let cachedShiftConfig: ShiftConfig | null = null;

export function getShiftConfig(): ShiftConfig {
  if (cachedShiftConfig) return cachedShiftConfig;
  const tzRaw = process.env.SHIFT_TIMEZONE;
  const a = parseHourEnv(process.env.SHIFT_A_START_HOUR, DEFAULT_SHIFT_CONFIG.startHours.A);
  const b = parseHourEnv(process.env.SHIFT_B_START_HOUR, DEFAULT_SHIFT_CONFIG.startHours.B);
  const c = parseHourEnv(process.env.SHIFT_C_START_HOUR, DEFAULT_SHIFT_CONFIG.startHours.C);
  const ordered = a < b && b < c;
  cachedShiftConfig = {
    timeZone: tzRaw && isValidTimeZone(tzRaw) ? tzRaw : DEFAULT_SHIFT_CONFIG.timeZone,
    startHours: ordered ? { A: a, B: b, C: c } : { ...DEFAULT_SHIFT_CONFIG.startHours },
  };
  return cachedShiftConfig;
}

/** Test-only: reset the cached config so tests can change env vars. */
export function _resetShiftConfigCache(): void {
  cachedShiftConfig = null;
}

// ---------------------------------------------------------------------------
// Timezone-aware clock helpers
//
// Previously these were hardcoded around IST (UTC+5:30, no DST), which
// bypassed the server's local clock — useful but not portable. They now use
// Intl.DateTimeFormat against the configured timezone so they cope with DST
// and arbitrary IANA zones. The "IST"-prefixed names are kept as aliases for
// back-compat with existing call sites.
// ---------------------------------------------------------------------------

/** Calendar parts (year, month [0-11], day, hour, minute) of the given instant in the configured shift timezone. */
export function getZonedParts(
  now: Date = new Date(),
  tz: string = getShiftConfig().timeZone,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some locales emit "24" for midnight under hour12:false
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10) - 1,
    day: parseInt(get("day"), 10),
    hour,
    minute: parseInt(get("minute"), 10),
  };
}

/**
 * UTC instant corresponding to the given clock time in the configured
 * shift timezone. Two-pass convergence handles DST transitions.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz: string = getShiftConfig().timeZone,
): Date {
  const targetUtcMs = Date.UTC(year, month, day, hour, minute);
  let utcMs = targetUtcMs;
  for (let i = 0; i < 2; i++) {
    const parts = getZonedParts(new Date(utcMs), tz);
    const localUtcMs = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute);
    const offsetMs = localUtcMs - utcMs;
    utcMs = targetUtcMs - offsetMs;
  }
  return new Date(utcMs);
}

// Back-compat aliases — previously used for IST-only math.
export const getISTParts = getZonedParts;
export const istToUtc = zonedToUtc;

function formatHourLabel(h: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm}`;
}

export function getCurrentShift(
  cfg: ShiftConfig = getShiftConfig(),
): { shift: string; startTime: string; endTime: string } {
  const { hour } = getZonedParts(new Date(), cfg.timeZone);
  const { A, B, C } = cfg.startHours;
  if (hour >= A && hour < B) {
    return { shift: "A", startTime: formatHourLabel(A), endTime: formatHourLabel(B) };
  }
  if (hour >= B && hour < C) {
    return { shift: "B", startTime: formatHourLabel(B), endTime: formatHourLabel(C) };
  }
  return { shift: "C", startTime: formatHourLabel(C), endTime: formatHourLabel(A) };
}

/** YYYY-MM-DD calendar date in the configured shift timezone. */
export function getTodayDateString(cfg: ShiftConfig = getShiftConfig()): string {
  return formatZonedDate(new Date(), cfg.timeZone);
}

/** YYYY-MM-DD label for the calendar date the given instant falls on in the configured timezone. */
export function formatZonedDate(d: Date, tz: string = getShiftConfig().timeZone): string {
  const { year, month, day } = getZonedParts(d, tz);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseZonedDate(
  dateStr: string | undefined,
  tz: string,
): { year: number; month: number; day: number } {
  if (dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return { year: y, month: m - 1, day: d };
  }
  const p = getZonedParts(new Date(), tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** UTC range covering the given calendar day (00:00–24:00) in the configured shift timezone. */
export function getISTDayRange(
  dateStr?: string,
  cfg: ShiftConfig = getShiftConfig(),
): { start: Date; end: Date } {
  const { year, month, day } = parseZonedDate(dateStr, cfg.timeZone);
  return {
    start: zonedToUtc(year, month, day, 0, 0, cfg.timeZone),
    end: zonedToUtc(year, month, day + 1, 0, 0, cfg.timeZone),
  };
}

/**
 * UTC range covering the given shift on the given calendar day in the
 * configured shift timezone. Shift C straddles midnight (C-start → next-day
 * A-start). When dateStr is omitted and shift is "C" while it's currently
 * before A-start, the window is anchored to "yesterday C-start → today
 * A-start" so operators see the shift they're actually in, not the one
 * starting that night.
 */
export function getISTShiftRange(
  dateStr: string | undefined,
  shift: string,
  cfg: ShiftConfig = getShiftConfig(),
): { start: Date; end: Date } {
  const { A, B, C } = cfg.startHours;
  const { year, month, day } = parseZonedDate(dateStr, cfg.timeZone);
  if (shift === "A") {
    return {
      start: zonedToUtc(year, month, day, A, 0, cfg.timeZone),
      end: zonedToUtc(year, month, day, B, 0, cfg.timeZone),
    };
  }
  if (shift === "B") {
    return {
      start: zonedToUtc(year, month, day, B, 0, cfg.timeZone),
      end: zonedToUtc(year, month, day, C, 0, cfg.timeZone),
    };
  }
  if (!dateStr) {
    const { hour } = getZonedParts(new Date(), cfg.timeZone);
    if (hour < A) {
      return {
        start: zonedToUtc(year, month, day - 1, C, 0, cfg.timeZone),
        end: zonedToUtc(year, month, day, A, 0, cfg.timeZone),
      };
    }
  }
  return {
    start: zonedToUtc(year, month, day, C, 0, cfg.timeZone),
    end: zonedToUtc(year, month, day + 1, A, 0, cfg.timeZone),
  };
}
