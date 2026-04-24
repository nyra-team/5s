import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// These tests exercise GET /operator/recent end-to-end against the real
// Postgres dev database. They isolate themselves by using a unique email +
// unique area names per run, and clean up everything they insert in the
// afterAll hook so they can be re-run safely.
//
// Time-window assertions anchor each test on a single `now = Date.now()`
// captured before any inserts. The route's `prevScoreTotal` and
// `bestScoreInLastWeek` math is purely *relative* between row timestamps
// (per row's own createdAt vs other rows' createdAts), so as long as every
// fixture in a single test shares the same anchor the boundary checks are
// exact and not subject to wall-clock drift. The only absolute clock the
// route compares against is the 30-day "since" filter, and our anchors are
// all within minutes of that filter — comfortably inside the window.

const RUN_TAG = `op-recent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let userId: number;
let otherUserId: number;
let areaA: { id: number; name: string };
let areaB: { id: number; name: string };
let token: string;

async function insertSubmission(opts: {
  userId: number;
  areaId: number;
  scoreTotal: number;
  createdAt: Date;
  shift?: "A" | "B" | "C";
}) {
  const [row] = await db
    .insert(submissionsTable)
    .values({
      userId: opts.userId,
      areaId: opts.areaId,
      shift: opts.shift ?? "A",
      scoreTotal: opts.scoreTotal,
      scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}.jpg`,
      mediaType: "image",
      createdAt: opts.createdAt,
    })
    .returning();
  return row;
}

async function clearSubmissions() {
  await db
    .delete(submissionsTable)
    .where(inArray(submissionsTable.userId, [userId, otherUserId]));
}

beforeAll(async () => {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  userId = u.id;

  const [u2] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-other@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  otherUserId = u2.id;

  const [a] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-A` })
    .returning();
  areaA = { id: a.id, name: a.name };

  const [b] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-B` })
    .returning();
  areaB = { id: b.id, name: b.name };

  token = signToken({ userId, role: "OPERATOR" });
});

afterAll(async () => {
  await clearSubmissions();
  await db.delete(usersTable).where(inArray(usersTable.id, [userId, otherUserId]));
  await db.delete(areasTable).where(eq(areasTable.id, areaA.id));
  await db.delete(areasTable).where(eq(areasTable.id, areaB.id));
  await pool.end();
});

beforeEach(async () => {
  await clearSubmissions();
});

describe("GET /operator/recent", () => {
  it("returns 401 when no token is provided", async () => {
    const res = await request(app).get("/api/operator/recent");
    expect(res.status).toBe(401);
  });

  it("returns an empty array when the operator has no submissions", async () => {
    const res = await request(app)
      .get("/api/operator/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("computes prevScoreTotal from the most recent prior submission in the same area", async () => {
    // Three submissions for areaA: oldest (12), middle (18), newest (22).
    // The newest's prev should be 18, the middle's prev should be 12, and
    // the oldest's prev should be null. A submission in a *different* area
    // must NOT be picked up as a prior for areaA.
    const now = Date.now();
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 12,
      createdAt: new Date(now - 3 * 60 * 60 * 1000),
    });
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 18,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
    });
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 22,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
    });
    await insertSubmission({
      userId,
      areaId: areaB.id,
      scoreTotal: 5,
      createdAt: new Date(now - 90 * 60 * 1000),
    });

    const res = await request(app)
      .get("/api/operator/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);

    // Returned in DESC order by createdAt.
    const [newestA, areaBOnly, middleA, oldestA] = res.body;
    expect(newestA.areaId).toBe(areaA.id);
    expect(newestA.scoreTotal).toBe(22);
    expect(newestA.prevScoreTotal).toBe(18);

    expect(areaBOnly.areaId).toBe(areaB.id);
    expect(areaBOnly.prevScoreTotal).toBeNull();

    expect(middleA.scoreTotal).toBe(18);
    expect(middleA.prevScoreTotal).toBe(12);

    expect(oldestA.scoreTotal).toBe(12);
    expect(oldestA.prevScoreTotal).toBeNull();
  });

  it("respects the 7-day window boundary for bestScoreInLastWeek", async () => {
    // Anchor a target submission at "now" and create three priors:
    //   * 2d earlier, score 15 (inside the 7d window)
    //   * 6d 23h earlier, score 21 (just inside the 7d window)
    //   * 7d 1h earlier, score 25 (just outside the 7d window — must be excluded)
    // Expect bestScoreInLastWeek = 21 (max of the in-window priors).
    const now = Date.now();
    const target = await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 10,
      createdAt: new Date(now),
    });
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 15,
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    });
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 21,
      createdAt: new Date(now - (7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)),
    });
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 25,
      createdAt: new Date(now - (7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000)),
    });

    const res = await request(app)
      .get("/api/operator/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const targetRow = res.body.find((r: { id: number }) => r.id === target.id);
    expect(targetRow).toBeDefined();
    expect(targetRow.bestScoreInLastWeek).toBe(21);
    // The 25-pt submission is older than 7d → must NOT leak in as the best.
    expect(targetRow.bestScoreInLastWeek).not.toBe(25);
  });

  it("returns null bestScoreInLastWeek when there are no prior submissions in the window", async () => {
    const now = Date.now();
    const target = await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 10,
      createdAt: new Date(now),
    });
    // Only an out-of-window prior (> 7d ago).
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 20,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get("/api/operator/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const targetRow = res.body.find((r: { id: number }) => r.id === target.id);
    expect(targetRow).toBeDefined();
    expect(targetRow.bestScoreInLastWeek).toBeNull();
  });

  it("honors the limit query param and clamps invalid values to the default", async () => {
    // Insert 5 submissions spaced 1 minute apart so the order is deterministic.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await insertSubmission({
        userId,
        areaId: areaA.id,
        scoreTotal: 10 + i,
        createdAt: new Date(now - i * 60_000),
      });
    }

    const limited = await request(app)
      .get("/api/operator/recent?limit=2")
      .set("Authorization", `Bearer ${token}`);
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(2);
    // DESC by createdAt — i=0 is newest (score 10), i=1 is next (score 11).
    expect(limited.body[0].scoreTotal).toBe(10);
    expect(limited.body[1].scoreTotal).toBe(11);

    const defaulted = await request(app)
      .get("/api/operator/recent?limit=not-a-number")
      .set("Authorization", `Bearer ${token}`);
    expect(defaulted.status).toBe(200);
    // Default is 12 — we only inserted 5, so all 5 come back.
    expect(defaulted.body).toHaveLength(5);

    // Negative / zero limits are also rejected and fall back to the default.
    const zero = await request(app)
      .get("/api/operator/recent?limit=0")
      .set("Authorization", `Bearer ${token}`);
    expect(zero.status).toBe(200);
    expect(zero.body).toHaveLength(5);

    // Limits over 50 are clamped (treated as invalid) and fall back to default.
    const huge = await request(app)
      .get("/api/operator/recent?limit=9999")
      .set("Authorization", `Bearer ${token}`);
    expect(huge.status).toBe(200);
    expect(huge.body).toHaveLength(5);
  });

  it("does not leak submissions from other operators", async () => {
    const now = Date.now();
    await insertSubmission({
      userId,
      areaId: areaA.id,
      scoreTotal: 10,
      createdAt: new Date(now),
    });
    await insertSubmission({
      userId: otherUserId,
      areaId: areaA.id,
      scoreTotal: 25,
      createdAt: new Date(now - 60_000),
    });

    const res = await request(app)
      .get("/api/operator/recent")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].scoreTotal).toBe(10);
  });
});
