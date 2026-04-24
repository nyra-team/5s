import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  operatorSettingsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";
import { DEFAULT_OPERATOR_THRESHOLDS } from "../../lib/operator-thresholds";

// End-to-end coverage for the GET/PUT /operator-thresholds endpoints, the
// env-var > DB > default precedence chain, and the per-field "null clears"
// semantics. Cleans up its rows in afterAll so it can be re-run safely.

const RUN_TAG = `op-thresh-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let managerToken: string;
let operatorToken: string;

async function clearOverrides() {
  await db.delete(operatorSettingsTable);
}

beforeAll(async () => {
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
  await clearOverrides();
  await db.delete(usersTable).where(eq(usersTable.id, managerId));
  await db.delete(usersTable).where(eq(usersTable.id, operatorId));
  await pool.end();
});

beforeEach(async () => {
  await clearOverrides();
});

describe("GET /operator-thresholds", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/operator-thresholds");
    expect(res.status).toBe(401);
  });

  it("falls back to defaults when no overrides are configured", async () => {
    const res = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.encouragementMinPercent).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.encouragementMinPercent,
    );
    expect(res.body.priorBestWindowDays).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays,
    );
    expect(res.body.dueSoonThresholdMinutes).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.dueSoonThresholdMinutes,
    );
    expect(res.body.dbOverrides).toEqual({
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
    });
    expect(res.body.updatedAt).toBeNull();
    expect(res.body.updatedByUserId).toBeNull();
  });

  it("is readable by both managers and operators", async () => {
    const mgr = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    const op = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(mgr.status).toBe(200);
    expect(op.status).toBe(200);
  });
});

describe("PUT /operator-thresholds", () => {
  it("returns 403 when the caller is an operator", async () => {
    const res = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ encouragementMinPercent: 75 });
    expect(res.status).toBe(403);
  });

  it("persists a manager override and reflects it on the next GET", async () => {
    const put = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 75, priorBestWindowDays: 14 });
    expect(put.status).toBe(200);
    expect(put.body.encouragementMinPercent).toBe(75);
    expect(put.body.priorBestWindowDays).toBe(14);
    expect(put.body.dueSoonThresholdMinutes).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.dueSoonThresholdMinutes,
    );
    expect(put.body.dbOverrides.encouragementMinPercent).toBe(75);
    expect(put.body.dbOverrides.priorBestWindowDays).toBe(14);
    expect(put.body.dbOverrides.dueSoonThresholdMinutes).toBeNull();
    expect(put.body.updatedByUserId).toBe(managerId);
    expect(put.body.updatedAt).not.toBeNull();

    const get = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(get.body.encouragementMinPercent).toBe(75);
    expect(get.body.priorBestWindowDays).toBe(14);
  });

  it("treats null as 'clear the override' (falls back to default)", async () => {
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 75 });

    const cleared = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.dbOverrides.encouragementMinPercent).toBeNull();
    expect(cleared.body.encouragementMinPercent).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.encouragementMinPercent,
    );
  });

  it("ignores invalid values without rejecting the whole payload", async () => {
    // Out-of-range value must be ignored, but the valid sibling field still
    // has to land — matching the permissive style in /me/notification-preferences.
    const res = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        encouragementMinPercent: 9999, // invalid
        priorBestWindowDays: 5, // valid
      });
    expect(res.status).toBe(200);
    expect(res.body.dbOverrides.encouragementMinPercent).toBeNull();
    expect(res.body.dbOverrides.priorBestWindowDays).toBe(5);
  });

  it("supports a sequence of updates without primary-key collisions", async () => {
    // Earlier versions explicitly upserted at id=1 without bumping the
    // sequence — this exercise makes sure repeat writes keep working.
    for (const v of [1, 2, 3, 4]) {
      const res = await request(app)
        .put("/api/operator-thresholds")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ priorBestWindowDays: v });
      expect(res.status).toBe(200);
      expect(res.body.dbOverrides.priorBestWindowDays).toBe(v);
    }

    const final = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(final.body.priorBestWindowDays).toBe(4);
  });

  it("leaves an unrelated field untouched when only one field is patched", async () => {
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 70, priorBestWindowDays: 10 });

    const patched = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ dueSoonThresholdMinutes: 30 });
    expect(patched.status).toBe(200);
    expect(patched.body.dbOverrides.encouragementMinPercent).toBe(70);
    expect(patched.body.dbOverrides.priorBestWindowDays).toBe(10);
    expect(patched.body.dbOverrides.dueSoonThresholdMinutes).toBe(30);
  });
});
