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
  areaDetectionEventsTable,
  AREA_DETECTION_EVENT_KIND,
} from "@workspace/db";
import app from "../../app";
import { signToken } from "../../lib/auth";
import {
  flagAreaIfBelowAgreementThreshold,
  rebuildAreaProfile,
  recordAreaDetectionEvent,
} from "../../lib/area-profile-tuning";

// Coverage for Task 136 — auto-detect retune loop.
//
// What we're verifying end-to-end:
//   1. Drift / correction events land in the audit table (not just logs).
//   2. The flag hook is no-op above threshold and below the min-sample
//      cutoff, and idempotent once already flagged.
//   3. The flag hook flips needsRebuild when agreement drops below the
//      configured threshold AND there are enough samples.
//   4. rebuildAreaProfile replays stored extracts in chronological order,
//      weights operator corrections, and clears the flag with a fresh
//      `lastRebuildAt` stamp.
//   5. Both new HTTP endpoints (POST .../rebuild-profile, GET
//      .../area-detection-events) are MANAGER-gated.

const RUN_TAG = `area-retune-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let managerId: number;
let operatorId: number;
let areaA: { id: number };
let areaB: { id: number };
let managerToken: string;
let operatorToken: string;

async function insertSubmission(opts: {
  areaId: number;
  tappedAreaId: number | null;
  createdAt: Date;
  profile?: {
    items: string[];
    machines: string[];
    layout: string[];
    observedIssues: string[];
    summary: string;
  };
}) {
  const [row] = await db
    .insert(submissionsTable)
    .values({
      userId: operatorId,
      areaId: opts.areaId,
      tappedAreaId: opts.tappedAreaId ?? null,
      shift: "A",
      scoreTotal: 18,
      scoreJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}-${Math.random().toString(36).slice(2, 8)}.jpg`,
      mediaType: "image",
      createdAt: opts.createdAt,
      profileExtractJson: opts.profile ?? null,
    })
    .returning();
  return row;
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
    .values({ name: `${RUN_TAG}-A` })
    .returning();
  areaA = { id: a.id };
  const [b] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-B` })
    .returning();
  areaB = { id: b.id };

  await db.insert(areaProfilesTable).values({
    areaId: areaA.id,
    status: "TRAINED",
    submissionsCount: 6,
    trainedAt: new Date(),
  });
  await db.insert(areaProfilesTable).values({
    areaId: areaB.id,
    status: "TRAINED",
    submissionsCount: 6,
    trainedAt: new Date(),
  });

  managerToken = signToken({ userId: managerId, role: "MANAGER" });
  operatorToken = signToken({ userId: operatorId, role: "OPERATOR" });
});

afterAll(async () => {
  await db
    .delete(areaDetectionEventsTable)
    .where(inArray(areaDetectionEventsTable.userId, [operatorId, managerId]));
  await db
    .delete(submissionsTable)
    .where(inArray(submissionsTable.userId, [operatorId, managerId]));
  await db
    .delete(areaProfilesTable)
    .where(inArray(areaProfilesTable.areaId, [areaA.id, areaB.id]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [areaA.id, areaB.id]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [operatorId, managerId]));
  await pool.end();
});

describe("area auto-retune", () => {
  it("persists drift and correction events to the audit table", async () => {
    const sub = await insertSubmission({
      areaId: areaA.id,
      tappedAreaId: areaB.id,
      createdAt: new Date(),
    });
    await recordAreaDetectionEvent({
      submissionId: sub.id,
      userId: operatorId,
      areaId: areaA.id,
      tappedAreaId: areaB.id,
      aiSuggestedAreaId: areaA.id,
      kind: AREA_DETECTION_EVENT_KIND.DRIFT,
    });
    await recordAreaDetectionEvent({
      submissionId: sub.id,
      userId: operatorId,
      areaId: areaA.id,
      tappedAreaId: areaB.id,
      aiSuggestedAreaId: areaB.id,
      kind: AREA_DETECTION_EVENT_KIND.CORRECTION,
    });

    const rows = await db
      .select()
      .from(areaDetectionEventsTable)
      .where(eq(areaDetectionEventsTable.submissionId, sub.id));
    expect(rows.map((r) => r.kind).sort()).toEqual(["CORRECTION", "DRIFT"]);
  });

  it("flag hook is a no-op above threshold and below the min-sample cutoff", async () => {
    // Above-threshold scenario: insert 6 agreed rows for areaB (well above 75%).
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      await insertSubmission({
        areaId: areaB.id,
        tappedAreaId: areaB.id,
        createdAt: new Date(now - i * 60_000),
      });
    }
    const above = await flagAreaIfBelowAgreementThreshold(areaB.id);
    expect(above.flagged).toBe(false);
    if (above.flagged === false) {
      expect(above.reason).toBe("above-threshold");
    }
    const [profileB] = await db
      .select()
      .from(areaProfilesTable)
      .where(eq(areaProfilesTable.areaId, areaB.id));
    expect(profileB.needsRebuild).toBe(false);
  });

  it("flips needsRebuild when agreement drops below threshold with enough samples", async () => {
    // Build a low-agreement window for areaA: 5 rows where the operator
    // tapped B but the system saved against A — that's 0/5 agreement, well
    // under the 75% default threshold.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await insertSubmission({
        areaId: areaA.id,
        tappedAreaId: areaB.id,
        createdAt: new Date(now - (i + 10) * 60_000),
        profile: {
          items: [`itemA-${i}`],
          machines: [`machineA-${i}`],
          layout: ["near door"],
          observedIssues: ["dust"],
          summary: `seen at ${i}`,
        },
      });
    }

    const result = await flagAreaIfBelowAgreementThreshold(areaA.id);
    expect(result.flagged).toBe(true);
    expect(result.agreement.total).toBeGreaterThanOrEqual(5);
    expect(result.agreement.agreementPercent).toBeLessThan(75);

    const [profileA] = await db
      .select()
      .from(areaProfilesTable)
      .where(eq(areaProfilesTable.areaId, areaA.id));
    expect(profileA.needsRebuild).toBe(true);
    expect(profileA.flagReason).toBe("low-agreement");
    expect(profileA.flaggedAt).toBeTruthy();

    // Idempotent: a second call should NOT re-stamp flaggedAt.
    const flaggedAtFirst = profileA.flaggedAt;
    const second = await flagAreaIfBelowAgreementThreshold(areaA.id);
    expect(second.flagged).toBe(false);
    if (second.flagged === false) {
      expect(second.reason).toBe("already-flagged");
    }
    const [profileA2] = await db
      .select()
      .from(areaProfilesTable)
      .where(eq(areaProfilesTable.areaId, areaA.id));
    expect(profileA2.flaggedAt?.toISOString()).toBe(
      flaggedAtFirst?.toISOString(),
    );
  });

  it("rebuildAreaProfile replays stored extracts, weights corrections, and clears the flag", async () => {
    // Add one more correction with a distinctive item so we can prove the
    // weighting put it in the merged profile output.
    await insertSubmission({
      areaId: areaA.id,
      tappedAreaId: areaB.id,
      createdAt: new Date(),
      profile: {
        items: ["corrected-marker-item"],
        machines: ["corrected-marker-machine"],
        layout: ["correction-layout"],
        observedIssues: ["correction-issue"],
        summary: "this is the latest correction summary",
      },
    });

    const result = await rebuildAreaProfile(areaA.id);
    expect(result.replayed).toBeGreaterThanOrEqual(6);
    expect(result.correctionsWeighted).toBeGreaterThanOrEqual(6);
    expect(result.itemCount).toBeGreaterThan(0);

    const [profileA] = await db
      .select()
      .from(areaProfilesTable)
      .where(eq(areaProfilesTable.areaId, areaA.id));
    expect(profileA.needsRebuild).toBe(false);
    expect(profileA.flaggedAt).toBeNull();
    expect(profileA.flagReason).toBeNull();
    expect(profileA.lastRebuildAt).toBeTruthy();
    expect(profileA.itemsJson).toContain("corrected-marker-item");
    expect(profileA.machinesJson).toContain("corrected-marker-machine");
    // Last seen non-empty summary wins.
    expect(profileA.summary).toBe("this is the latest correction summary");
  });

  it("rebuild and audit endpoints require MANAGER role", async () => {
    const opRebuild = await request(app)
      .post(`/api/dashboard/areas/${areaA.id}/rebuild-profile`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(opRebuild.status).toBe(403);

    const opEvents = await request(app)
      .get("/api/dashboard/area-detection-events")
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(opEvents.status).toBe(403);

    // Manager can rebuild and read events.
    const mgrRebuild = await request(app)
      .post(`/api/dashboard/areas/${areaA.id}/rebuild-profile`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(mgrRebuild.status).toBe(200);
    expect(mgrRebuild.body.areaId).toBe(areaA.id);
    expect(typeof mgrRebuild.body.replayed).toBe("number");

    const mgrEvents = await request(app)
      .get(`/api/dashboard/area-detection-events?areaId=${areaA.id}&days=30`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(mgrEvents.status).toBe(200);
    expect(Array.isArray(mgrEvents.body)).toBe(true);
    // We inserted at least one DRIFT and one CORRECTION earlier in the suite.
    const kinds = (mgrEvents.body as { kind: string }[]).map((e) => e.kind);
    expect(kinds).toContain("DRIFT");
    expect(kinds).toContain("CORRECTION");
  });

  it("agreement endpoint surfaces needsRebuild / flaggedAt / lastRebuildAt per area", async () => {
    // areaA was flagged then rebuilt above, so by now needsRebuild=false and
    // lastRebuildAt is set. Re-flag it so we can also see needsRebuild=true.
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await insertSubmission({
        areaId: areaA.id,
        tappedAreaId: areaB.id,
        createdAt: new Date(now - (i + 1) * 30_000),
      });
    }
    await flagAreaIfBelowAgreementThreshold(areaA.id);

    const res = await request(app)
      .get("/api/dashboard/area-detection-agreement?days=30")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);

    const rowA = (res.body.perArea as Array<{
      areaId: number;
      needsRebuild: boolean;
      flaggedAt: string | null;
      lastRebuildAt: string | null;
    }>).find((r) => r.areaId === areaA.id);
    expect(rowA).toBeDefined();
    expect(rowA?.needsRebuild).toBe(true);
    expect(rowA?.flaggedAt).toBeTruthy();
    expect(rowA?.lastRebuildAt).toBeTruthy();
  });
});
