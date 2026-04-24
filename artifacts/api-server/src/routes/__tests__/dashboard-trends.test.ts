import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
  areaProfilesTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// Regression coverage for Task 81. Before the fix, GET /dashboard/trends
// returned HTTP 500 because the timezone in the SELECT/GROUP BY expression
// was bound as a query parameter, which made Postgres treat the two
// occurrences as distinct expressions and complain that submissions.created_at
// was missing from the GROUP BY clause. Areas with no `area_profiles` row
// must still be returned (with status="LEARNING" and empty point series)
// rather than blowing up the entire response.

const RUN_TAG = `dash-trends-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let areaWithProfile: { id: number; name: string };
let areaWithoutProfile: { id: number; name: string };
let managerToken: string;

beforeAll(async () => {
  const [manager] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = manager.id;

  const [operator] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operatorId = operator.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-with-profile` })
    .returning();
  areaWithProfile = { id: a.id, name: a.name };

  const [b] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-no-profile` })
    .returning();
  areaWithoutProfile = { id: b.id, name: b.name };

  // Only the first area gets a learning profile row. The second one is
  // intentionally left without one to mirror the bug report.
  await db.insert(areaProfilesTable).values({
    areaId: areaWithProfile.id,
    status: "TRAINED",
    submissionsCount: 5,
    trainedAt: new Date(),
  });

  // One submission today so the daily aggregation has at least one row to
  // group; this is the path that previously raised the GROUP BY error.
  await db.insert(submissionsTable).values({
    userId: operatorId,
    areaId: areaWithProfile.id,
    shift: "A",
    scoreTotal: 18,
    scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
    suggestionsJson: [],
    imageUrl: `/uploads/${RUN_TAG}.jpg`,
    mediaType: "image",
  });

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
});

afterAll(async () => {
  await db
    .delete(submissionsTable)
    .where(inArray(submissionsTable.userId, [operatorId]));
  await db
    .delete(areaProfilesTable)
    .where(inArray(areaProfilesTable.areaId, [areaWithProfile.id, areaWithoutProfile.id]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [areaWithProfile.id, areaWithoutProfile.id]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [managerId, operatorId]));
  await pool.end();
});

describe("GET /dashboard/trends", () => {
  it("returns 200 with one entry per area, including areas without a learning profile", async () => {
    const res = await request(app)
      .get("/api/dashboard/trends")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const profiled = res.body.find(
      (r: { areaId: number }) => r.areaId === areaWithProfile.id,
    );
    const unprofiled = res.body.find(
      (r: { areaId: number }) => r.areaId === areaWithoutProfile.id,
    );

    expect(profiled).toBeTruthy();
    expect(profiled.status).toBe("TRAINED");
    expect(Array.isArray(profiled.points)).toBe(true);
    expect(profiled.points.length).toBeGreaterThan(0);

    expect(unprofiled).toBeTruthy();
    // Areas with no area_profiles row default to LEARNING and a null
    // trainedOnDate instead of breaking the response.
    expect(unprofiled.status).toBe("LEARNING");
    expect(unprofiled.trainedOnDate).toBeNull();
    expect(Array.isArray(unprofiled.points)).toBe(true);
  });

  it("returns 200 with the requested window length when shift filter is applied", async () => {
    const res = await request(app)
      .get("/api/dashboard/trends?days=7&shift=A")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const sample = res.body.find(
      (r: { areaId: number }) => r.areaId === areaWithProfile.id,
    );
    expect(sample).toBeTruthy();
    expect(sample.points).toHaveLength(7);
  });

  // The original 500 reproduced for every supported window length because the
  // GROUP BY error fired before any per-day filtering; explicitly covering all
  // three windows the UI exposes (7/14/30) makes sure a future change can't
  // silently regress one window while leaving the others healthy.
  it.each([7, 14, 30])(
    "returns 200 with %i daily points per area for ?days=%i",
    async (days) => {
      const res = await request(app)
        .get(`/api/dashboard/trends?days=${days}`)
        .set("Authorization", `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const sample = res.body.find(
        (r: { areaId: number }) => r.areaId === areaWithProfile.id,
      );
      expect(sample).toBeTruthy();
      expect(sample.points).toHaveLength(days);
    },
  );
});
