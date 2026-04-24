import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, areaProfilesTable } from "@workspace/db";
import { TestWorld, getBaseUrl } from "./helpers.js";
import {
  __setIdentifyAreaForTests,
  type IdentificationAreaProfile,
  type IdentificationInput,
  type IdentificationResult,
} from "../src/lib/ai-identification.js";

interface IdentifyResponse {
  candidates: Array<{ areaId: number; areaName?: string; confidence: number; reason?: string }>;
  hasTrainedAreas: boolean;
  rationale: string | null;
}

// The endpoint accepts multipart/form-data, not JSON, so the shared `api()`
// helper (which only sends JSON) won't work. This local helper posts a tiny
// in-memory PNG blob — small enough that even when no profiles exist and the
// VLM call is skipped, multer still has a valid file to write to disk.
async function postIdentifyArea(token: string | null): Promise<{
  status: number;
  body: IdentifyResponse | { error: string };
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
  return { status: resp.status, body: parsed as IdentifyResponse | { error: string } };
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
    const body = r.body as IdentifyResponse;
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

  describe("success path (with stubbed identifier)", () => {
    // The stub plays the role of the VLM: given the trained profiles passed
    // by the route, it picks whichever one looks most like a "welding" area
    // based on its summary/items/machines text. This lets us verify the
    // route's end-to-end shape — profile assembly, candidate ordering,
    // rationale passthrough — without hitting a real model.
    function scoreProfile(p: IdentificationAreaProfile): number {
      const haystack = [
        p.areaName,
        p.summary ?? "",
        ...p.items,
        ...p.machines,
        ...p.layout,
      ]
        .join(" ")
        .toLowerCase();
      const keywords = ["weld", "torch", "spark", "ppe", "helmet"];
      let score = 0;
      for (const kw of keywords) if (haystack.includes(kw)) score += 1;
      return score;
    }

    let lastInput: IdentificationInput | null = null;

    beforeEach(() => {
      lastInput = null;
      __setIdentifyAreaForTests(async (input) => {
        lastInput = input;
        // Rank by keyword score; break ties deterministically by areaId so
        // the assertions about ordering don't depend on Map insertion order.
        const ranked = [...input.profiles]
          .map((p) => ({ p, s: scoreProfile(p) }))
          .sort((a, b) => (b.s - a.s) || (a.p.areaId - b.p.areaId));
        const top = ranked[0];
        const candidates = ranked.map(({ p, s }, idx) => ({
          areaId: p.areaId,
          areaName: p.areaName,
          // Top match gets a clearly higher confidence than the rest, mimicking
          // how the real prompt is supposed to behave.
          confidence: idx === 0 && s > 0 ? 0.92 : Math.max(0.05, 0.3 - idx * 0.1),
        }));
        const result: IdentificationResult = {
          candidates,
          rationale: top && scoreProfile(top.p) > 0
            ? `Visible welding torch and helmet match "${top.p.areaName}".`
            : null,
        };
        return result;
      });
    });

    afterEach(() => {
      __setIdentifyAreaForTests(null);
    });

    test("ranks the matching trained area first with high confidence", async () => {
      const operator = await world.createUser("OPERATOR");

      // Two clearly-distinct trained areas. The "welding" one should win
      // because the stubbed identifier rewards weld/torch/helmet keywords.
      const welding = await world.createArea("weldingbay");
      const packaging = await world.createArea("packaging");
      await db.insert(areaProfilesTable).values([
        {
          areaId: welding.id,
          status: "TRAINED",
          summary: "Welding bay with active torch work and PPE racks.",
          itemsJson: ["welding helmet", "spark mat", "rod box"],
          machinesJson: ["MIG welder", "plasma torch"],
          layoutJson: ["torch station along east wall"],
        },
        {
          areaId: packaging.id,
          status: "TRAINED",
          summary: "Packaging line with conveyor and tape stations.",
          itemsJson: ["cardboard boxes", "tape rolls", "labels"],
          machinesJson: ["conveyor belt", "shrink wrapper"],
          layoutJson: ["pallet area near roll-up door"],
        },
      ]);

      const r = await postIdentifyArea(operator.token);
      assert.equal(r.status, 200);
      const body = r.body as IdentifyResponse;
      assert.equal(body.hasTrainedAreas, true);

      // Stub was called with the route's assembled profile list (both TRAINED
      // areas, no LEARNING ones).
      assert.ok(lastInput, "identifyArea should have been invoked");
      assert.equal(lastInput!.mediaType, "image");
      const passedIds = lastInput!.profiles.map((p) => p.areaId).sort((a, b) => a - b);
      assert.deepEqual(passedIds, [welding.id, packaging.id].sort((a, b) => a - b));

      // The welding area must be the top candidate, with a confidence
      // that's visibly higher than the runner-up so the UI's "AI thinks…"
      // suggestion is unambiguous.
      assert.ok(body.candidates.length >= 2, "expected both areas in the response");
      assert.equal(body.candidates[0].areaId, welding.id);
      assert.ok(
        body.candidates[0].confidence >= 0.7,
        `top confidence too low: ${body.candidates[0].confidence}`,
      );
      assert.ok(
        body.candidates[0].confidence - body.candidates[1].confidence >= 0.2,
        `top should beat runner-up by a clear margin: ${JSON.stringify(body.candidates)}`,
      );
      assert.ok(
        typeof body.rationale === "string" && body.rationale.length > 0,
        "rationale should be passed through to the response",
      );
    });

    test("ignores LEARNING profiles when assembling candidates", async () => {
      const operator = await world.createUser("OPERATOR");

      // Two TRAINED areas plus one LEARNING area. The LEARNING one would be
      // a textual match for the welding keywords, but it must NOT be sent
      // to the identifier — only TRAINED profiles are candidates.
      const welding = await world.createArea("weldingbay");
      const packaging = await world.createArea("packaging");
      const learningWeld = await world.createArea("learningweld");
      await db.insert(areaProfilesTable).values([
        {
          areaId: welding.id,
          status: "TRAINED",
          summary: "Welding bay with torch and helmet.",
          itemsJson: ["welding helmet"],
          machinesJson: ["MIG welder"],
          layoutJson: [],
        },
        {
          areaId: packaging.id,
          status: "TRAINED",
          summary: "Packaging line.",
          itemsJson: ["boxes"],
          machinesJson: ["conveyor"],
          layoutJson: [],
        },
        {
          areaId: learningWeld.id,
          status: "LEARNING",
          summary: "Another welding zone — but still learning.",
          itemsJson: ["torch", "helmet"],
          machinesJson: ["welder"],
          layoutJson: [],
        },
      ]);

      const r = await postIdentifyArea(operator.token);
      assert.equal(r.status, 200);
      const body = r.body as IdentifyResponse;
      assert.equal(body.hasTrainedAreas, true);

      assert.ok(lastInput);
      const passedIds = new Set(lastInput!.profiles.map((p) => p.areaId));
      assert.ok(passedIds.has(welding.id));
      assert.ok(passedIds.has(packaging.id));
      assert.ok(
        !passedIds.has(learningWeld.id),
        "LEARNING profiles must not be passed to the identifier",
      );

      // The TRAINED welding area still wins.
      assert.equal(body.candidates[0].areaId, welding.id);
      const returnedIds = new Set(body.candidates.map((c) => c.areaId));
      assert.ok(!returnedIds.has(learningWeld.id));
    });

    test("falls back to empty candidates when the identifier throws", async () => {
      // The route catches identifier errors and returns an empty-candidates
      // 200 so the operator UI can fall back to manual area selection
      // without surfacing a blocking error. Verify that contract here so a
      // future refactor doesn't accidentally start 5xx-ing instead.
      __setIdentifyAreaForTests(async () => {
        throw new Error("simulated VLM failure");
      });

      const operator = await world.createUser("OPERATOR");
      const trained = await world.createArea("trainedarea");
      await db.insert(areaProfilesTable).values({
        areaId: trained.id,
        status: "TRAINED",
        summary: "Trained area",
      });

      const r = await postIdentifyArea(operator.token);
      assert.equal(r.status, 200);
      const body = r.body as IdentifyResponse;
      assert.equal(body.hasTrainedAreas, true);
      assert.deepEqual(body.candidates, []);
      assert.equal(body.rationale, null);
    });
  });
});
