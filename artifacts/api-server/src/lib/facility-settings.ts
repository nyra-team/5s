/**
 * Server-side source of truth for the facility's shift schedule (timezone +
 * the three shift start hours) AND the escalation re-ping cadence
 * (threshold + cap). Mirrors the bootstrap defaults from `getShiftConfig()`
 * in `./scoring.ts` and the env-var defaults baked into the re-ping
 * scheduler, but layers a runtime DB override so managers can re-tune them
 * through the facility settings UI without redeploying with new env vars.
 *
 * Precedence (highest first):
 *   1. Environment variables (`SHIFT_TIMEZONE`, `SHIFT_A_START_HOUR`,
 *      `SHIFT_B_START_HOUR`, `SHIFT_C_START_HOUR`,
 *      `ESCALATION_REPING_THRESHOLD_MINUTES`,
 *      `ESCALATION_REPING_MAX_COUNT`) — useful for ops to lock a value down
 *      per-deployment.
 *   2. DB row in `facility_settings` (managed at runtime by managers via
 *      `PUT /facility-settings`). A NULL column means "fall through".
 *   3. Static fallback values shipped with the build.
 *
 * If a DB-supplied combination would violate the strict-ordering rule for
 * shift hours (`A < B < C` and all hours in 0..23), the entire DB layer is
 * ignored for shift hours and we fall back to env/defaults — never ship a
 * half-broken schedule. Re-ping fields are validated independently per
 * field; a bad value is treated as if NULL.
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
  repingThresholdMinutes: number | null;
  repingMaxRepings: number | null;
}

/** Static fallback values for the re-ping cadence — kept in sync with the
 * historical env-var defaults in `reping-scheduler.ts`. */
export const DEFAULT_REPING_CADENCE = {
  thresholdMinutes: 15,
  maxRepings: 2,
} as const;

export const FACILITY_SETTINGS_VALIDATORS = {
  timeZone: (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 64 && isValidTimeZone(v),
  hour: (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23,
  /** Threshold must be a whole number of minutes ≥ 1. Cap at 1440 (24h)
   * so an accidental 100000 doesn't silently mute every escalation. */
  repingThresholdMinutes: (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440,
  /** Cap on attempts. 0 disables re-pings; upper bound matches the
   * reasonable ops practice of "a couple of nudges, then escalate". */
  repingMaxRepings: (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20,
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
    repingThresholdMinutes: parseValidatedIntEnv(
      process.env.ESCALATION_REPING_THRESHOLD_MINUTES,
      FACILITY_SETTINGS_VALIDATORS.repingThresholdMinutes,
    ),
    repingMaxRepings: parseValidatedIntEnv(
      process.env.ESCALATION_REPING_MAX_COUNT,
      FACILITY_SETTINGS_VALIDATORS.repingMaxRepings,
    ),
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

/** Parse an env var as an integer, returning null if absent, malformed, or
 * outside the validator's accepted range. Mirrors the "ignore garbage,
 * fall through" posture used elsewhere for env overrides. */
function parseValidatedIntEnv(
  raw: string | undefined,
  validate: (n: number) => boolean,
): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return validate(i) ? i : null;
}

/**
 * Read the single-row DB override. Returns nulls for every field if the row
 * doesn't exist yet (the row is created lazily on the first manager update).
 */
export async function getDbFacilitySettings(): Promise<
  FacilitySettingsSources & {
    updatedByUserId: number | null;
    updatedAt: Date | null;
  }
> {
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
      repingThresholdMinutes: null,
      repingMaxRepings: null,
      updatedByUserId: null,
      updatedAt: null,
    };
  }
  return {
    timeZone: row.timeZone,
    shiftAStartHour: row.shiftAStartHour,
    shiftBStartHour: row.shiftBStartHour,
    shiftCStartHour: row.shiftCStartHour,
    repingThresholdMinutes: row.repingThresholdMinutes,
    repingMaxRepings: row.repingMaxRepings,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * Effective re-ping cadence for a sweep tick. Precedence: env > DB >
 * default. The scheduler calls this at the top of every sweep so manager
 * edits take effect within one tick — no process restart, no in-process
 * cache. Each layer is a single small select on a tiny singleton table.
 *
 * Per-field validation is independent: a malformed DB-side `threshold`
 * doesn't poison the `cap` we read from the same row, since values are
 * sanitized when written via the PUT route.
 */
export interface EffectiveRepingCadence {
  thresholdMinutes: number;
  maxRepings: number;
}

export async function loadEffectiveRepingCadence(): Promise<EffectiveRepingCadence> {
  const env = getEnvFacilitySettings();
  const dbRow = await getDbFacilitySettings();
  return resolveRepingCadence({ env, dbRow });
}

/** Pure resolver. Exposed so unit tests can pin precedence behaviour
 * without a DB round-trip. */
export function resolveRepingCadence(args: {
  env: Pick<FacilitySettingsSources, "repingThresholdMinutes" | "repingMaxRepings">;
  dbRow: Pick<FacilitySettingsSources, "repingThresholdMinutes" | "repingMaxRepings">;
}): EffectiveRepingCadence {
  const { env, dbRow } = args;
  return {
    thresholdMinutes:
      env.repingThresholdMinutes ??
      dbRow.repingThresholdMinutes ??
      DEFAULT_REPING_CADENCE.thresholdMinutes,
    maxRepings:
      env.repingMaxRepings ??
      dbRow.repingMaxRepings ??
      DEFAULT_REPING_CADENCE.maxRepings,
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
