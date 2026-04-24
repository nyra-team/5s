import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import path from "node:path";
import fs from "node:fs";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  areasTable,
  usersTable,
  submissionsTable,
  areaProfilesTable,
} from "@workspace/db";

// Mock the heavy bits of the scoring pipeline BEFORE importing the app, so
// the route picks up our stubs. We never want a unit test to actually call
// the VLM — we only need to verify the route persists ONLY aiReasoningJson
// when the scorer succeeds.
//
// `scoreSubmission` is mocked to return a fixed reasoning blob plus pillar
// scores that intentionally DIFFER from what's persisted on the legacy row,
// so the test can assert those persisted fields are left untouched.
const MOCK_REASONING = {
  sort: "MOCK frame 1: clear bench",
  set: "MOCK frame 1: tools racked",
  shine: "MOCK frame 1: floor clean",
  standardize: "MOCK frame 1: shadow board outlined",
  sustain: "MOCK frame 1: today's checklist signed",
};

const scoreSubmissionMock = vi.fn();

vi.mock("../../lib/ai-scoring.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/ai-scoring.js")>();
  return {
    ...actual,
    scoreSubmission: scoreSubmissionMock,
  };
});

// Default stub: a successful score with a different total + pillar mix to
// the legacy row's persisted values. Individual tests can override.
function defaultMockResult() {
  return {
    embeddingHash: "mock-hash",
    aiTotalScore: 25, // intentionally different from the legacy row
    aiPillarsJson: { sort: 5, set: 5, shine: 5, standardize: 5, sustain: 5 },
    aiReasoningJson: MOCK_REASONING,
    aiRecommendationsJson: [{ action: "MOCK rec", why: "mock", location: "general" }],
    aiIssuesJson: [{ issue: "MOCK issue", evidence: "mock", location: "general" }],
    failingPillars: [],
    modelVersion: "mock-v1",
    scoringMode: "VLM_RUBRIC",
    profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "" },
    keyframeUrls: [],
  };
}

let app: typeof import("../../app").default;
let signToken: typeof import("../../lib/auth").signToken;

const RUN_TAG = `admin-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
const PLACEHOLDER_FILENAME = `${RUN_TAG}.jpg`;
const PLACEHOLDER_PATH = path.join(UPLOADS_DIR, PLACEHOLDER_FILENAME);

let managerId: number;
let operatorId: number;
let areaId: number;
let token: string;

beforeAll(async () => {
  // Import after the mock is registered.
  ({ default: app } = await import("../../app"));
  ({ signToken } = await import("../../lib/auth"));

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(PLACEHOLDER_PATH, "placeholder");

  const [m] = await db.insert(usersTable).values({
    email: `${RUN_TAG}-manager@5s.test`,
    passwordHash: "x",
    role: "MANAGER",
  }).returning();
  managerId = m.id;
  token = signToken({ userId: m.id, role: "MANAGER" });

  const [o] = await db.insert(usersTable).values({
    email: `${RUN_TAG}-operator@5s.test`,
    passwordHash: "x",
    role: "OPERATOR",
  }).returning();
  operatorId = o.id;

  const [a] = await db.insert(areasTable).values({
    name: `${RUN_TAG}-area`,
  }).returning();
  areaId = a.id;
});

afterAll(async () => {
  // Clean up everything we inserted, including any submissions tagged with
  // our RUN_TAG. Use a wide net so a partial failure can't leak rows.
  const subs = await db
    .select({ id: submissionsTable.id })
    .from(submissionsTable)
    .where(eq(submissionsTable.areaId, areaId));
  if (subs.length > 0) {
    await db.delete(submissionsTable).where(inArray(submissionsTable.id, subs.map((s) => s.id)));
  }
  // The route's getOrCreateProfile() creates an area_profiles row. Drop it
  // before the area itself so the FK doesn't block the cleanup.
  await db.delete(areaProfilesTable).where(eq(areaProfilesTable.areaId, areaId));
  await db.delete(areasTable).where(eq(areasTable.id, areaId));
  await db.delete(usersTable).where(inArray(usersTable.id, [managerId, operatorId]));
  try { fs.unlinkSync(PLACEHOLDER_PATH); } catch { /* best-effort */ }
  await pool.end();
});

beforeEach(() => {
  scoreSubmissionMock.mockReset();
  scoreSubmissionMock.mockResolvedValue(defaultMockResult());
});

describe("POST /api/admin/backfill-reasoning (mocked scorer)", () => {
  it("writes only aiReasoningJson and leaves the persisted score fields untouched", async () => {
    // Persisted values that must NOT change after the backfill. Note these
    // intentionally DIFFER from defaultMockResult()'s pillars/total — if the
    // route accidentally overwrote them we'd see the mocked 5/5/5 values.
    const ORIGINAL_TOTAL = 11;
    const ORIGINAL_PILLARS = { sort: 3, set: 2, shine: 2, standardize: 2, sustain: 2 };
    const ORIGINAL_RECS = [{ action: "ORIGINAL rec", why: "old", location: "left" }];
    const ORIGINAL_ISSUES = [{ issue: "ORIGINAL issue", evidence: "frame 1", location: "left" }];
    const ORIGINAL_FAILING = ["set", "shine", "standardize", "sustain"];
    const ORIGINAL_MODEL = "legacy-v0";
    const ORIGINAL_MODE = "LEGACY_RUBRIC";

    const [legacy] = await db.insert(submissionsTable).values({
      areaId,
      userId: operatorId,
      shift: "A",
      scoreTotal: ORIGINAL_TOTAL,
      scoreJson: ORIGINAL_PILLARS,
      suggestionsJson: ["ORIGINAL suggestion"],
      imageUrl: `/uploads/${PLACEHOLDER_FILENAME}`,
      mediaType: "image",
      aiTotalScore: ORIGINAL_TOTAL,
      aiPillarsJson: ORIGINAL_PILLARS,
      aiRecommendationsJson: ORIGINAL_RECS,
      aiIssuesJson: ORIGINAL_ISSUES,
      failingPillarsJson: ORIGINAL_FAILING,
      modelVersion: ORIGINAL_MODEL,
      scoringMode: ORIGINAL_MODE,
      // aiReasoningJson is deliberately omitted -> NULL
    }).returning();

    const res = await request(app)
      .post(`/api/admin/backfill-reasoning?submissionId=${legacy.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.missingMedia).toBe(0);
    expect(res.body.scoringFailed).toBe(0);
    expect(scoreSubmissionMock).toHaveBeenCalledTimes(1);

    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, legacy.id));

    // The new reasoning landed.
    expect(after.aiReasoningJson).toEqual(MOCK_REASONING);

    // Everything else is byte-for-byte the same. This is the core
    // contract the task calls out: "without changing the persisted
    // scoreTotal/aiPillarsJson".
    expect(after.scoreTotal).toBe(ORIGINAL_TOTAL);
    expect(after.scoreJson).toEqual(ORIGINAL_PILLARS);
    expect(after.aiTotalScore).toBe(ORIGINAL_TOTAL);
    expect(after.aiPillarsJson).toEqual(ORIGINAL_PILLARS);
    expect(after.aiRecommendationsJson).toEqual(ORIGINAL_RECS);
    expect(after.aiIssuesJson).toEqual(ORIGINAL_ISSUES);
    expect(after.failingPillarsJson).toEqual(ORIGINAL_FAILING);
    expect(after.modelVersion).toBe(ORIGINAL_MODEL);
    expect(after.scoringMode).toBe(ORIGINAL_MODE);
  });

  it("does not write or call the VLM when dryRun is set", async () => {
    const [legacy] = await db.insert(submissionsTable).values({
      areaId,
      userId: operatorId,
      shift: "B",
      scoreTotal: 7,
      scoreJson: { sort: 2, set: 1, shine: 2, standardize: 1, sustain: 1 },
      suggestionsJson: [],
      imageUrl: `/uploads/${PLACEHOLDER_FILENAME}`,
      mediaType: "image",
    }).returning();

    const res = await request(app)
      .post(`/api/admin/backfill-reasoning?submissionId=${legacy.id}&dryRun=1`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.scanned).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.results[0]).toMatchObject({
      submissionId: legacy.id,
      status: "would_update",
    });
    expect(scoreSubmissionMock).not.toHaveBeenCalled();

    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, legacy.id));
    expect(after.aiReasoningJson).toBeNull();
  });

  it("counts scoring_failed and leaves the row alone when the VLM returns null reasoning", async () => {
    scoreSubmissionMock.mockResolvedValueOnce({
      ...defaultMockResult(),
      aiReasoningJson: null, // fallback path — VLM unavailable
    });

    const [legacy] = await db.insert(submissionsTable).values({
      areaId,
      userId: operatorId,
      shift: "C",
      scoreTotal: 6,
      scoreJson: { sort: 1, set: 1, shine: 2, standardize: 1, sustain: 1 },
      suggestionsJson: [],
      imageUrl: `/uploads/${PLACEHOLDER_FILENAME}`,
      mediaType: "image",
    }).returning();

    const res = await request(app)
      .post(`/api/admin/backfill-reasoning?submissionId=${legacy.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.scoringFailed).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(res.body.results[0]).toMatchObject({
      submissionId: legacy.id,
      status: "scoring_failed",
    });

    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, legacy.id));
    expect(after.aiReasoningJson).toBeNull();
  });

  it("treats dryRun=false as a real run (parser is strict, not truthy)", async () => {
    const [legacy] = await db.insert(submissionsTable).values({
      areaId,
      userId: operatorId,
      shift: "A",
      scoreTotal: 9,
      scoreJson: { sort: 2, set: 2, shine: 2, standardize: 2, sustain: 1 },
      suggestionsJson: [],
      imageUrl: `/uploads/${PLACEHOLDER_FILENAME}`,
      mediaType: "image",
    }).returning();

    const res = await request(app)
      .post(`/api/admin/backfill-reasoning?submissionId=${legacy.id}&dryRun=false`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.updated).toBe(1);
    expect(scoreSubmissionMock).toHaveBeenCalledTimes(1);
  });
});
