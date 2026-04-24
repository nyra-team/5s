import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  areaProfilesTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// Regression coverage for Task 81. The profile endpoints used to call
// getOrCreateProfile() unconditionally and crash with a foreign-key violation
// (HTTP 500) whenever the area id did not exist. The handler now returns 404
// instead, while preserving the prior "auto-create empty profile" behaviour
// for areas that exist but have not been seeded yet.

const RUN_TAG = `areas-profile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let area: { id: number; name: string };
let token: string;

beforeAll(async () => {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = u.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area` })
    .returning();
  area = { id: a.id, name: a.name };

  token = signToken({ userId: managerId, role: "MANAGER" });
});

afterAll(async () => {
  await db.delete(areaProfilesTable).where(eq(areaProfilesTable.areaId, area.id));
  await db.delete(areasTable).where(eq(areasTable.id, area.id));
  await db.delete(usersTable).where(inArray(usersTable.id, [managerId]));
  await pool.end();
});

describe("GET /areas/:id/profile", () => {
  it("returns 200 with an empty LEARNING profile when the area exists but has no profile yet", async () => {
    const res = await request(app)
      .get(`/api/areas/${area.id}/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      areaId: area.id,
      status: "LEARNING",
      submissionsCount: 0,
      items: [],
      machines: [],
      layout: [],
      commonIssues: [],
    });
  });

  it("returns 404 when the area id does not exist", async () => {
    const res = await request(app)
      .get(`/api/areas/9999999/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Area not found" });
  });

  it("returns 400 when the area id is not numeric", async () => {
    const res = await request(app)
      .get(`/api/areas/not-a-number/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("PUT /areas/:id/profile", () => {
  it("returns 404 when the area id does not exist", async () => {
    const res = await request(app)
      .put(`/api/areas/9999999/profile`)
      .set("Authorization", `Bearer ${token}`)
      .send({ summary: "should not be saved" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /areas/:id/profile", () => {
  it("returns 404 when the area id does not exist", async () => {
    const res = await request(app)
      .delete(`/api/areas/9999999/profile`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
