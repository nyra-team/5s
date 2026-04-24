import { describe, test, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TestWorld, api, getBaseUrl, type TestUser } from "./helpers.js";
import {
  __setScoreSubmissionForTest,
  type ScoringInput,
  type ScoringOutput,
} from "../src/lib/ai-scoring.js";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

// Tracks every file multer writes during a test run so we can sweep them
// in afterEach. Without this each test would leave a tiny fake JPEG behind
// in `uploads/` and the directory would balloon over time.
const writtenUploadFiles = new Set<string>();

function rememberUploadFromUrl(imageUrl: string | undefined | null): void {
  if (!imageUrl) return;
  const base = path.basename(imageUrl);
  if (base) writtenUploadFiles.add(base);
}

function sweepWrittenUploads(): void {
  for (const name of writtenUploadFiles) {
    const abs = path.join(UPLOAD_DIR, name);
    try { fs.unlinkSync(abs); } catch { /* best-effort */ }
  }
  writtenUploadFiles.clear();
}

interface NudgeShape {
  id: number;
  areaId: number;
  machine: string | null;
  shift: string;
  dismissedAt: string | null;
}

interface SubmissionResponse {
  id: number;
  areaId: number;
  shift: string;
  scoreTotal: number;
  machineTag: string | null;
}

// Smallest possible JPEG (1x1, ~125 bytes). We never decode it — multer only
// inspects the Content-Type, and the scoring pipeline is stubbed below — but
// using a real JPEG keeps the bytes plausible if anything downstream peeks.
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
  "EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
  "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/8AAEQgAAQABAwEiAAIRAQMRAf/EABUAAQEAAAAAAA" +
  "AAAAAAAAAAAAAJ/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAA" +
  "AAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwA/wD/Z";
const TINY_JPEG_BYTES = Buffer.from(TINY_JPEG_BASE64, "base64");

function makeJpegBlob(): Blob {
  return new Blob([TINY_JPEG_BYTES], { type: "image/jpeg" });
}

// Deterministic stub so the real route handler runs end-to-end without
// hitting the VLM. We pin the score above the escalation threshold (60%)
// so we don't also have to wire up notifications.
function passingScoringStub(): ScoringOutput {
  return {
    embeddingHash: "test-stub-hash",
    aiTotalScore: 22,
    aiPillarsJson: { sort: 5, set: 4, shine: 5, standardize: 4, sustain: 4 },
    aiReasoningJson: null,
    aiRecommendationsJson: [
      { action: "Restock cleaning supplies", why: "stub", location: "center" },
    ],
    aiIssuesJson: [],
    failingPillars: [],
    modelVersion: "test-stub-v1",
    scoringMode: "TEST_STUB",
    profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "" },
    keyframeUrls: [],
  };
}

async function uploadSubmission(
  token: string,
  fields: { areaId: number; shift?: string; machineTag?: string | null },
): Promise<{ status: number; body: SubmissionResponse }> {
  const baseUrl = await getBaseUrl();
  const form = new FormData();
  form.append("areaId", String(fields.areaId));
  if (fields.shift) form.append("shift", fields.shift);
  if (fields.machineTag) form.append("machineTag", fields.machineTag);
  form.append("media", makeJpegBlob(), "test.jpg");
  const resp = await fetch(`${baseUrl}/api/submissions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await resp.json()) as SubmissionResponse;
  rememberUploadFromUrl((body as any)?.imageUrl);
  return { status: resp.status, body };
}

async function reuploadSubmission(
  token: string,
  submissionId: number,
  fields: { shift?: string; machineTag?: string | null } = {},
): Promise<{ status: number; body: SubmissionResponse }> {
  const baseUrl = await getBaseUrl();
  const form = new FormData();
  if (fields.shift) form.append("shift", fields.shift);
  if (fields.machineTag) form.append("machineTag", fields.machineTag);
  form.append("media", makeJpegBlob(), "test.jpg");
  const resp = await fetch(`${baseUrl}/api/submissions/${submissionId}/reupload`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await resp.json()) as SubmissionResponse;
  rememberUploadFromUrl((body as any)?.imageUrl);
  return { status: resp.status, body };
}

async function activeForArea(
  operator: TestUser,
  areaId: number,
  shift?: string,
): Promise<NudgeShape[]> {
  const path = shift
    ? `/api/nudges/active-by-area?shift=${shift}`
    : "/api/nudges/active-by-area";
  const r = await api<NudgeShape[]>(operator.token, "GET", path);
  assert.equal(r.status, 200);
  return r.body.filter((n) => n.areaId === areaId);
}

// Integration test for Task #77: prove the real POST /api/submissions
// (and PUT /api/submissions/:id/reupload) route handlers actually clear
// the manager's nudge. The companion suite in `nudges.test.ts` exercises
// the `dismissNudgesForSubmission` helper directly; this one stubs the
// scoring pipeline at the module boundary so the route runs end-to-end
// (multer upload → DB insert → nudge dismissal → response) without an
// AI network round-trip. That guards the call site itself: a future
// refactor that drops the dismissal call (or passes the wrong args)
// would silently let the operator's badge stop clearing on submit, and
// the helper-level tests would still pass.
describe("POST /api/submissions clears the manager's nudge (real upload route)", () => {
  let world: TestWorld;

  before(() => {
    __setScoreSubmissionForTest(async (_input: ScoringInput) => passingScoringStub());
  });
  after(() => {
    __setScoreSubmissionForTest(null);
    sweepWrittenUploads();
  });

  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => {
    await world.cleanup();
    sweepWrittenUploads();
  });

  test("upload to area+shift clears the area-level nudge", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.machine, null);

    // Sanity: the badge feed shows the nudge before the submission lands.
    const before = await activeForArea(operator, area.id, "A");
    assert.equal(before.length, 1, "nudge must be visible before the upload");

    const r = await uploadSubmission(operator.token, { areaId: area.id, shift: "A" });
    assert.equal(r.status, 201, "upload should succeed");
    assert.equal(r.body.areaId, area.id);
    assert.equal(r.body.shift, "A");

    const after = await activeForArea(operator, area.id, "A");
    assert.equal(
      after.length, 0,
      "real /api/submissions handler must clear the area-level nudge on submit",
    );
  });

  test("upload with matching machineTag clears the machine-pinned nudge", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A", machine: "M-7",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.machine, "M-7");

    const r = await uploadSubmission(operator.token, {
      areaId: area.id, shift: "A", machineTag: "M-7",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.machineTag, "M-7");

    const after = await activeForArea(operator, area.id, "A");
    assert.equal(
      after.length, 0,
      "matching-machine upload must clear the machine-pinned nudge",
    );
  });

  test("upload with a non-matching machineTag does NOT clear a machine-pinned nudge", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A", machine: "M-1",
    });
    assert.equal(created.status, 201);

    const r = await uploadSubmission(operator.token, {
      areaId: area.id, shift: "A", machineTag: "M-2",
    });
    assert.equal(r.status, 201);

    // The M-1 nudge survives because the operator submitted evidence for M-2.
    const after = await activeForArea(operator, area.id, "A");
    assert.equal(after.length, 1, "machine-pinned nudge must NOT clear on a different machine");
    assert.equal(after[0].id, created.body.id);
  });

  test("upload to one shift does not clear nudges in other shifts", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const a = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    const b = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "B",
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    const r = await uploadSubmission(operator.token, { areaId: area.id, shift: "A" });
    assert.equal(r.status, 201);

    const aRows = await activeForArea(operator, area.id, "A");
    const bRows = await activeForArea(operator, area.id, "B");
    assert.equal(aRows.length, 0, "shift A nudge must clear");
    assert.equal(bRows.length, 1, "shift B nudge must NOT clear");
    assert.equal(bRows[0].id, b.body.id);
  });
});

describe("PUT /api/submissions/:id/reupload clears the manager's nudge (real route)", () => {
  let world: TestWorld;

  before(() => {
    __setScoreSubmissionForTest(async (_input: ScoringInput) => passingScoringStub());
  });
  after(() => {
    __setScoreSubmissionForTest(null);
    sweepWrittenUploads();
  });

  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => {
    await world.cleanup();
    sweepWrittenUploads();
  });

  test("re-upload clears a fresh nudge for the same area+shift", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    // First submission lands BEFORE the manager files the nudge — so the
    // initial POST shouldn't have anything to clear. The point of this test
    // is that the *re-upload* path also wires through dismissNudgesForSubmission.
    const first = await uploadSubmission(operator.token, { areaId: area.id, shift: "A" });
    assert.equal(first.status, 201);

    const created = await api<NudgeShape>(manager.token, "POST", "/api/nudges", {
      areaId: area.id, shift: "A",
    });
    assert.equal(created.status, 201);

    const before = await activeForArea(operator, area.id, "A");
    assert.equal(before.length, 1);

    const r = await reuploadSubmission(operator.token, first.body.id, { shift: "A" });
    assert.equal(r.status, 200);

    const after = await activeForArea(operator, area.id, "A");
    assert.equal(
      after.length, 0,
      "real PUT /api/submissions/:id/reupload handler must clear the nudge on re-upload",
    );
  });
});
