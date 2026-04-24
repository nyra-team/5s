import { openai } from "@workspace/integrations-openai-ai-server";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";
import { extractKeyframes, isVideoFile } from "./keyframes.js";

export interface IdentificationCandidate {
  areaId: number;
  areaName: string;
  confidence: number;
}

export interface IdentificationAreaProfile {
  areaId: number;
  areaName: string;
  summary: string | null;
  items: string[];
  machines: string[];
  layout: string[];
}

export interface IdentificationInput {
  mediaAbsPath: string;
  mediaType: "image" | "video";
  profiles: IdentificationAreaProfile[];
}

export interface IdentificationResult {
  candidates: IdentificationCandidate[];
  rationale: string | null;
}

// Future profile rebuilds should mine the structured `area-detection-drift`
// and `area-detection-correction` log entries (emitted from
// routes/submissions.ts when an operator's tapped area or the AI's top
// suggestion disagrees with the chosen area) plus the `tapped_area_id`
// column on the submissions table. Treat operator overrides of the AI's
// suggestion as the strongest signal that this prompt or the per-area
// profile needs more discriminating examples for the contested areas.
const IDENTIFICATION_PROMPT = `
You are a vision assistant that decides which of several known factory areas a submitted photo or video most likely shows.

You will be given:
- A list of CANDIDATE AREAS, each with the items, machines, layout notes and a short summary that has previously been observed there.
- One or more frames from a single submission.

Your job: rank the candidates by how likely the frames are to depict that area. Use visible machines, item types, layout/wall fixtures, and overall environment. Do not guess about areas that are not in the candidate list.

Output ONLY valid JSON in this exact shape:
{
  "candidates": [
    { "areaId": <integer>, "confidence": <number 0..1> }
  ],
  "rationale": "<one short sentence justifying the top match>"
}

Rules:
- Include EVERY candidate area in the output, even those with low confidence.
- Confidences should reflect relative certainty; the top match's confidence should be visibly higher than weak matches.
- If no candidate is a clear match, give them all low confidences (e.g. 0.1–0.3) — do not invent confidence.
- areaId must match one of the provided candidate areaIds exactly.
`.trim();

function imageToBase64(imagePath: string): string {
  return fs.readFileSync(imagePath).toString("base64");
}

function clampConfidence(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function buildProfileBlock(profiles: IdentificationAreaProfile[]): string {
  return profiles
    .map((p, idx) => {
      const lines: string[] = [
        `[${idx + 1}] AREA ID ${p.areaId} — "${p.areaName}"`,
      ];
      if (p.summary) lines.push(`  Summary: ${p.summary}`);
      if (p.machines.length > 0) lines.push(`  Machines: ${p.machines.join(", ")}`);
      if (p.items.length > 0) lines.push(`  Typical items: ${p.items.join(", ")}`);
      if (p.layout.length > 0) lines.push(`  Layout notes: ${p.layout.join("; ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

async function callIdentificationVLM(
  framePaths: string[],
  profiles: IdentificationAreaProfile[],
): Promise<IdentificationResult> {
  const profileBlock = buildProfileBlock(profiles);
  const validFrames = framePaths.filter((p) => fs.existsSync(p));
  if (validFrames.length === 0) {
    throw new Error("No frames available for identification");
  }

  const content: any[] = [
    {
      type: "text",
      text:
        `CANDIDATE AREAS:\n\n${profileBlock}\n\n` +
        `The operator submitted ${validFrames.length} frame(s). Decide which candidate area is most likely depicted.`,
    },
  ];

  for (let i = 0; i < validFrames.length; i++) {
    const b64 = imageToBase64(validFrames[i]);
    content.push({ type: "text", text: `FRAME ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    max_completion_tokens: 1024,
    messages: [
      { role: "system", content: IDENTIFICATION_PROMPT },
      { role: "user", content },
    ],
  });

  const text = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(text);
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  const byId = new Map<number, IdentificationAreaProfile>();
  for (const p of profiles) byId.set(p.areaId, p);

  const seen = new Set<number>();
  const candidates: IdentificationCandidate[] = [];
  for (const c of rawCandidates) {
    const id = Number(c?.areaId);
    if (!Number.isInteger(id)) continue;
    const profile = byId.get(id);
    if (!profile || seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      areaId: id,
      areaName: profile.areaName,
      confidence: clampConfidence(c?.confidence),
    });
  }

  // Backfill any missing trained areas with confidence 0 so callers always get
  // a complete list (UI can still surface them in the "Change" picker).
  for (const p of profiles) {
    if (seen.has(p.areaId)) continue;
    candidates.push({ areaId: p.areaId, areaName: p.areaName, confidence: 0 });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const rationale = typeof parsed.rationale === "string" && parsed.rationale.trim()
    ? parsed.rationale.trim().slice(0, 280)
    : null;

  return { candidates, rationale };
}

async function identifyAreaImpl(input: IdentificationInput): Promise<IdentificationResult> {
  if (input.profiles.length === 0) {
    return { candidates: [], rationale: null };
  }

  const uploadsDir = path.resolve(process.cwd(), "uploads");
  const fullMediaPath = path.isAbsolute(input.mediaAbsPath)
    ? input.mediaAbsPath
    : path.join(uploadsDir, path.basename(input.mediaAbsPath));

  let framePaths: string[];
  if (input.mediaType === "video") {
    try {
      const kf = await extractKeyframes(fullMediaPath, { maxFrames: 4, intervalSec: 2 });
      framePaths = kf.frameAbsPaths;
      if (framePaths.length === 0) {
        throw new Error("No keyframes extracted");
      }
    } catch (err) {
      logger.error({ err }, "Identification keyframe extraction failed");
      throw err;
    }
  } else {
    framePaths = [fullMediaPath];
  }

  return callIdentificationVLM(framePaths, input.profiles);
}

// Mutable seam so tests can swap out the VLM-backed identifier with a
// deterministic stub. The route imports `identifyArea` (not `_impl`), so
// the wrapper below always dispatches through the current implementation.
type IdentifyAreaFn = (input: IdentificationInput) => Promise<IdentificationResult>;
let _impl: IdentifyAreaFn = identifyAreaImpl;

export function identifyArea(input: IdentificationInput): Promise<IdentificationResult> {
  return _impl(input);
}

/**
 * Test-only: replace the identifyArea implementation. Pass `null` to restore
 * the real VLM-backed implementation. Production callers must never use this.
 */
export function __setIdentifyAreaForTests(fn: IdentifyAreaFn | null): void {
  _impl = fn ?? identifyAreaImpl;
}

export { isVideoFile };
