import { describe, test, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { db, submissionsTable } from "@workspace/db";
import { TestWorld, api } from "./helpers.js";

interface BackfillRowResult {
  submissionId: number;
  status: "updated" | "missing_media" | "scoring_failed" | "would_update";
  reason?: string;
}

interface BackfillSummary {
  scanned: number;
  updated: number;
  missingMedia: number;
  scoringFailed: number;
  dryRun: boolean;
  results: BackfillRowResult[];
  remaining: number;
}

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

/**
 * Drop a tiny placeholder file in /uploads/ so the backfill route's
 * existsSync() check passes. We don't need real pixels because the dry-run
 * path never actually invokes the VLM.
 */
function ensurePlaceholderUpload(name: string): string {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const abs = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, "placeholder");
  return abs;
}

describe("POST /api/admin/backfill-reasoning", () => {
  let world: TestWorld;
  const cleanupFiles: string[] = [];

  before(() => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  });

  beforeEach(() => { world = new TestWorld(); });
  afterEach(async () => {
    await world.cleanup();
    while (cleanupFiles.length > 0) {
      const f = cleanupFiles.pop()!;
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }
  });

  test("rejects non-managers with 403", async () => {
    const operator = await world.createUser("OPERATOR");
    const r = await api(operator.token, "POST", "/api/admin/backfill-reasoning");
    assert.equal(r.status, 403);
  });

  test("rejects unauthenticated callers with 401", async () => {
    const r = await api(null, "POST", "/api/admin/backfill-reasoning");
    assert.equal(r.status, 401);
  });

  test("ignores submissions that already have reasoning (does not rescore)", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const reasoning = {
      sort: "frame 1: clear bench",
      set: "frame 1: tools on board",
      shine: "frame 1: floor swept",
      standardize: "frame 1: shadow board outlines visible",
      sustain: "frame 1: signed checklist on the wall",
    };
    const [existing] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 18,
        scoreJson: { sort: 4, set: 3, shine: 4, standardize: 3, sustain: 4 },
        suggestionsJson: [],
        imageUrl: "/uploads/already-reasoned.jpg",
        mediaType: "image",
        aiReasoningJson: reasoning,
      })
      .returning();

    const r = await api<BackfillSummary>(
      manager.token,
      "POST",
      "/api/admin/backfill-reasoning?limit=10",
    );
    assert.equal(r.status, 200);
    // The endpoint filters on aiReasoningJson IS NULL, so this row should
    // never even be considered. scanned counts only legacy rows.
    assert.ok(
      !r.body.results.some((x) => x.submissionId === existing.id),
      "rows that already have reasoning must be skipped by the SQL filter",
    );

    // Reasoning on the existing row must be untouched.
    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, existing.id));
    assert.deepEqual(after.aiReasoningJson, reasoning);
  });

  test("reports missing-media without touching the DB or calling the VLM", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    // Use a path that definitely doesn't exist on disk.
    const ghostUrl = `/uploads/ghost-${area.tag}.jpg`;
    const [legacy] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "B",
        scoreTotal: 8,
        scoreJson: { sort: 2, set: 2, shine: 1, standardize: 1, sustain: 2 },
        suggestionsJson: [],
        imageUrl: ghostUrl,
        mediaType: "image",
        aiPillarsJson: { sort: 2, set: 2, shine: 1, standardize: 1, sustain: 2 },
        aiTotalScore: 8,
      })
      .returning();

    const r = await api<BackfillSummary>(
      manager.token,
      "POST",
      `/api/admin/backfill-reasoning?submissionId=${legacy.id}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.scanned, 1);
    assert.equal(r.body.missingMedia, 1);
    assert.equal(r.body.updated, 0);
    const result = r.body.results[0];
    assert.equal(result.submissionId, legacy.id);
    assert.equal(result.status, "missing_media");

    // The persisted score data must be untouched.
    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, legacy.id));
    assert.equal(after.aiReasoningJson, null);
    assert.equal(after.scoreTotal, 8);
    assert.deepEqual(after.aiPillarsJson, {
      sort: 2, set: 2, shine: 1, standardize: 1, sustain: 2,
    });
  });

  test("rejects imageUrls that escape the uploads dir", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const [legacy] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 5,
        scoreJson: { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 },
        suggestionsJson: [],
        // Not an /uploads/ path — must be treated as missing media, never as
        // a candidate to read /etc/passwd.
        imageUrl: "https://evil.example/totally-not-a-file.jpg",
        mediaType: "image",
      })
      .returning();

    const r = await api<BackfillSummary>(
      manager.token,
      "POST",
      `/api/admin/backfill-reasoning?submissionId=${legacy.id}`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.missingMedia, 1);
    assert.equal(r.body.results[0].status, "missing_media");
  });

  test("dryRun marks legacy rows as would_update without writing or calling VLM", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    const filename = `placeholder-${area.tag}.jpg`;
    const abs = ensurePlaceholderUpload(filename);
    cleanupFiles.push(abs);

    const [legacy] = await db
      .insert(submissionsTable)
      .values({
        areaId: area.id,
        userId: operator.id,
        shift: "A",
        scoreTotal: 12,
        scoreJson: { sort: 3, set: 2, shine: 3, standardize: 2, sustain: 2 },
        suggestionsJson: [],
        imageUrl: `/uploads/${filename}`,
        mediaType: "image",
        aiPillarsJson: { sort: 3, set: 2, shine: 3, standardize: 2, sustain: 2 },
        aiTotalScore: 12,
      })
      .returning();

    const r = await api<BackfillSummary>(
      manager.token,
      "POST",
      `/api/admin/backfill-reasoning?submissionId=${legacy.id}&dryRun=1`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.scanned, 1);
    assert.equal(r.body.updated, 0);
    assert.equal(r.body.results[0].status, "would_update");

    // Definitely no DB write.
    const [after] = await db
      .select()
      .from(submissionsTable)
      .where(eq(submissionsTable.id, legacy.id));
    assert.equal(after.aiReasoningJson, null);
  });

  test("limit caps the number of rows scanned in a single batch", async () => {
    const manager = await world.createUser("MANAGER");
    const operator = await world.createUser("OPERATOR");
    const area = await world.createArea();

    // Three legacy rows, all missing-media (so we don't hit the VLM). With
    // limit=2 only the first two ids should appear in the response.
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [s] = await db
        .insert(submissionsTable)
        .values({
          areaId: area.id,
          userId: operator.id,
          shift: "A",
          scoreTotal: 5,
          scoreJson: { sort: 1, set: 1, shine: 1, standardize: 1, sustain: 1 },
          suggestionsJson: [],
          imageUrl: `/uploads/missing-${area.tag}-${i}.jpg`,
          mediaType: "image",
        })
        .returning();
      ids.push(s.id);
    }

    const r = await api<BackfillSummary>(
      manager.token,
      "POST",
      "/api/admin/backfill-reasoning?limit=2",
    );
    assert.equal(r.status, 200);
    // The endpoint orders by id ASC and may pick up unrelated legacy rows
    // from other tests' areas, but it must not exceed the cap.
    assert.ok(r.body.scanned <= 2, `scanned must respect limit (got ${r.body.scanned})`);
    assert.ok(r.body.results.length <= 2);
  });
});
