import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  operatorSettingsTable,
  operatorThresholdChangesTable,
  areasTable,
  areaOperatorSettingsTable,
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
  await db.delete(operatorThresholdChangesTable);
  await db.delete(areaOperatorSettingsTable);
  await db.delete(operatorSettingsTable);
}

let areaA: { id: number; name: string };
let areaB: { id: number; name: string };

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

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area-A` })
    .returning();
  areaA = { id: a.id, name: a.name };
  const [b] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area-B` })
    .returning();
  areaB = { id: b.id, name: b.name };
});

afterAll(async () => {
  await clearOverrides();
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [areaA.id, areaB.id]));
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

describe("operator-thresholds audit trail", () => {
  it("returns an empty audit history when nothing has changed yet", async () => {
    const res = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditHistory).toEqual([]);
    expect(res.body.updatedByUserEmail).toBeNull();
  });

  it("resolves the manager email for the latest change", async () => {
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 65 });

    const get = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(get.status).toBe(200);
    expect(get.body.updatedByUserId).toBe(managerId);
    expect(get.body.updatedByUserEmail).toBe(`${RUN_TAG}-mgr@test.local`);
  });

  it("emits one audit row per field that actually moved on a single PUT", async () => {
    const res = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 80, priorBestWindowDays: 21 });
    expect(res.status).toBe(200);

    expect(res.body.auditHistory).toHaveLength(2);
    const fields = res.body.auditHistory.map(
      (e: { field: string }) => e.field,
    );
    expect(fields.sort()).toEqual([
      "encouragementMinPercent",
      "priorBestWindowDays",
    ]);
    for (const entry of res.body.auditHistory) {
      expect(entry.changedByUserId).toBe(managerId);
      expect(entry.changedByUserEmail).toBe(`${RUN_TAG}-mgr@test.local`);
      expect(entry.oldValue).toBeNull();
      if (entry.field === "encouragementMinPercent") {
        expect(entry.newValue).toBe(80);
      } else {
        expect(entry.newValue).toBe(21);
      }
    }
  });

  it("records old → new transitions and clears (set to null)", async () => {
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 70 });

    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 85 });

    const cleared = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: null });

    // Newest first.
    expect(cleared.body.auditHistory[0]).toMatchObject({
      field: "encouragementMinPercent",
      oldValue: 85,
      newValue: null,
    });
    expect(cleared.body.auditHistory[1]).toMatchObject({
      field: "encouragementMinPercent",
      oldValue: 70,
      newValue: 85,
    });
    expect(cleared.body.auditHistory[2]).toMatchObject({
      field: "encouragementMinPercent",
      oldValue: null,
      newValue: 70,
    });
  });

  it("does not emit audit rows when the field value did not actually change", async () => {
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 14 });

    // Saving the same number again must not create a second audit row.
    const noop = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 14 });
    expect(noop.body.auditHistory).toHaveLength(1);
  });

  it("ignores invalid values and records no audit row for them", async () => {
    const res = await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        encouragementMinPercent: 9999, // invalid → ignored
        priorBestWindowDays: 12, // valid
      });
    expect(res.status).toBe(200);
    expect(res.body.auditHistory).toHaveLength(1);
    expect(res.body.auditHistory[0]).toMatchObject({
      field: "priorBestWindowDays",
      newValue: 12,
    });
  });

  it("caps the surfaced history at 5 entries (newest first)", async () => {
    for (const v of [10, 11, 12, 13, 14, 15, 16]) {
      await request(app)
        .put("/api/operator-thresholds")
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ priorBestWindowDays: v });
    }
    const get = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.body.auditHistory).toHaveLength(5);
    const newValues = get.body.auditHistory.map(
      (e: { newValue: number }) => e.newValue,
    );
    expect(newValues).toEqual([16, 15, 14, 13, 12]);
  });

  it("prunes the audit table to the per-field retention cap on every save", async () => {
    // Tighten the cap so we can prove the policy ran without seeding 50+ rows.
    const KEY = "OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD";
    const original = process.env[KEY];
    process.env[KEY] = "3";
    try {
      // Six edits, each one moving `priorBestWindowDays` so they all share
      // a single field. After the 6th save the prune should have trimmed
      // the on-disk table to the 3 newest rows (the cap), even though the
      // surfaced history slice would only show 5 by default.
      for (const v of [1, 2, 3, 4, 5, 6]) {
        await request(app)
          .put("/api/operator-thresholds")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ priorBestWindowDays: v });
      }
      const rows = await db
        .select({ newValue: operatorThresholdChangesTable.newValue })
        .from(operatorThresholdChangesTable);
      expect(rows).toHaveLength(3);
      const sorted = rows.map((r) => r.newValue).sort((a, b) => (a! - b!));
      // Exactly the three highest-numbered (most recent) values survived.
      expect(sorted).toEqual([4, 5, 6]);
    } finally {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    }
  });

  it("keeps each field's tail independently when pruning", async () => {
    // Two distinct fields edited at different cadences. With a per-field
    // cap, a noisy field can't push out a quieter field's history.
    const KEY = "OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD";
    const original = process.env[KEY];
    process.env[KEY] = "2";
    try {
      // Field A: five edits → must trim to last 2.
      for (const v of [10, 11, 12, 13, 14]) {
        await request(app)
          .put("/api/operator-thresholds")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ priorBestWindowDays: v });
      }
      // Field B: just two edits → must remain intact.
      for (const v of [55, 60]) {
        await request(app)
          .put("/api/operator-thresholds")
          .set("Authorization", `Bearer ${managerToken}`)
          .send({ encouragementMinPercent: v });
      }

      const rows = await db
        .select({
          field: operatorThresholdChangesTable.field,
          newValue: operatorThresholdChangesTable.newValue,
        })
        .from(operatorThresholdChangesTable);
      const grouped = new Map<string, number[]>();
      for (const r of rows) {
        const list = grouped.get(r.field) ?? [];
        list.push(r.newValue!);
        grouped.set(r.field, list);
      }
      expect(
        (grouped.get("priorBestWindowDays") ?? []).sort((a, b) => a - b),
      ).toEqual([13, 14]);
      expect(
        (grouped.get("encouragementMinPercent") ?? []).sort((a, b) => a - b),
      ).toEqual([55, 60]);
    } finally {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    }
  });
});

describe("GET /operator-thresholds (per-area provenance)", () => {
  it("includes a sorted areaOverrides array", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaB.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 2 });
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 65 });

    const get = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.status).toBe(200);
    const overrides = (get.body.areaOverrides as Array<{
      areaId: number;
      areaName: string;
      encouragementMinPercent: number | null;
      priorBestWindowDays: number | null;
      dueSoonThresholdMinutes: number | null;
    }>).filter((r) => r.areaId === areaA.id || r.areaId === areaB.id);
    expect(overrides).toHaveLength(2);
    // Sorted ascending by areaId so the UI selector is predictable.
    expect(overrides[0].areaId).toBeLessThan(overrides[1].areaId);
    const a = overrides.find((r) => r.areaId === areaA.id)!;
    expect(a.areaName).toBe(areaA.name);
    expect(a.encouragementMinPercent).toBe(65);
    expect(a.priorBestWindowDays).toBeNull();
    const b = overrides.find((r) => r.areaId === areaB.id)!;
    expect(b.priorBestWindowDays).toBe(2);
  });
});

describe("GET /operator-thresholds/areas/:id", () => {
  it("returns 404 for an unknown area id", async () => {
    const res = await request(app)
      .get("/api/operator-thresholds/areas/9999999")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get(
      `/api/operator-thresholds/areas/${areaA.id}`,
    );
    expect(res.status).toBe(401);
  });

  it("falls back to defaults when no per-area row exists", async () => {
    const res = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.areaId).toBe(areaA.id);
    expect(res.body.areaName).toBe(areaA.name);
    expect(res.body.encouragementMinPercent).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.encouragementMinPercent,
    );
    expect(res.body.areaOverrides).toEqual({
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
    });
    expect(res.body.globalOverrides).toEqual({
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
    });
  });

  it("layers area DB > global DB on a per-field basis", async () => {
    // Set the global layer first.
    await request(app)
      .put("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 60, priorBestWindowDays: 14 });
    // Then override only `priorBestWindowDays` on areaA.
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 3 });

    const res = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.encouragementMinPercent).toBe(60); // from global
    expect(res.body.priorBestWindowDays).toBe(3); // from area
    expect(res.body.dueSoonThresholdMinutes).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.dueSoonThresholdMinutes,
    );
    expect(res.body.areaOverrides.priorBestWindowDays).toBe(3);
    expect(res.body.globalOverrides.encouragementMinPercent).toBe(60);
  });
});

describe("PUT /operator-thresholds/areas/:id", () => {
  it("returns 403 when the caller is an operator", async () => {
    const res = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ encouragementMinPercent: 75 });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown area id", async () => {
    const res = await request(app)
      .put("/api/operator-thresholds/areas/9999999")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 3 });
    expect(res.status).toBe(404);
  });

  it("persists a per-area override and reflects it on the next GET", async () => {
    const put = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 2 });
    expect(put.status).toBe(200);
    expect(put.body.priorBestWindowDays).toBe(2);
    expect(put.body.areaOverrides.priorBestWindowDays).toBe(2);
    expect(put.body.updatedByUserId).toBe(managerId);
    expect(put.body.updatedAt).not.toBeNull();

    const get = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(get.body.priorBestWindowDays).toBe(2);
  });

  it("treats null as 'clear that field'", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 2, encouragementMinPercent: 88 });

    const cleared = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.areaOverrides.priorBestWindowDays).toBeNull();
    // The other field is untouched.
    expect(cleared.body.areaOverrides.encouragementMinPercent).toBe(88);
  });

  it("ignores invalid values without rejecting the whole payload", async () => {
    const res = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        priorBestWindowDays: 9999, // out of range
        encouragementMinPercent: 70, // valid
      });
    expect(res.status).toBe(200);
    expect(res.body.areaOverrides.priorBestWindowDays).toBeNull();
    expect(res.body.areaOverrides.encouragementMinPercent).toBe(70);
  });

  it("tidies away the row once every field is cleared", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 2 });

    // Confirm the row exists in the global payload.
    const before = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(
      (before.body.areaOverrides as Array<{ areaId: number }>).some(
        (r) => r.areaId === areaA.id,
      ),
    ).toBe(true);

    // Clear it.
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: null });

    const after = await request(app)
      .get("/api/operator-thresholds")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(
      (after.body.areaOverrides as Array<{ areaId: number }>).some(
        (r) => r.areaId === areaA.id,
      ),
    ).toBe(false);
  });

  it("isolates overrides between areas", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 2 });

    const otherArea = await request(app)
      .get(`/api/operator-thresholds/areas/${areaB.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(otherArea.body.areaOverrides.priorBestWindowDays).toBeNull();
    expect(otherArea.body.priorBestWindowDays).toBe(
      DEFAULT_OPERATOR_THRESHOLDS.priorBestWindowDays,
    );
  });
});

describe("DELETE /operator-thresholds/areas/:id", () => {
  it("clears every per-area override for the area", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        encouragementMinPercent: 70,
        priorBestWindowDays: 2,
        dueSoonThresholdMinutes: 15,
      });

    const del = await request(app)
      .delete(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(del.status).toBe(200);
    expect(del.body.areaOverrides).toEqual({
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
    });
  });

  it("returns 403 for operators", async () => {
    const res = await request(app)
      .delete(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
  });
});

describe("operator-thresholds per-area audit trail", () => {
  it("returns an empty per-area history when nothing has changed yet", async () => {
    const res = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.auditHistory).toEqual([]);
  });

  it("emits one audit row per field that actually moved on a single area PUT", async () => {
    const put = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 78, priorBestWindowDays: 9 });
    expect(put.status).toBe(200);

    expect(put.body.auditHistory).toHaveLength(2);
    const fields = put.body.auditHistory.map(
      (e: { field: string }) => e.field,
    );
    expect(fields.sort()).toEqual([
      "encouragementMinPercent",
      "priorBestWindowDays",
    ]);
    for (const entry of put.body.auditHistory) {
      expect(entry.changedByUserId).toBe(managerId);
      expect(entry.changedByUserEmail).toBe(`${RUN_TAG}-mgr@test.local`);
      expect(entry.oldValue).toBeNull();
      if (entry.field === "encouragementMinPercent") {
        expect(entry.newValue).toBe(78);
      } else {
        expect(entry.newValue).toBe(9);
      }
    }
  });

  it("records old → new transitions and clears (set to null) for an area", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 4 });
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 6 });

    const cleared = await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: null });

    // Newest first.
    expect(cleared.body.auditHistory[0]).toMatchObject({
      field: "priorBestWindowDays",
      oldValue: 6,
      newValue: null,
    });
    expect(cleared.body.auditHistory[1]).toMatchObject({
      field: "priorBestWindowDays",
      oldValue: 4,
      newValue: 6,
    });
    expect(cleared.body.auditHistory[2]).toMatchObject({
      field: "priorBestWindowDays",
      oldValue: null,
      newValue: 4,
    });
  });

  it("records DELETE as one audit row per previously-set field", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 70, priorBestWindowDays: 4 });

    const del = await request(app)
      .delete(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(del.status).toBe(200);

    // Two clearing rows (one per previously-set field) at the head, then
    // the two original PUT rows behind them.
    expect(del.body.auditHistory).toHaveLength(4);
    const cleared = del.body.auditHistory.slice(0, 2);
    for (const entry of cleared) {
      expect(entry.newValue).toBeNull();
      expect(entry.changedByUserId).toBe(managerId);
    }
    const fields = cleared.map((e: { field: string }) => e.field).sort();
    expect(fields).toEqual([
      "encouragementMinPercent",
      "priorBestWindowDays",
    ]);
  });

  it("does not record an audit row for DELETE when no fields were set", async () => {
    const del = await request(app)
      .delete(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(del.status).toBe(200);
    expect(del.body.auditHistory).toEqual([]);
  });

  it("isolates per-area history between areas", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 3 });
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaB.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 5 });

    const a = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    const b = await request(app)
      .get(`/api/operator-thresholds/areas/${areaB.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(a.body.auditHistory).toHaveLength(1);
    expect(a.body.auditHistory[0].newValue).toBe(3);
    expect(b.body.auditHistory).toHaveLength(1);
    expect(b.body.auditHistory[0].newValue).toBe(5);
  });

  it("does not surface global changes in a per-area history view", async () => {
    await request(app)
      .put(`/api/operator-thresholds`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ encouragementMinPercent: 60 });

    const area = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(area.body.auditHistory).toEqual([]);
  });

  it("does not surface per-area changes in the global history view", async () => {
    await request(app)
      .put(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ priorBestWindowDays: 3 });

    const global = await request(app)
      .get(`/api/operator-thresholds`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(global.body.auditHistory).toEqual([]);
  });

  it("caps the per-area history at 5 entries (newest first)", async () => {
    for (const v of [1, 2, 3, 4, 5, 6, 7]) {
      await request(app)
        .put(`/api/operator-thresholds/areas/${areaA.id}`)
        .set("Authorization", `Bearer ${managerToken}`)
        .send({ priorBestWindowDays: v });
    }
    const get = await request(app)
      .get(`/api/operator-thresholds/areas/${areaA.id}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(get.body.auditHistory).toHaveLength(5);
    const newValues = get.body.auditHistory.map(
      (e: { newValue: number }) => e.newValue,
    );
    expect(newValues).toEqual([7, 6, 5, 4, 3]);
  });
});
