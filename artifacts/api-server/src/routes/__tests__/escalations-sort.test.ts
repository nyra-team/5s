import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
  escalationsTable,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";

// End-to-end coverage for the new `sort` and `minRepingCount` query params on
// GET /escalations (Task 115). Before this change the list was hard-coded to
// `createdAt DESC`, so managers had to eyeball every card to find the
// most-pinged ones. The route now supports `sort=mostReminded` (repingCount
// DESC, createdAt DESC tiebreaker) and `minRepingCount=N` so the inbox can be
// narrowed to "needs attention" items.

const RUN_TAG = `esc-sort-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let area: { id: number; name: string };
let managerToken: string;

async function insertEscalation(opts: {
  scorePercent: number;
  createdAt: Date;
  repingCount?: number;
}): Promise<number> {
  const [sub] = await db
    .insert(submissionsTable)
    .values({
      userId: operatorId,
      areaId: area.id,
      shift: "A",
      scoreTotal: opts.scorePercent,
      scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}.jpg`,
      mediaType: "image",
      createdAt: opts.createdAt,
    })
    .returning();
  const [esc] = await db
    .insert(escalationsTable)
    .values({
      submissionId: sub.id,
      areaId: area.id,
      operatorId,
      scoreTotal: opts.scorePercent,
      scorePercent: opts.scorePercent,
      failingPillarsJson: ["sort"],
      recommendedActionsJson: [],
      evidenceUrlsJson: [],
      status: "OPEN",
      repingCount: opts.repingCount ?? 0,
      createdAt: opts.createdAt,
    })
    .returning();
  return esc.id;
}

async function clearEscalationsAndSubs() {
  await db.delete(escalationsTable).where(eq(escalationsTable.areaId, area.id));
  await db.delete(submissionsTable).where(eq(submissionsTable.areaId, area.id));
}

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
    .values({ name: `${RUN_TAG}-area` })
    .returning();
  area = { id: a.id, name: a.name };

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
});

afterAll(async () => {
  await clearEscalationsAndSubs();
  await db.delete(usersTable).where(inArray(usersTable.id, [managerId, operatorId]));
  await db.delete(areasTable).where(eq(areasTable.id, area.id));
  await pool.end();
});

beforeEach(async () => {
  await clearEscalationsAndSubs();
});

describe("GET /escalations sorting & filtering by repingCount", () => {
  it("defaults to createdAt DESC when no sort is provided", async () => {
    const now = Date.now();
    const oldest = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 3 * 60 * 60 * 1000),
      repingCount: 5, // most-pinged but oldest
    });
    const middle = await insertEscalation({
      scorePercent: 40,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 1,
    });
    const newest = await insertEscalation({
      scorePercent: 50,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 0, // never pinged but newest
    });

    const res = await request(app)
      .get("/api/escalations")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) => [oldest, middle, newest].includes(r.id))
      .map((r) => r.id);
    expect(ids).toEqual([newest, middle, oldest]);
  });

  it("sort=mostReminded floats the most-pinged escalations to the top", async () => {
    // Newest item has 0 pings; we want the heavily-pinged older items first.
    const now = Date.now();
    const lowPinNew = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 0,
    });
    const midPinMid = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 2,
    });
    const highPinOld = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 3 * 60 * 60 * 1000),
      repingCount: 5,
    });

    const res = await request(app)
      .get("/api/escalations?sort=mostReminded")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) => [lowPinNew, midPinMid, highPinOld].includes(r.id))
      .map((r) => r.id);
    expect(ids).toEqual([highPinOld, midPinMid, lowPinNew]);
  });

  it("sort=mostReminded falls back to createdAt DESC when repingCounts tie", async () => {
    const now = Date.now();
    const olderTied = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 2,
    });
    const newerTied = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 2,
    });

    const res = await request(app)
      .get("/api/escalations?sort=mostReminded")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) => [olderTied, newerTied].includes(r.id))
      .map((r) => r.id);
    expect(ids).toEqual([newerTied, olderTied]);
  });

  it("minRepingCount=1 filters out escalations that have never been re-pinged", async () => {
    const now = Date.now();
    const neverPinged = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 0,
    });
    const oncePinged = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 1,
    });
    const heavilyPinged = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 3 * 60 * 60 * 1000),
      repingCount: 4,
    });

    const res = await request(app)
      .get("/api/escalations?minRepingCount=1")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) => [neverPinged, oncePinged, heavilyPinged].includes(r.id))
      .map((r) => r.id);
    expect(ids).not.toContain(neverPinged);
    expect(ids).toContain(oncePinged);
    expect(ids).toContain(heavilyPinged);
  });

  it("minRepingCount=0 (or omitted) does not filter anything out", async () => {
    const now = Date.now();
    const neverPinged = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 0,
    });
    const oncePinged = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 1,
    });

    const res = await request(app)
      .get("/api/escalations?minRepingCount=0")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) => [neverPinged, oncePinged].includes(r.id))
      .map((r) => r.id);
    expect(ids).toContain(neverPinged);
    expect(ids).toContain(oncePinged);
  });

  it("invalid minRepingCount values are ignored rather than blanking the inbox", async () => {
    // A typo'd query param previously had no effect; make sure that contract
    // still holds so a manager doesn't see an empty inbox after a bad URL.
    const now = Date.now();
    const item = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 60 * 1000),
      repingCount: 0,
    });

    const res = await request(app)
      .get("/api/escalations?minRepingCount=not-a-number")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((r) => r.id);
    expect(ids).toContain(item);
  });

  it("sort and minRepingCount compose with each other and with the status filter", async () => {
    const now = Date.now();
    // OPEN, never pinged — should be filtered out by minRepingCount=1.
    const openNoPing = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 1 * 60 * 60 * 1000),
      repingCount: 0,
    });
    const openMidPing = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 2 * 60 * 60 * 1000),
      repingCount: 2,
    });
    const openHighPing = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 3 * 60 * 60 * 1000),
      repingCount: 5,
    });
    // RESOLVED with high ping count — should be hidden by status=OPEN even if
    // it would otherwise win the mostReminded sort.
    const resolvedHighPing = await insertEscalation({
      scorePercent: 30,
      createdAt: new Date(now - 4 * 60 * 60 * 1000),
      repingCount: 9,
    });
    await db
      .update(escalationsTable)
      .set({ status: "RESOLVED" })
      .where(eq(escalationsTable.id, resolvedHighPing));

    const res = await request(app)
      .get("/api/escalations?status=OPEN&sort=mostReminded&minRepingCount=1")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[])
      .filter((r) =>
        [openNoPing, openMidPing, openHighPing, resolvedHighPing].includes(r.id),
      )
      .map((r) => r.id);
    expect(ids).toEqual([openHighPing, openMidPing]);
    expect(ids).not.toContain(openNoPing);
    expect(ids).not.toContain(resolvedHighPing);
  });
});
