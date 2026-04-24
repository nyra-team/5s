import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  facilitySettingsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// End-to-end coverage for the GET / PUT /facility-settings endpoints. Mirrors
// the structure of operator-thresholds.test.ts: shared manager + operator
// fixtures, fresh DB rows per test, and supertest against the real Express
// app. Keeps env-var precedence assertions self-contained by stubbing the
// SHIFT_* env vars in afterEach so other suites in the file see clean state.

const RUN_TAG = `facility-settings-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SHIFT_ENV_KEYS = [
  "SHIFT_TIMEZONE",
  "SHIFT_A_START_HOUR",
  "SHIFT_B_START_HOUR",
  "SHIFT_C_START_HOUR",
] as const;

let managerId: number;
let operatorId: number;
let managerToken: string;
let operatorToken: string;
const savedEnv: Record<string, string | undefined> = {};

async function clearFacilitySettings(): Promise<void> {
  await db.delete(facilitySettingsTable);
}

beforeAll(async () => {
  // Snapshot any pre-existing SHIFT_* env vars so we can restore them after
  // the suite (the dev container often has none, but CI may pin them).
  for (const k of SHIFT_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  const [m] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = m.id;

  const [o] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorId = o.id;

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
  operatorToken = signToken({ userId: operatorId, role: "OPERATOR" });
});

afterAll(async () => {
  await clearFacilitySettings();
  await db.delete(usersTable).where(eq(usersTable.id, managerId));
  await db.delete(usersTable).where(eq(usersTable.id, operatorId));
  for (const k of SHIFT_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await pool.end();
});

beforeEach(async () => {
  await clearFacilitySettings();
  // Each test starts with no SHIFT_* env vars; specific tests set them as
  // needed and clean up in afterEach.
  for (const k of SHIFT_ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of SHIFT_ENV_KEYS) delete process.env[k];
});

describe("GET /facility-settings", () => {
  it("falls back to defaults (06/14/22 Asia/Kolkata) when nothing is configured", async () => {
    const res = await request(app).get("/api/facility-settings");
    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBe("Asia/Kolkata");
    expect(res.body.shiftAStartHour).toBe(6);
    expect(res.body.shiftBStartHour).toBe(14);
    expect(res.body.shiftCStartHour).toBe(22);
    expect(res.body.defaults).toEqual({
      timeZone: "Asia/Kolkata",
      shiftAStartHour: 6,
      shiftBStartHour: 14,
      shiftCStartHour: 22,
    });
    expect(res.body.envOverrides).toEqual({
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
    });
    expect(res.body.dbOverrides).toEqual({
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
    });
    expect(res.body.updatedAt).toBeNull();
    expect(res.body.updatedByUserId).toBeNull();
  });

  it("is publicly readable (the login screen's Auto theme depends on it)", async () => {
    // No Authorization header — must still respond 200. Mirrors how the
    // unauthenticated bundle picks its night-shift window.
    const res = await request(app).get("/api/facility-settings");
    expect(res.status).toBe(200);
  });

  it("surfaces env-var overrides under envOverrides and uses them as the effective value", async () => {
    process.env.SHIFT_TIMEZONE = "America/New_York";
    process.env.SHIFT_A_START_HOUR = "5";
    process.env.SHIFT_B_START_HOUR = "13";
    process.env.SHIFT_C_START_HOUR = "21";

    const res = await request(app).get("/api/facility-settings");
    expect(res.status).toBe(200);
    expect(res.body.envOverrides).toEqual({
      timeZone: "America/New_York",
      shiftAStartHour: 5,
      shiftBStartHour: 13,
      shiftCStartHour: 21,
    });
    expect(res.body.timeZone).toBe("America/New_York");
    expect(res.body.shiftAStartHour).toBe(5);
    expect(res.body.shiftBStartHour).toBe(13);
    expect(res.body.shiftCStartHour).toBe(21);
  });

  it("env wins over a DB override for the same field", async () => {
    // Manager writes a DB override first.
    await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ timeZone: "Europe/London" });

    // Then ops pin the timezone via env.
    process.env.SHIFT_TIMEZONE = "America/New_York";

    const res = await request(app).get("/api/facility-settings");
    expect(res.status).toBe(200);
    // dbOverrides keeps showing what the manager wrote — the UI uses this
    // to render the "Locked by env" badge alongside the manager's value.
    expect(res.body.dbOverrides.timeZone).toBe("Europe/London");
    expect(res.body.envOverrides.timeZone).toBe("America/New_York");
    // Effective value is the env one.
    expect(res.body.timeZone).toBe("America/New_York");
  });
});

describe("PUT /facility-settings", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app)
      .put("/api/facility-settings")
      .send({ timeZone: "Europe/London" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is an operator", async () => {
    const res = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ timeZone: "Europe/London" });
    expect(res.status).toBe(403);
  });

  it("persists a manager DB override and reflects it on the next GET", async () => {
    const put = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        timeZone: "Europe/London",
        shiftAStartHour: 7,
        shiftBStartHour: 15,
        shiftCStartHour: 23,
      });
    expect(put.status).toBe(200);
    expect(put.body.timeZone).toBe("Europe/London");
    expect(put.body.shiftAStartHour).toBe(7);
    expect(put.body.shiftBStartHour).toBe(15);
    expect(put.body.shiftCStartHour).toBe(23);
    expect(put.body.dbOverrides).toEqual({
      timeZone: "Europe/London",
      shiftAStartHour: 7,
      shiftBStartHour: 15,
      shiftCStartHour: 23,
    });
    expect(put.body.updatedByUserId).toBe(managerId);
    expect(put.body.updatedAt).not.toBeNull();

    const get = await request(app).get("/api/facility-settings");
    expect(get.body.timeZone).toBe("Europe/London");
    expect(get.body.shiftAStartHour).toBe(7);
    expect(get.body.dbOverrides.shiftCStartHour).toBe(23);
  });

  it("treats null as 'clear that DB override' (falls back to default)", async () => {
    await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ timeZone: "Europe/London" });

    const cleared = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ timeZone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.dbOverrides.timeZone).toBeNull();
    expect(cleared.body.timeZone).toBe("Asia/Kolkata"); // default
  });

  it("leaves an omitted field untouched on a partial PUT", async () => {
    await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        timeZone: "Europe/London",
        shiftAStartHour: 7,
        shiftBStartHour: 15,
        shiftCStartHour: 23,
      });

    // Patch only the timezone — the three hour overrides must persist.
    const patched = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ timeZone: "America/New_York" });
    expect(patched.status).toBe(200);
    expect(patched.body.dbOverrides.timeZone).toBe("America/New_York");
    expect(patched.body.dbOverrides.shiftAStartHour).toBe(7);
    expect(patched.body.dbOverrides.shiftBStartHour).toBe(15);
    expect(patched.body.dbOverrides.shiftCStartHour).toBe(23);
  });

  it("rejects an invalid IANA timezone with 400 and does not write the row", async () => {
    const res = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ timeZone: "Not/A_Real_Zone" });
    expect(res.status).toBe(400);
    expect(res.body.fields?.timeZone).toBeTruthy();

    // Confirm the row was not created.
    const get = await request(app).get("/api/facility-settings");
    expect(get.body.dbOverrides.timeZone).toBeNull();
    expect(get.body.updatedAt).toBeNull();
  });

  it("rejects a non-integer / out-of-range hour with 400", async () => {
    const res = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ shiftAStartHour: 99 });
    expect(res.status).toBe(400);
    expect(res.body.fields?.shiftAStartHour).toBeTruthy();
  });

  it("rejects an out-of-order patch (A < B < C) with 400 and does not partially commit", async () => {
    // Defaults are 6/14/22; flipping B below A must be refused as a unit
    // even though `shiftBStartHour: 4` is individually a valid hour.
    const res = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ shiftBStartHour: 4 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/strictly increasing/i);
    expect(res.body.fields?.shiftAStartHour).toBeTruthy();
    expect(res.body.fields?.shiftBStartHour).toBeTruthy();
    expect(res.body.fields?.shiftCStartHour).toBeTruthy();

    // No DB row should have been written.
    const get = await request(app).get("/api/facility-settings");
    expect(get.body.dbOverrides).toEqual({
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
    });
  });

  it("rejects a multi-field patch that would land out of order without committing any field", async () => {
    // A=10, B=8 — A would not be earliest. The whole payload must be
    // rejected; even the (individually valid) A=10 must not land.
    const res = await request(app)
      .put("/api/facility-settings")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ shiftAStartHour: 10, shiftBStartHour: 8 });
    expect(res.status).toBe(400);

    const get = await request(app).get("/api/facility-settings");
    expect(get.body.dbOverrides.shiftAStartHour).toBeNull();
    expect(get.body.dbOverrides.shiftBStartHour).toBeNull();
  });

  it("supports a sequence of updates without primary-key collisions", async () => {
    // Earlier versions explicitly upserted at id=1 without bumping the
    // serial sequence. This loop exercises that the resync keeps working.
    for (const v of [7, 8, 9, 10]) {
      const res = await request(app)
        .put("/api/facility-settings")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ shiftAStartHour: v });
      expect(res.status).toBe(200);
      expect(res.body.dbOverrides.shiftAStartHour).toBe(v);
    }

    const final = await request(app).get("/api/facility-settings");
    expect(final.body.shiftAStartHour).toBe(10);
  });
});
