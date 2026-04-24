import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import path from "node:path";
import fs from "node:fs";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  areasTable,
  submissionsTable,
  areaProfilesTable,
  areaSchedulesTable,
  escalationsTable,
} from "@workspace/db";

// Pin the math + auth rules behind:
//   - GET  /api/dashboard/area-detection-agreement  (manager-only aggregator)
//   - POST /api/submissions                          (the `tappedAreaId` field
//                                                     and the structured
//                                                     `area-detection-correction`
//                                                     log entries)
//
// The end-to-end smoke from task #83 already exercises the happy path, but
// these tests pin the per-row math, sort order, day-window clamping, and
// auth boundaries so a refactor in dashboard.ts / submissions.ts can't
// silently change the agreement numbers managers see.

// We mock the heavy AI scorer BEFORE importing the app so the POST
// /submissions tests don't actually call the VLM. The dashboard tests don't
// care about scoring at all — they insert submissions directly via Drizzle.
const scoreSubmissionMock = vi.fn();
vi.mock("../../lib/ai-scoring.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/ai-scoring.js")>();
  return {
    ...actual,
    scoreSubmission: scoreSubmissionMock,
  };
});

function defaultScoringResult() {
  // A passing score (25 → 100%) keeps `maybeCreateEscalation` from firing,
  // so we don't have to clean up escalation rows after every POST test.
  return {
    embeddingHash: "mock-hash",
    aiTotalScore: 25,
    aiPillarsJson: { sort: 5, set: 5, shine: 5, standardize: 5, sustain: 5 },
    aiReasoningJson: null,
    aiRecommendationsJson: [
      { action: "MOCK rec", why: "mock", location: "general" },
    ],
    aiIssuesJson: [],
    failingPillars: [],
    modelVersion: "mock-v1",
    scoringMode: "VLM_RUBRIC",
    profile: {
      items: [],
      machines: [],
      layout: [],
      observedIssues: [],
      summary: "",
    },
    keyframeUrls: [],
  };
}

let app: typeof import("../../app").default;
let signToken: typeof import("../../lib/auth").signToken;
let logger: typeof import("../../lib/logger").logger;

const RUN_TAG = `area-detection-agreement-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

let managerId: number;
let operator1Id: number;
let operator2Id: number;
let managerToken: string;
let operator1Token: string;
let areaA: { id: number; name: string };
let areaB: { id: number; name: string };
let areaC: { id: number; name: string };

async function clearOurSubmissions() {
  // Drop any submissions tied to our seeded users so each test starts with
  // a clean slate (subsequent tests rely on knowing exactly how many of
  // *our* rows are in the agreement window).
  const subs = await db
    .select({ id: submissionsTable.id })
    .from(submissionsTable)
    .where(
      inArray(submissionsTable.userId, [operator1Id, operator2Id, managerId]),
    );
  if (subs.length > 0) {
    await db
      .delete(escalationsTable)
      .where(
        inArray(
          escalationsTable.submissionId,
          subs.map((s) => s.id),
        ),
      );
    await db
      .delete(submissionsTable)
      .where(
        inArray(
          submissionsTable.id,
          subs.map((s) => s.id),
        ),
      );
  }
}

beforeAll(async () => {
  ({ default: app } = await import("../../app"));
  ({ signToken } = await import("../../lib/auth"));
  ({ logger } = await import("../../lib/logger"));

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  const [m] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-mgr@test.local`,
      passwordHash: "x",
      role: "MANAGER",
    })
    .returning();
  managerId = m.id;
  managerToken = signToken({ userId: managerId, role: "MANAGER" });

  const [o1] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op1@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operator1Id = o1.id;
  operator1Token = signToken({ userId: operator1Id, role: "OPERATOR" });

  const [o2] = await db
    .insert(usersTable)
    .values({
      email: `${RUN_TAG}-op2@test.local`,
      passwordHash: "x",
      role: "OPERATOR",
    })
    .returning();
  operator2Id = o2.id;

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
  const [c] = await db
    .insert(areasTable)
    .values({ name: `${RUN_TAG}-area-C` })
    .returning();
  areaC = { id: c.id, name: c.name };
});

afterAll(async () => {
  await clearOurSubmissions();
  await db
    .delete(areaSchedulesTable)
    .where(inArray(areaSchedulesTable.areaId, [areaA.id, areaB.id, areaC.id]));
  await db
    .delete(areaProfilesTable)
    .where(inArray(areaProfilesTable.areaId, [areaA.id, areaB.id, areaC.id]));
  await db
    .delete(areasTable)
    .where(inArray(areasTable.id, [areaA.id, areaB.id, areaC.id]));
  await db
    .delete(usersTable)
    .where(inArray(usersTable.id, [managerId, operator1Id, operator2Id]));
  await pool.end();
});

beforeEach(async () => {
  scoreSubmissionMock.mockReset();
  scoreSubmissionMock.mockResolvedValue(defaultScoringResult());
  await clearOurSubmissions();
});

async function insertSub(opts: {
  areaId: number;
  userId: number;
  tappedAreaId: number | null;
}) {
  const [s] = await db
    .insert(submissionsTable)
    .values({
      areaId: opts.areaId,
      userId: opts.userId,
      shift: "A",
      scoreTotal: 20,
      scoreJson: { sort: 4, set: 4, shine: 4, standardize: 4, sustain: 4 },
      suggestionsJson: [],
      imageUrl: `/uploads/${RUN_TAG}.jpg`,
      mediaType: "image",
      tappedAreaId: opts.tappedAreaId,
    })
    .returning();
  return s;
}

interface AgreementBucket {
  total: number;
  agreed: number;
  agreementPercent: number | null;
}
interface AgreementResponse {
  windowDays: number;
  overall: AgreementBucket;
  perArea: Array<{
    areaId: number;
    areaName: string;
    total: number;
    agreed: number;
    agreementPercent: number | null;
  }>;
  perOperator: Array<{
    userId: number;
    userEmail: string;
    total: number;
    agreed: number;
    agreementPercent: number | null;
  }>;
}

async function getAgreement(
  token: string,
  query = "",
): Promise<{ status: number; body: AgreementResponse }> {
  const res = await request(app)
    .get(`/api/dashboard/area-detection-agreement${query}`)
    .set("Authorization", `Bearer ${token}`);
  return { status: res.status, body: res.body };
}

describe("GET /api/dashboard/area-detection-agreement", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app).get(
      "/api/dashboard/area-detection-agreement",
    );
    expect(res.status).toBe(401);
  });

  it("rejects operators with 403 (manager-only endpoint)", async () => {
    const res = await request(app)
      .get("/api/dashboard/area-detection-agreement")
      .set("Authorization", `Bearer ${operator1Token}`);
    expect(res.status).toBe(403);
  });

  it("computes overall agreed/total/percent and excludes null tappedAreaId rows", async () => {
    // Snapshot the overall counters before inserting ours so we can assert
    // against deltas — the dev DB may already hold unrelated rows.
    const before = await getAgreement(managerToken, "?days=30");
    expect(before.status).toBe(200);

    // 3 agreed (tapped == chosen), 2 disagreed (tapped != chosen),
    // 1 legacy null row that must NOT be counted.
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaB.id, userId: operator1Id, tappedAreaId: areaB.id });
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaB.id });
    await insertSub({ areaId: areaB.id, userId: operator2Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: null });

    const after = await getAgreement(managerToken, "?days=30");
    expect(after.status).toBe(200);

    const deltaTotal = after.body.overall.total - before.body.overall.total;
    const deltaAgreed = after.body.overall.agreed - before.body.overall.agreed;
    expect(deltaTotal).toBe(5); // null row excluded
    expect(deltaAgreed).toBe(3);

    // Ratio of agreed/total in our slice is 3/5 = 60%. The endpoint rounds
    // to integer percent. We can't directly assert the overall percent
    // (other rows in the window mix in), but the per-operator bucket only
    // sees our two operators' rows for this fixture.
    const op1 = after.body.perOperator.find((r) => r.userId === operator1Id)!;
    const op2 = after.body.perOperator.find((r) => r.userId === operator2Id)!;
    expect(op1).toBeTruthy();
    expect(op2).toBeTruthy();
    // operator1: 4 non-null rows, 3 agreed → 75%
    expect(op1.total).toBe(4);
    expect(op1.agreed).toBe(3);
    expect(op1.agreementPercent).toBe(75);
    expect(op1.userEmail).toBe(`${RUN_TAG}-op1@test.local`);
    // operator2: 1 non-null row, 0 agreed → 0%
    expect(op2.total).toBe(1);
    expect(op2.agreed).toBe(0);
    expect(op2.agreementPercent).toBe(0);
  });

  it("buckets per-area rows under both the tapped and chosen area when they differ", async () => {
    // 2 agreed on areaA, 1 drifted (tapped B → chose A) — areaB ends up
    // with the drift even though the submission was saved under areaA.
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaB.id });

    const r = await getAgreement(managerToken, "?days=30");
    expect(r.status).toBe(200);

    const a = r.body.perArea.find((row) => row.areaId === areaA.id)!;
    const b = r.body.perArea.find((row) => row.areaId === areaB.id)!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // areaA: 3 rows attributed (2 agreed where tapped == A, 1 disagreed
    // where chosen == A but tapped == B)
    expect(a.total).toBe(3);
    expect(a.agreed).toBe(2);
    expect(a.agreementPercent).toBe(67);
    expect(a.areaName).toBe(areaA.name);
    // areaB: 1 row attributed (the drift row whose tapped area was B)
    expect(b.total).toBe(1);
    expect(b.agreed).toBe(0);
    expect(b.agreementPercent).toBe(0);
    expect(b.areaName).toBe(areaB.name);
  });

  it("sorts per-area and per-operator rows lowest-agreement first", async () => {
    // areaA: 1/1 agreed (100%)
    // areaB: 1/2 agreed (50%)
    // areaC: 0/2 agreed (0%)
    await insertSub({ areaId: areaA.id, userId: operator1Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaB.id, userId: operator1Id, tappedAreaId: areaB.id });
    await insertSub({ areaId: areaB.id, userId: operator1Id, tappedAreaId: areaC.id });
    await insertSub({ areaId: areaC.id, userId: operator2Id, tappedAreaId: areaA.id });
    await insertSub({ areaId: areaC.id, userId: operator2Id, tappedAreaId: areaB.id });

    const r = await getAgreement(managerToken, "?days=30");
    expect(r.status).toBe(200);

    // Filter to our areas and check relative order is ascending by
    // agreementPercent. Our worst (areaC, 0%) must show up before areaB
    // (50%), which must show up before areaA (100%).
    const ours = r.body.perArea.filter((row) =>
      [areaA.id, areaB.id, areaC.id].includes(row.areaId),
    );
    const positions = new Map(ours.map((row, i) => [row.areaId, i]));
    expect(positions.get(areaC.id)!).toBeLessThan(positions.get(areaB.id)!);
    expect(positions.get(areaB.id)!).toBeLessThan(positions.get(areaA.id)!);

    // Same lowest-first ordering for operators. operator2 = 0% (both
    // disagreed), operator1 = 67% (2/3 agreed).
    const op1Pos = r.body.perOperator.findIndex(
      (row) => row.userId === operator1Id,
    );
    const op2Pos = r.body.perOperator.findIndex(
      (row) => row.userId === operator2Id,
    );
    expect(op2Pos).toBeGreaterThanOrEqual(0);
    expect(op1Pos).toBeGreaterThanOrEqual(0);
    expect(op2Pos).toBeLessThan(op1Pos);
  });

  it("clamps the days query param: ≤0 / >90 / non-numeric all fall back to 30", async () => {
    for (const q of ["?days=0", "?days=-5", "?days=91", "?days=banana", ""]) {
      const r = await getAgreement(managerToken, q);
      expect(r.status).toBe(200);
      expect(r.body.windowDays).toBe(30);
    }
  });

  it("honors in-range days values verbatim (1 and 90 are the boundaries)", async () => {
    for (const days of [1, 7, 90]) {
      const r = await getAgreement(managerToken, `?days=${days}`);
      expect(r.status).toBe(200);
      expect(r.body.windowDays).toBe(days);
    }
  });
});

describe("POST /api/submissions (tappedAreaId + correction logging)", () => {
  // Contract pinned here:
  //   - When the client omits `tappedAreaId`, the route defaults it to
  //     `areaId` so the row carries a non-null intent on file.
  //   - When `tappedAreaId !== areaId`, the route emits a structured
  //     `area-detection-correction` log entry (source: tapped-vs-chosen)
  //     so future profile rebuilds can mine corrections without
  //     scanning every submission row.
  //   - When `aiSuggestedAreaId` is provided and differs from the chosen
  //     area, the route also emits an `area-detection-correction` entry
  //     (source: ai-suggested-vs-chosen).
  // The aggregator endpoint above already covers the math; these tests
  // pin the storage and logging side-effects.

  function captureLogs() {
    return vi
      .spyOn(logger, "info")
      .mockImplementation((..._args: unknown[]) => undefined as never);
  }

  function correctionCalls(spy: ReturnType<typeof captureLogs>) {
    return spy.mock.calls.filter((c) => {
      const meta = c[0] as { kind?: string } | undefined;
      return meta?.kind === "area-detection-correction";
    });
  }

  it("defaults tappedAreaId to areaId when the client omits the field, with no correction log", async () => {
    const spy = captureLogs();

    const res = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${operator1Token}`)
      .field("areaId", String(areaA.id))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: `${RUN_TAG}-omit.jpg`,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(201);
    expect(res.body.areaId).toBe(areaA.id);
    // Defaulting to areaId means the row has a non-null intent on file.
    // The aggregator's `isNotNull(tappedAreaId)` filter still excludes
    // legacy rows from before this column existed, so historical
    // agreement isn't artificially inflated.
    expect(res.body.tappedAreaId).toBe(areaA.id);

    // Confirm the persisted row matches the response.
    const [persisted] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, res.body.id));
    expect(persisted.tappedAreaId).toBe(areaA.id);

    // No correction log: chosen == tapped (== areaId default) and
    // aiSuggestedAreaId wasn't sent.
    expect(correctionCalls(spy)).toHaveLength(0);

    spy.mockRestore();
  });

  it("persists tappedAreaId verbatim when the client sends the same area, with no correction log", async () => {
    const spy = captureLogs();

    const res = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${operator1Token}`)
      .field("areaId", String(areaA.id))
      .field("tappedAreaId", String(areaA.id))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: `${RUN_TAG}-match.jpg`,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(201);
    expect(res.body.tappedAreaId).toBe(areaA.id);

    expect(correctionCalls(spy)).toHaveLength(0);

    spy.mockRestore();
  });

  it("emits area-detection-correction when the chosen area differs from the tapped area", async () => {
    const spy = captureLogs();

    const res = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${operator1Token}`)
      .field("areaId", String(areaA.id))
      .field("tappedAreaId", String(areaB.id))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: `${RUN_TAG}-drift.jpg`,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(201);
    expect(res.body.tappedAreaId).toBe(areaB.id);
    expect(res.body.areaId).toBe(areaA.id);

    const calls = correctionCalls(spy);
    // Exactly one correction (the tapped-vs-chosen one). The AI
    // suggestion wasn't provided, so no second entry.
    expect(calls).toHaveLength(1);
    const meta = calls[0][0] as {
      tappedAreaId: number;
      chosenAreaId: number;
      userId: number;
      source: string;
    };
    expect(meta.tappedAreaId).toBe(areaB.id);
    expect(meta.chosenAreaId).toBe(areaA.id);
    expect(meta.userId).toBe(operator1Id);
    expect(meta.source).toBe("tapped-vs-chosen");

    spy.mockRestore();
  });

  it("emits area-detection-correction when the operator overrides the AI's top suggestion", async () => {
    const spy = captureLogs();

    // tappedAreaId == areaId (no tap drift), but the AI suggested a
    // different area — that's the highest-signal correction the route
    // can capture and the route emits a separate correction entry
    // disambiguated by `source: ai-suggested-vs-chosen`.
    const res = await request(app)
      .post("/api/submissions")
      .set("Authorization", `Bearer ${operator1Token}`)
      .field("areaId", String(areaA.id))
      .field("tappedAreaId", String(areaA.id))
      .field("aiSuggestedAreaId", String(areaB.id))
      .attach("photo", Buffer.from("fake-jpeg-bytes"), {
        filename: `${RUN_TAG}-correction.jpg`,
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(201);

    const calls = correctionCalls(spy);
    expect(calls).toHaveLength(1);
    const meta = calls[0][0] as {
      aiSuggestedAreaId: number;
      chosenAreaId: number;
      userId: number;
      source: string;
    };
    expect(meta.aiSuggestedAreaId).toBe(areaB.id);
    expect(meta.chosenAreaId).toBe(areaA.id);
    expect(meta.userId).toBe(operator1Id);
    expect(meta.source).toBe("ai-suggested-vs-chosen");

    spy.mockRestore();
  });
});
