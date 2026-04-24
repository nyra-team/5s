import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  operatorThresholdChangesTable,
} from "@workspace/db";
import {
  pruneOperatorSettingsAudit,
  getAuditKeepPerField,
} from "../audit-prune";

// Direct DB-level coverage for the per-(scope, area, field) retention cap so
// the policy itself is pinned independently of the route handler that
// invokes it.

const RUN_TAG = `audit-prune-test-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

let managerId: number;

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
});

afterAll(async () => {
  await db.delete(operatorThresholdChangesTable);
  await db.delete(usersTable).where(eq(usersTable.id, managerId));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(operatorThresholdChangesTable);
});

/**
 * Insert `count` audit rows for one (scope, areaId, field) tuple with
 * strictly-increasing `changedAt` timestamps so the prune's "keep newest N"
 * ordering has a clear winner. Returns the inserted row ids in ascending
 * (oldest → newest) order so tests can assert which rows were kept.
 */
async function seedAuditRows(opts: {
  field: string;
  count: number;
  baseAt?: Date;
  scope?: string;
  areaId?: number | null;
}): Promise<number[]> {
  const base = opts.baseAt?.getTime() ?? Date.now() - opts.count * 60_000;
  const values = Array.from({ length: opts.count }, (_, i) => ({
    scope: opts.scope ?? "global",
    areaId: opts.areaId ?? null,
    changedByUserId: managerId,
    // Spread one minute apart so ORDER BY changed_at DESC is unambiguous.
    changedAt: new Date(base + i * 60_000),
    field: opts.field,
    oldValue: i === 0 ? null : i,
    newValue: i + 1,
  }));
  const inserted = await db
    .insert(operatorThresholdChangesTable)
    .values(values)
    .returning({ id: operatorThresholdChangesTable.id });
  return inserted.map((r) => r.id);
}

describe("pruneOperatorSettingsAudit", () => {
  it("returns 0 and no-ops when the table is already under the cap", async () => {
    await seedAuditRows({ field: "encouragementMinPercent", count: 3 });
    const deleted = await pruneOperatorSettingsAudit(50);
    expect(deleted).toBe(0);
    const rows = await db.select().from(operatorThresholdChangesTable);
    expect(rows).toHaveLength(3);
  });

  it("keeps exactly the last N rows for a single (scope, area, field), dropping older ones", async () => {
    const ids = await seedAuditRows({
      field: "encouragementMinPercent",
      count: 10,
    });
    const deleted = await pruneOperatorSettingsAudit(3);
    expect(deleted).toBe(7);

    const remaining = await db
      .select({ id: operatorThresholdChangesTable.id })
      .from(operatorThresholdChangesTable);
    const remainingIds = remaining.map((r) => r.id).sort((a, b) => a - b);
    // The last three inserted rows (highest timestamps) should survive.
    expect(remainingIds).toEqual(ids.slice(-3));
  });

  it("applies the cap independently to each distinct field", async () => {
    // Seed two fields with different volumes so a global LIMIT would
    // misbehave but a per-field cap keeps both fields' tails intact.
    const enc = await seedAuditRows({
      field: "encouragementMinPercent",
      count: 8,
      baseAt: new Date("2025-01-01T00:00:00Z"),
    });
    const win = await seedAuditRows({
      field: "priorBestWindowDays",
      count: 2,
      baseAt: new Date("2025-02-01T00:00:00Z"),
    });

    const deleted = await pruneOperatorSettingsAudit(3);
    // 8 - 3 = 5 dropped from `encouragementMinPercent`; the other field
    // is already under the cap (2 ≤ 3) so nothing is touched there.
    expect(deleted).toBe(5);

    const rows = await db
      .select({
        id: operatorThresholdChangesTable.id,
        field: operatorThresholdChangesTable.field,
      })
      .from(operatorThresholdChangesTable);
    const byField = new Map<string, number[]>();
    for (const r of rows) {
      const list = byField.get(r.field) ?? [];
      list.push(r.id);
      byField.set(r.field, list);
    }
    expect(
      (byField.get("encouragementMinPercent") ?? []).sort((a, b) => a - b),
    ).toEqual(enc.slice(-3));
    expect(
      (byField.get("priorBestWindowDays") ?? []).sort((a, b) => a - b),
    ).toEqual(win); // untouched
  });

  it("treats keepPerField <= 0 as 'policy disabled' (no rows touched)", async () => {
    await seedAuditRows({ field: "encouragementMinPercent", count: 5 });
    expect(await pruneOperatorSettingsAudit(0)).toBe(0);
    expect(await pruneOperatorSettingsAudit(-1)).toBe(0);
    const rows = await db.select().from(operatorThresholdChangesTable);
    expect(rows).toHaveLength(5);
  });

  it("breaks ties on (changed_at, id) — the higher id survives", async () => {
    // All three rows share the same `changed_at` (a single PUT can do
    // this when several fields move together — though in practice they'd
    // be different fields). Forcing the same timestamp on the same field
    // pins the ORDER BY id DESC tiebreaker.
    const sharedAt = new Date("2025-03-01T12:00:00Z");
    const inserted = await db
      .insert(operatorThresholdChangesTable)
      .values([
        {
          scope: "global",
          areaId: null,
          changedByUserId: managerId,
          changedAt: sharedAt,
          field: "dueSoonThresholdMinutes",
          oldValue: null,
          newValue: 1,
        },
        {
          scope: "global",
          areaId: null,
          changedByUserId: managerId,
          changedAt: sharedAt,
          field: "dueSoonThresholdMinutes",
          oldValue: 1,
          newValue: 2,
        },
        {
          scope: "global",
          areaId: null,
          changedByUserId: managerId,
          changedAt: sharedAt,
          field: "dueSoonThresholdMinutes",
          oldValue: 2,
          newValue: 3,
        },
      ])
      .returning({ id: operatorThresholdChangesTable.id });

    const deleted = await pruneOperatorSettingsAudit(1);
    expect(deleted).toBe(2);

    const remaining = await db
      .select({ id: operatorThresholdChangesTable.id })
      .from(operatorThresholdChangesTable);
    expect(remaining).toHaveLength(1);
    // The largest id (most recently inserted) must be the survivor.
    const maxId = Math.max(...inserted.map((r) => r.id));
    expect(remaining[0].id).toBe(maxId);
  });

  it("partitions independently across (scope, area_id, field) tuples", async () => {
    // The new table multiplexes global and per-area history. The retention
    // cap must apply to each audit stream separately so a noisy area can't
    // evict a quiet area's (or the global) tail.
    // Need real area ids since area_id has a FK.
    const { areasTable } = await import("@workspace/db");
    const [areaA] = await db
      .insert(areasTable)
      .values({ name: `${RUN_TAG}-area-A` })
      .returning();
    const [areaB] = await db
      .insert(areasTable)
      .values({ name: `${RUN_TAG}-area-B` })
      .returning();

    try {
      await seedAuditRows({
        field: "priorBestWindowDays",
        count: 4,
        scope: "global",
        baseAt: new Date("2025-04-01T00:00:00Z"),
      });
      await seedAuditRows({
        field: "priorBestWindowDays",
        count: 4,
        scope: "area",
        areaId: areaA.id,
        baseAt: new Date("2025-04-02T00:00:00Z"),
      });
      await seedAuditRows({
        field: "priorBestWindowDays",
        count: 1,
        scope: "area",
        areaId: areaB.id,
        baseAt: new Date("2025-04-03T00:00:00Z"),
      });

      const deleted = await pruneOperatorSettingsAudit(2);
      // global: 4 - 2 = 2 dropped; areaA: 4 - 2 = 2 dropped; areaB: 1 ≤ 2 untouched.
      expect(deleted).toBe(4);

      const rows = await db.select().from(operatorThresholdChangesTable);
      const counts = { global: 0, areaA: 0, areaB: 0 };
      for (const r of rows) {
        if (r.scope === "global") counts.global++;
        else if (r.areaId === areaA.id) counts.areaA++;
        else if (r.areaId === areaB.id) counts.areaB++;
      }
      expect(counts).toEqual({ global: 2, areaA: 2, areaB: 1 });
    } finally {
      await db.delete(operatorThresholdChangesTable);
      await db
        .delete(areasTable)
        .where(eq(areasTable.id, areaA.id));
      await db
        .delete(areasTable)
        .where(eq(areasTable.id, areaB.id));
    }
  });
});

describe("getAuditKeepPerField", () => {
  // Snapshot/restore the env var so per-test overrides can't leak.
  const KEY = "OPERATOR_SETTINGS_AUDIT_KEEP_PER_FIELD";
  const ORIGINAL = process.env[KEY];
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env[KEY];
    else process.env[KEY] = ORIGINAL;
  });

  it("falls back to the shipped default when the env var is unset", () => {
    delete process.env[KEY];
    expect(getAuditKeepPerField()).toBe(50);
  });

  it("honours a positive integer override", () => {
    process.env[KEY] = "12";
    expect(getAuditKeepPerField()).toBe(12);
  });

  it("ignores garbage values and falls back to the default", () => {
    for (const bad of ["", "abc", "0", "-3", "1.5", "NaN"]) {
      process.env[KEY] = bad;
      expect(getAuditKeepPerField()).toBe(50);
    }
  });
});
