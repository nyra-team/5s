import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, facilitySettingsTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { getShiftConfig } from "../lib/scoring";
import {
  FACILITY_SETTINGS_VALIDATORS,
  getDbFacilitySettings,
  getEnvFacilitySettings,
  loadEffectiveShiftConfig,
} from "../lib/facility-settings.js";

const router: IRouter = Router();

interface FacilitySettingsPayload {
  timeZone: string;
  shiftAStartHour: number;
  shiftBStartHour: number;
  shiftCStartHour: number;
  defaults: {
    timeZone: string;
    shiftAStartHour: number;
    shiftBStartHour: number;
    shiftCStartHour: number;
  };
  envOverrides: {
    timeZone: string | null;
    shiftAStartHour: number | null;
    shiftBStartHour: number | null;
    shiftCStartHour: number | null;
  };
  dbOverrides: {
    timeZone: string | null;
    shiftAStartHour: number | null;
    shiftBStartHour: number | null;
    shiftCStartHour: number | null;
  };
  updatedAt: string | null;
  updatedByUserId: number | null;
}

async function buildPayload(): Promise<FacilitySettingsPayload> {
  const [effective, env, dbRow] = await Promise.all([
    loadEffectiveShiftConfig(),
    Promise.resolve(getEnvFacilitySettings()),
    getDbFacilitySettings(),
  ]);
  // Defaults expose what would land if every override layer were cleared.
  // We get them from the bootstrap config evaluated with no env vars set,
  // which is too cumbersome to recompute — instead lift them straight off
  // the in-process bootstrap defaults via getShiftConfig() with env wiped
  // is also brittle. Cheapest correct option: hardcode the same defaults
  // that DEFAULT_SHIFT_CONFIG uses (06/14/22 Asia/Kolkata).
  return {
    timeZone: effective.timeZone,
    shiftAStartHour: effective.startHours.A,
    shiftBStartHour: effective.startHours.B,
    shiftCStartHour: effective.startHours.C,
    defaults: {
      timeZone: "Asia/Kolkata",
      shiftAStartHour: 6,
      shiftBStartHour: 14,
      shiftCStartHour: 22,
    },
    envOverrides: env,
    dbOverrides: {
      timeZone: dbRow.timeZone,
      shiftAStartHour: dbRow.shiftAStartHour,
      shiftBStartHour: dbRow.shiftBStartHour,
      shiftCStartHour: dbRow.shiftCStartHour,
    },
    updatedAt: dbRow.updatedAt ? dbRow.updatedAt.toISOString() : null,
    updatedByUserId: dbRow.updatedByUserId,
  };
}

// Public read — the frontend's "Auto" theme picks the night-shift window
// from this response, and that runs even on the unauthenticated login
// screen. Returning timezone + shift-start hours is operational metadata
// (no PII), matching what the build-time `VITE_NIGHT_SHIFT_*` env vars
// already exposed publicly to the bundle.
router.get("/facility-settings", async (_req, res): Promise<void> => {
  res.json(await buildPayload());
});

// Manager-only write. Per-field semantics (mirrors the operator-thresholds
// route):
//   * Field omitted → leave the existing DB override untouched.
//   * Field set to `null` → clear the DB override (fall back to env/default).
//   * Field set to a valid value → store as the new DB override.
//
// Hour values are validated as a *unit* against the resulting effective
// schedule (A < B < C, each in 0..23): if the patch would produce an
// out-of-order timetable we reject the whole request rather than commit a
// half-broken state. A single bad timezone or non-integer hour also rejects
// the whole request — unlike thresholds, a scrambled clock would
// immediately mis-bucket every submission, so the "permissive ignore"
// posture is the wrong default here.
router.put(
  "/facility-settings",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: Record<string, string | number | null> = {};
    const errors: Record<string, string> = {};

    if ("timeZone" in body) {
      const v = body.timeZone;
      if (v === null) {
        patch.timeZone = null;
      } else if (FACILITY_SETTINGS_VALIDATORS.timeZone(v)) {
        patch.timeZone = v;
      } else {
        errors.timeZone = "Must be a valid IANA timezone (e.g. Asia/Kolkata)";
      }
    }

    for (const field of [
      "shiftAStartHour",
      "shiftBStartHour",
      "shiftCStartHour",
    ] as const) {
      if (!(field in body)) continue;
      const v = body[field];
      if (v === null) {
        patch[field] = null;
      } else if (FACILITY_SETTINGS_VALIDATORS.hour(v)) {
        patch[field] = v;
      } else {
        errors[field] = "Must be a whole number between 0 and 23";
      }
    }

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ error: "Invalid facility settings", fields: errors });
      return;
    }

    if (Object.keys(patch).length > 0) {
      // Pre-validate the resulting effective ordering BEFORE writing so a
      // bad combination (e.g. clearing A while B remains 14 and the env
      // default for A is 16) can't sneak through and force the loader to
      // silently fall back to defaults. We compute the would-be effective
      // hours by merging env > patch > existing-DB > bootstrap.
      const env = getEnvFacilitySettings();
      const existing = await getDbFacilitySettings();
      const bootstrap = getShiftConfig();
      const merged = (
        envVal: number | null,
        patchKey: "shiftAStartHour" | "shiftBStartHour" | "shiftCStartHour",
        dbVal: number | null,
        defaultVal: number,
      ): number => {
        if (envVal != null) return envVal;
        if (patchKey in patch) {
          const p = patch[patchKey];
          if (p == null) return dbVal ?? defaultVal;
          return p as number;
        }
        return dbVal ?? defaultVal;
      };
      // Note: env wins over the patch for hours, so writing a DB override
      // when an env var is pinned is allowed but won't affect the live
      // schedule — the UI surfaces this via the "Locked by env" badge.
      const effA = env.shiftAStartHour ?? merged(
        null,
        "shiftAStartHour",
        existing.shiftAStartHour,
        bootstrap.startHours.A,
      );
      const effB = env.shiftBStartHour ?? merged(
        null,
        "shiftBStartHour",
        existing.shiftBStartHour,
        bootstrap.startHours.B,
      );
      const effC = env.shiftCStartHour ?? merged(
        null,
        "shiftCStartHour",
        existing.shiftCStartHour,
        bootstrap.startHours.C,
      );
      if (!(effA < effB && effB < effC)) {
        res.status(400).json({
          error: "Shift hours must be strictly increasing (A < B < C)",
          fields: {
            shiftAStartHour: "A must be earliest",
            shiftBStartHour: "B must be after A",
            shiftCStartHour: "C must be after B",
          },
        });
        return;
      }

      // Upsert the singleton row at id=1.
      await db
        .insert(facilitySettingsTable)
        .values({
          id: 1,
          timeZone: (patch.timeZone as string | null | undefined) ?? null,
          shiftAStartHour: (patch.shiftAStartHour as number | null | undefined) ?? null,
          shiftBStartHour: (patch.shiftBStartHour as number | null | undefined) ?? null,
          shiftCStartHour: (patch.shiftCStartHour as number | null | undefined) ?? null,
          updatedByUserId: userId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: facilitySettingsTable.id,
          set: {
            ...patch,
            updatedByUserId: userId,
            updatedAt: new Date(),
          },
        });

      // Keep the singleton sequence in step with the inserted id so future
      // serial allocations don't collide with our explicit id=1 write.
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('facility_settings', 'id'), GREATEST((SELECT MAX(id) FROM facility_settings), 1))`,
      );
    }

    res.json(await buildPayload());
  },
);

export default router;
