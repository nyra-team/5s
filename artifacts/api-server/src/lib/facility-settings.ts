/**
 * Server-side source of truth for the facility's shift schedule (timezone +
 * the three shift start hours). Mirrors the bootstrap defaults from
 * `getShiftConfig()` in `./scoring.ts` but layers a runtime DB override so
 * managers can re-tune the shift hours through the facility settings UI
 * without redeploying with new env vars.
 *
 * Precedence (highest first):
 *   1. Environment variables (`SHIFT_TIMEZONE`, `SHIFT_A_START_HOUR`,
 *      `SHIFT_B_START_HOUR`, `SHIFT_C_START_HOUR`) — useful for ops to lock
 *      the schedule down per-deployment.
 *   2. DB row in `facility_settings` (managed at runtime by managers via
 *      `PUT /facility-settings`). A NULL column means "fall through".
 *   3. Static fallback values shipped with the build (06:00 / 14:00 / 22:00
 *      Asia/Kolkata) — same defaults as `DEFAULT_SHIFT_CONFIG`.
 *
 * If a DB-supplied combination would violate the strict-ordering rule
 * (`A < B < C` and all hours in 0..23), the entire DB layer is ignored for
 * shift hours and we fall back to env/defaults — never ship a half-broken
 * schedule.
 */
import { db, facilitySettingsTable } from "@workspace/db";
import {
  type ShiftConfig,
  getShiftConfig,
  isValidTimeZone,
} from "./scoring.js";

export interface FacilitySettingsSources {
  timeZone: string | null;
  shiftAStartHour: number | null;
  shiftBStartHour: number | null;
  shiftCStartHour: number | null;
}

export const FACILITY_SETTINGS_VALIDATORS = {
  timeZone: (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 64 && isValidTimeZone(v),
  hour: (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23,
} as const;

/**
 * Snapshot of env-var overrides for the shift schedule. Captured fresh per
 * call (cheap, env doesn't change at runtime) so the admin UI can show
 * which env vars are pinned. Mirrors the parsing rules used by
 * `getShiftConfig()` in `./scoring.ts`.
 */
export function getEnvFacilitySettings(): FacilitySettingsSources {
  const rawTz = process.env.SHIFT_TIMEZONE;
  const tz =
    rawTz != null && rawTz !== "" && isValidTimeZone(rawTz) ? rawTz : null;
  return {
    timeZone: tz,
    shiftAStartHour: parseHourEnv(process.env.SHIFT_A_START_HOUR),
    shiftBStartHour: parseHourEnv(process.env.SHIFT_B_START_HOUR),
    shiftCStartHour: parseHourEnv(process.env.SHIFT_C_START_HOUR),
  };
}

function parseHourEnv(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const h = Math.trunc(n);
  if (h < 0 || h > 23) return null;
  return h;
}

/**
 * Read the single-row DB override. Returns nulls for every field if the row
 * doesn't exist yet (the row is created lazily on the first manager update).
 */
export async function getDbFacilitySettings(): Promise<{
  timeZone: string | null;
  shiftAStartHour: number | null;
  shiftBStartHour: number | null;
  shiftCStartHour: number | null;
  updatedByUserId: number | null;
  updatedAt: Date | null;
}> {
  const [row] = await db
    .select()
    .from(facilitySettingsTable)
    .orderBy(facilitySettingsTable.id)
    .limit(1);
  if (!row) {
    return {
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
      updatedByUserId: null,
      updatedAt: null,
    };
  }
  return {
    timeZone: row.timeZone,
    shiftAStartHour: row.shiftAStartHour,
    shiftBStartHour: row.shiftBStartHour,
    shiftCStartHour: row.shiftCStartHour,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve the effective shift config for a request. Precedence: env > DB >
 * default. No in-process cache: this is a single-row select on a tiny table
 * and the spec requires overrides to take effect on the *next* request.
 *
 * Hour ordering is validated as a unit (A < B < C, each in 0..23). If the
 * merged hours violate that rule we discard the DB layer entirely for hours
 * — preserving the env or default schedule rather than silently producing a
 * scrambled clock.
 */
export async function loadEffectiveShiftConfig(): Promise<ShiftConfig> {
  const env = getEnvFacilitySettings();
  const dbRow = await getDbFacilitySettings();
  const bootstrap = getShiftConfig();

  const tz = env.timeZone ?? dbRow.timeZone ?? bootstrap.timeZone;
  const a = env.shiftAStartHour ?? dbRow.shiftAStartHour ?? bootstrap.startHours.A;
  const b = env.shiftBStartHour ?? dbRow.shiftBStartHour ?? bootstrap.startHours.B;
  const c = env.shiftCStartHour ?? dbRow.shiftCStartHour ?? bootstrap.startHours.C;

  const ordered =
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    Number.isInteger(c) &&
    a >= 0 &&
    c <= 23 &&
    a < b &&
    b < c;

  return {
    timeZone: tz,
    startHours: ordered
      ? { A: a, B: b, C: c }
      : { ...bootstrap.startHours },
  };
}
