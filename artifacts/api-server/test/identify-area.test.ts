import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, areaProfilesTable } from "@workspace/db";
import { TestWorld, getBaseUrl } from "./helpers.js";

interface IdentifyResult {
  candidates: Array<{ areaId: number; confidence: number; reason?: string }>;
  hasTrainedAreas: boolean;
  rationale: string | null;
}

// The endpoint accepts multipart/form-data, not JSON, so the shared `api()`
// helper (which only sends JSON) won't work. This local helper posts a tiny
// in-memory PNG blob — small enough that even when no profiles exist and the
// VLM call is skipped, multer still has a valid file to write to disk.
async function postIdentifyArea(token: string | null): Promise<{
  status: number;
  body: IdentifyResult | { error: string };
}> {
  const fd = new FormData();
  // 1x1 transparent PNG. Concrete bytes don't matter when no TRAINED profiles
  // exist (the VLM call is skipped) and we never enable the success path here.
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  fd.append("media", new Blob([pngBytes], { type: "image/png" }), "tiny.png");

  const url = (await getBaseUrl()) + "/api/submissions/identify-area";
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const resp = await fetch(url, { method: "POST", headers, body: fd });
  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: resp.status, body: parsed as IdentifyResult | { error: string } };
}

describe("POST /api/submissions/identify-area", () => {
  let world: TestWorld;
  beforeEach(() => {
    world = new TestWorld();
  });
  afterEach(async () => {
    await world.cleanup();
  });

  test("requires authentication", async () => {
    const r = await postIdentifyArea(null);
    assert.equal(r.status, 401);
  });

  test("returns hasTrainedAreas:false when no TRAINED profiles exist", async () => {
    const operator = await world.createUser("OPERATOR");
    // Create an area whose profile is still LEARNING — it must NOT count as
    // a candidate, otherwise the endpoint would call the VLM with noise.
    const learning = await world.createArea("learningzone");
    await db
      .insert(areaProfilesTable)
      .values({ areaId: learning.id, status: "LEARNING", summary: "still learning" });

    const r = await postIdentifyArea(operator.token);
    assert.equal(r.status, 200);
    const body = r.body as IdentifyResult;
    assert.equal(body.hasTrainedAreas, false);
    assert.deepEqual(body.candidates, []);
    assert.equal(body.rationale, null);
  });

  test("rejects requests with no media file", async () => {
    const operator = await world.createUser("OPERATOR");
    const url = (await getBaseUrl()) + "/api/submissions/identify-area";
    // Empty multipart body so multer parses successfully but finds no files.
    const fd = new FormData();
    const resp = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${operator.token}` },
      body: fd,
    });
    assert.equal(resp.status, 400);
  });
});
