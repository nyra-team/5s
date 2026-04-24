import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractKeyframes, compressForVLM } from "./keyframes.js";

interface VLMIssue {
  issue: string;
  evidence: string;
  location: string;
  pillar?: string;
  principle?: string;
}

interface VLMRecommendation {
  action: string;
  why: string;
  location: string;
  principle?: string;
}

interface VLMPillarScores {
  sort: number;
  set: number;
  shine: number;
  standardize: number;
  sustain: number;
}

export interface VLMProfileExtract {
  items: string[];
  machines: string[];
  layout: string[];
  observedIssues: string[];
  summary: string;
}

export interface AIScoringResult {
  embeddingHash: string;
  aiTotalScore: number;
  aiPillarsJson: VLMPillarScores;
  aiRecommendationsJson: VLMRecommendation[];
  aiIssuesJson: VLMIssue[];
  failingPillars: string[];
  modelVersion: string;
  scoringMode: string;
  profile: VLMProfileExtract;
}

export interface ScoringInput {
  areaId: number;
  areaName: string;
  mediaAbsPath: string;
  mediaType: "image" | "video";
  machineTag?: string | null;
  /** Existing learned profile to ground the analysis against, if any */
  learnedProfile?: {
    status: "LEARNING" | "TRAINED";
    items: string[];
    machines: string[];
    layout: string[];
    commonIssues: string[];
    summary: string | null;
  } | null;
}

export interface ScoringOutput extends AIScoringResult {
  keyframeUrls: string[];
}

const MODEL_VERSION = "gpt-5-mini-5sgmp-v3";

const FIVE_S_GMP_RUBRIC = `
You are a strict 5S + GMP auditor for a manufacturing facility. Score with rigor and consistency: identical evidence must always produce the same score.

5S pillars (each rated 0–5):
- SORT (Seiri): only necessary items present.
- SET IN ORDER (Seiton): everything has a designated, labeled place; tools at point-of-use; clear walk paths.
- SHINE (Seiso): surfaces, equipment, floors are clean; no spills, dust, swarf, debris; equipment inspected.
- STANDARDIZE (Seiketsu): visual standards visible (shadow boards, labels, color codes, posted procedures, schedules).
- SUSTAIN (Shitsuke): evidence of routine use — completed checklists, recent log entries, audit boards, PPE worn.

PER-PILLAR SCORE ANCHORS — use these exact descriptions to pick the number:

SORT:
  0 = unsafe clutter; trash, scrap, or unauthorized personal items dominate the workspace.
  2 = noticeable unneeded items at the workstation but no immediate hazard.
  3 = a few non-essential items present; mostly only what is needed for the task.
  4 = workspace contains only items needed for the current task; minor optional items at most.
  5 = exclusively necessary items; obvious red-tagging or removal discipline is visible.

SET IN ORDER:
  0 = chaotic; tools and materials randomly placed; walk paths blocked.
  2 = some items have homes but many are placed wherever convenient; locations not labeled.
  3 = most items have a designated place; some labeling; walk paths usable but not clearly marked.
  4 = nearly all items at point-of-use with labeled locations; walk paths and zones marked.
  5 = every item has a labeled, color-coded home (shadow boards, outlined zones); flow is obvious.

SHINE:
  0 = grossly dirty; spills, leaks, debris, or contamination on equipment or floor.
  2 = visible dust, swarf, or stains on multiple surfaces; cleanliness clearly neglected.
  3 = generally clean but with some dust/residue; equipment is functional but not pristine.
  4 = clean surfaces and equipment; only minor wear or smudging.
  5 = spotless; equipment and floor look freshly cleaned; cleaning logs visible nearby.

STANDARDIZE:
  0 = no visual standards of any kind.
  2 = a single sign or label exists but most positions/procedures are undocumented.
  3 = some visual standards (a few labels, one posted procedure) but inconsistent application.
  4 = consistent labels, color codes, and posted standards across the area.
  5 = comprehensive visual management: shadow boards, color-coded zones, posted SOPs, schedules and recovery actions all visible.

SUSTAIN:
  0 = no evidence anyone follows 5S; PPE not worn; no logs.
  2 = audit board exists but is blank or out of date; PPE inconsistent.
  3 = some checklists/logs filled in but not current; PPE present on most workers.
  4 = recent (within shift) checklist or log entries; PPE worn correctly; audit board updated.
  5 = clear, current evidence of daily 5S routine: signed checklists, today's log entries, PPE 100%, recent audit results posted.

GMP principles to apply (cite when violated):
- HYGIENE: hand-wash stations stocked, PPE/hairnets/gloves used, no eating/drinking in production.
- CONTAMINATION CONTROL: separation of raw vs finished, no cross-contact, sealed containers, no exposed product.
- LABELING & TRACEABILITY: every container/lot labeled with id, date, status; no unlabeled chemicals.
- DOCUMENTATION: batch records, cleaning logs, calibration tags up to date and visible.
- EQUIPMENT CLEANLINESS: machines free of buildup, lubricant, residue; cleaning verified.

Scoring discipline:
- For EACH pillar, FIRST write a brief reasoning string under "reasoning" naming the specific evidence (frame numbers, locations) that drives the score. THEN choose the number. Do not commit to a number until the reasoning is written.
- Score by the worst observable evidence in that pillar — clutter, exposed product, missing labels, unworn PPE, undated logs are all serious.
- If evidence is unclear, lean toward the lower anchor.

For each ISSUE you cite, name the pillar (sort/set/shine/standardize/sustain) AND the 5S/GMP principle that it violates.
For each RECOMMENDATION, name the principle it restores.
Reference EVIDENCE by frame number (e.g. "frame 2: open container of powder, no lid") and a coarse location (left/right/top/bottom/center).

Also extract a structured PROFILE of what is visible in the area:
- items: recurring/notable items (e.g. "5L oil cans", "torque wrench set")
- machines: named pieces of equipment (e.g. "Mixer #2", "Conveyor A")
- layout: spatial notes (e.g. "tool board on rear wall", "PPE station near entrance")
- observedIssues: short phrases describing recurring conditions (e.g. "unlabeled chemical bottles")
- summary: one short paragraph describing the area as observed

Output ONLY valid JSON in this exact shape:
{
  "reasoning": {
    "sort": "evidence-based reasoning for the sort score",
    "set": "...",
    "shine": "...",
    "standardize": "...",
    "sustain": "..."
  },
  "pillar_scores": { "sort": 0-5, "set": 0-5, "shine": 0-5, "standardize": 0-5, "sustain": 0-5 },
  "issues": [{ "issue": "...", "evidence": "frame N: ...", "location": "left|right|top|bottom|center", "pillar": "sort|set|shine|standardize|sustain", "principle": "..." }],
  "recommendations": [{ "action": "...", "why": "...", "location": "...", "principle": "..." }],
  "profile": { "items": ["..."], "machines": ["..."], "layout": ["..."], "observedIssues": ["..."], "summary": "..." }
}
`.trim();

function imageToBase64(imagePath: string): string {
  const buf = fs.readFileSync(imagePath);
  return buf.toString("base64");
}

function clamp05(n: any): number {
  return Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
}

/**
 * Suggestion text written to `submissionsJson` when the VLM pipeline fails and
 * we have no real recommendations to surface. Exported so other modules can
 * recognise this no-op fallback and avoid showing it in places where only
 * actionable items belong (e.g. the operator's recent-audit action chips).
 */
export const AI_UNAVAILABLE_FALLBACK_ACTION =
  "Manual inspection required — AI scoring unavailable";

/**
 * Returns true when the suggestion is a known no-op fallback that the system
 * generates on its own (rather than a real, actionable recommendation). Used
 * to filter the inline action chips on the operator's recent-audits strip
 * without affecting the full detail dialog.
 */
export function isNoOpFallbackSuggestion(s: string): boolean {
  return s.trim() === AI_UNAVAILABLE_FALLBACK_ACTION;
}

function emptyResult(reason: string): AIScoringResult {
  return {
    embeddingHash: "",
    aiTotalScore: 0,
    aiPillarsJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
    aiRecommendationsJson: [{ action: AI_UNAVAILABLE_FALLBACK_ACTION, why: reason, location: "general" }],
    aiIssuesJson: [{ issue: "AI scoring unavailable", evidence: reason, location: "general" }],
    failingPillars: [],
    modelVersion: "error",
    scoringMode: "FALLBACK",
    profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "" },
  };
}

const PILLAR_KEYS = ["sort", "set", "shine", "standardize", "sustain"] as const;

/** Validate parsed VLM JSON against the contract. Returns null if valid, or
 *  a human-readable error string suitable for sending back to the model on
 *  retry. We only check the shape we actually rely on downstream. */
export function validateVlmJson(parsed: any): string | null {
  if (!parsed || typeof parsed !== "object") return "response is not a JSON object";
  const ps = parsed.pillar_scores;
  if (!ps || typeof ps !== "object") return "missing object 'pillar_scores'";
  for (const k of PILLAR_KEYS) {
    const v = (ps as any)[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return `pillar_scores.${k} must be a number 0-5 (got ${typeof v})`;
    }
    if (v < 0 || v > 5) return `pillar_scores.${k} must be between 0 and 5 (got ${v})`;
  }
  const reasoning = parsed.reasoning;
  if (!reasoning || typeof reasoning !== "object") return "missing object 'reasoning' with a string per pillar";
  for (const k of PILLAR_KEYS) {
    const v = (reasoning as any)[k];
    if (typeof v !== "string" || v.trim().length === 0) {
      return `reasoning.${k} must be a non-empty string explaining the score`;
    }
  }
  if (!Array.isArray(parsed.issues)) return "'issues' must be an array";
  if (!Array.isArray(parsed.recommendations)) return "'recommendations' must be an array";
  return null;
}

interface CallVlmOptions {
  framePaths: string[];
  areaName: string;
  machineTag: string | null | undefined;
  learnedProfile: ScoringInput["learnedProfile"];
}

async function callVLM(opts: CallVlmOptions): Promise<AIScoringResult> {
  const { framePaths, areaName, machineTag, learnedProfile } = opts;
  const profileBlock = learnedProfile && learnedProfile.status === "TRAINED"
    ? `\nLEARNED AREA PROFILE (this area's own norm — score deviations from it as well):
- Summary: ${learnedProfile.summary ?? "(none)"}
- Typical items: ${learnedProfile.items.join(", ") || "(none)"}
- Known machines: ${learnedProfile.machines.join(", ") || "(none)"}
- Layout notes: ${learnedProfile.layout.join("; ") || "(none)"}
- Recurring issues to watch: ${learnedProfile.commonIssues.join("; ") || "(none)"}\n`
    : "\n(No trained profile yet for this area — score on universal 5S+GMP only.)\n";

  const machineLine = machineTag ? `\nThe operator tagged this capture as: "${machineTag}".` : "";

  const userText =
`Area: "${areaName}".${machineLine}\n${profileBlock}\nThe operator submitted ${framePaths.length} frame(s) from a walk-through. Audit the AREA AS A WHOLE across all frames.`;

  const baseContent: any[] = [{ type: "text", text: userText }];

  for (let i = 0; i < framePaths.length; i++) {
    const p = framePaths[i];
    if (!fs.existsSync(p)) continue;
    const b64 = imageToBase64(p);
    baseContent.push({ type: "text", text: `FRAME ${i + 1}:` });
    baseContent.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }

  // Deterministic params keep identical submissions producing identical scores.
  // `seed` is best-effort: the proxy may ignore it for models that don't
  // support it, which is fine — temperature 0 alone gives strong determinism.
  const baseRequest = {
    model: "gpt-5-mini",
    response_format: { type: "json_object" as const },
    max_completion_tokens: 2048,
    temperature: 0,
    top_p: 1,
    seed: 5,
  };

  const messages: any[] = [
    { role: "system", content: FIVE_S_GMP_RUBRIC },
    { role: "user", content: baseContent },
  ];

  const firstResp = await openai.chat.completions.create({ ...baseRequest, messages });
  const firstText = firstResp.choices[0]?.message?.content || "{}";

  let parsed: any;
  let validationError: string | null;
  try {
    parsed = JSON.parse(firstText);
    validationError = validateVlmJson(parsed);
  } catch (err) {
    parsed = null;
    validationError = `response was not valid JSON: ${(err as Error).message}`;
  }

  // One automatic retry with a stricter prompt naming exactly what was wrong.
  // We keep the original user content/images so the model isn't asked to
  // re-imagine anything — only to re-emit valid JSON.
  if (validationError) {
    logger.warn({ validationError, modelVersion: MODEL_VERSION }, "VLM JSON validation failed; retrying once");
    const retryMessages: any[] = [
      ...messages,
      { role: "assistant", content: firstText },
      {
        role: "user",
        content:
`Your previous JSON failed validation: ${validationError}.

Re-emit the COMPLETE response as valid JSON in exactly the documented shape. The required fields are:
- "reasoning": { "sort": string, "set": string, "shine": string, "standardize": string, "sustain": string }
- "pillar_scores": { "sort": 0-5, "set": 0-5, "shine": 0-5, "standardize": 0-5, "sustain": 0-5 }
- "issues": array (may be empty)
- "recommendations": array (may be empty)
- "profile": object

Do not include any prose outside the JSON object.`,
      },
    ];

    const retryResp = await openai.chat.completions.create({ ...baseRequest, messages: retryMessages });
    const retryText = retryResp.choices[0]?.message?.content || "{}";
    try {
      parsed = JSON.parse(retryText);
      validationError = validateVlmJson(parsed);
    } catch (err) {
      validationError = `retry was not valid JSON: ${(err as Error).message}`;
    }
    if (validationError) {
      throw new Error(`VLM returned invalid JSON after one retry: ${validationError}`);
    }
  }

  const ps = parsed.pillar_scores || {};
  const pillars: VLMPillarScores = {
    sort: clamp05(ps.sort),
    set: clamp05(ps.set),
    shine: clamp05(ps.shine),
    standardize: clamp05(ps.standardize),
    sustain: clamp05(ps.sustain),
  };

  const issues: VLMIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues.slice(0, 8).map((i: any) => ({
        issue: String(i.issue ?? ""),
        evidence: String(i.evidence ?? ""),
        location: String(i.location ?? "general"),
        pillar: i.pillar ? String(i.pillar) : undefined,
        principle: i.principle ? String(i.principle) : undefined,
      }))
    : [];

  const recs: VLMRecommendation[] = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.slice(0, 8).map((r: any) => ({
        action: String(r.action ?? ""),
        why: String(r.why ?? ""),
        location: String(r.location ?? "general"),
        principle: r.principle ? String(r.principle) : undefined,
      }))
    : [];

  const profileRaw = parsed.profile || {};
  const profile: VLMProfileExtract = {
    items: Array.isArray(profileRaw.items) ? profileRaw.items.slice(0, 25).map(String) : [],
    machines: Array.isArray(profileRaw.machines) ? profileRaw.machines.slice(0, 15).map(String) : [],
    layout: Array.isArray(profileRaw.layout) ? profileRaw.layout.slice(0, 10).map(String) : [],
    observedIssues: Array.isArray(profileRaw.observedIssues) ? profileRaw.observedIssues.slice(0, 10).map(String) : [],
    summary: String(profileRaw.summary ?? ""),
  };

  const total = pillars.sort + pillars.set + pillars.shine + pillars.standardize + pillars.sustain;
  const failing = (Object.entries(pillars) as [string, number][])
    .filter(([, v]) => v < 3)
    .map(([k]) => k);

  return {
    embeddingHash: "",
    aiTotalScore: total,
    aiPillarsJson: pillars,
    aiRecommendationsJson: recs,
    aiIssuesJson: issues,
    failingPillars: failing,
    modelVersion: MODEL_VERSION,
    scoringMode: "VLM_RUBRIC",
    profile,
  };
}

export async function scoreSubmission(input: ScoringInput): Promise<ScoringOutput> {
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  const fullMediaPath = path.isAbsolute(input.mediaAbsPath)
    ? input.mediaAbsPath
    : path.join(uploadsDir, path.basename(input.mediaAbsPath));

  let framePaths: string[];
  let frameUrls: string[];

  if (input.mediaType === "video") {
    try {
      const kf = await extractKeyframes(fullMediaPath, { maxFrames: 6 });
      framePaths = kf.frameAbsPaths;
      frameUrls = kf.frameUrls;
      if (framePaths.length === 0) {
        // Fall back to the raw video file as a single still won't work; bail to fallback.
        const fb = emptyResult("No keyframes could be extracted from the video.");
        return { ...fb, keyframeUrls: [] };
      }
    } catch (err) {
      logger.error({ err }, "Keyframe extraction failed");
      const fb = emptyResult("Keyframe extraction failed.");
      return { ...fb, keyframeUrls: [] };
    }
  } else {
    // Image submissions: shrink + recompress before the VLM call so the
    // base64 payload stays small. We MUST NOT rewrite the original upload in
    // place — uploads can be PNG/HEIC/WebP and the file URL we hand back to
    // operators uses the original extension/MIME. Always write a sibling
    // `.vlm.jpg` derivative used solely for the VLM call and clean it up
    // afterwards.
    const ext = path.extname(fullMediaPath).toLowerCase();
    const isJpeg = ext === ".jpg" || ext === ".jpeg";
    let vlmDerivative: string | null = null;
    let vlmPath = fullMediaPath;
    try {
      if (isJpeg) {
        // Already a JPEG — safe to compress in place; the served URL stays valid.
        vlmPath = await compressForVLM(fullMediaPath);
      } else {
        vlmDerivative = fullMediaPath + ".vlm.jpg";
        vlmPath = await compressForVLM(fullMediaPath, vlmDerivative);
      }
    } catch (err) {
      logger.warn({ err }, "image compress failed; sending original");
    }
    framePaths = [vlmPath];
    frameUrls = [];

    try {
      const result = await callVLM({
        framePaths,
        areaName: input.areaName,
        machineTag: input.machineTag,
        learnedProfile: input.learnedProfile,
      });
      return { ...result, keyframeUrls: frameUrls };
    } catch (err) {
      logger.error({ err }, "VLM scoring failed");
      const fb = emptyResult(err instanceof Error ? err.message : "VLM error");
      return { ...fb, keyframeUrls: frameUrls };
    } finally {
      if (vlmDerivative && fs.existsSync(vlmDerivative)) {
        try { fs.unlinkSync(vlmDerivative); } catch { /* best-effort */ }
      }
    }
  }

  try {
    const result = await callVLM({
      framePaths,
      areaName: input.areaName,
      machineTag: input.machineTag,
      learnedProfile: input.learnedProfile,
    });
    return { ...result, keyframeUrls: frameUrls };
  } catch (err) {
    logger.error({ err }, "VLM scoring failed");
    const fb = emptyResult(err instanceof Error ? err.message : "VLM error");
    return { ...fb, keyframeUrls: frameUrls };
  }
}
