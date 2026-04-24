import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractKeyframes, isVideoFile } from "./keyframes.js";

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

const FIVE_S_GMP_RUBRIC = `
You are a strict 5S + GMP auditor for a manufacturing facility. Score with rigor.

5S pillars (rate 0-5 each based on visible evidence):
- SORT (Seiri): only necessary items present; unneeded tools, scrap, personal items removed.
- SET IN ORDER (Seiton): everything has a designated, labeled place; tools at point-of-use; clear walk paths.
- SHINE (Seiso): surfaces, equipment, floors are clean; no spills, dust, swarf, debris; equipment inspected.
- STANDARDIZE (Seiketsu): visual standards visible (shadow boards, labels, color codes, posted procedures, schedules).
- SUSTAIN (Shitsuke): evidence of routine use — completed checklists, recent log entries, audit boards, PPE worn.

GMP principles to apply (cite when violated):
- HYGIENE: hand-wash stations stocked, PPE/hairnets/gloves used, no eating/drinking in production.
- CONTAMINATION CONTROL: separation of raw vs finished, no cross-contact, sealed containers, no exposed product.
- LABELING & TRACEABILITY: every container/lot labeled with id, date, status; no unlabeled chemicals.
- DOCUMENTATION: batch records, cleaning logs, calibration tags up to date and visible.
- EQUIPMENT CLEANLINESS: machines free of buildup, lubricant, residue; cleaning verified.

Score guide: 0=hazardous/chaotic, 1=very poor, 2=poor, 3=acceptable, 4=good, 5=excellent.
Be harsh: clutter, mess, missing labels, exposed product, unworn PPE, undated logs are all serious.

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

function emptyResult(reason: string): AIScoringResult {
  return {
    embeddingHash: "",
    aiTotalScore: 0,
    aiPillarsJson: { sort: 0, set: 0, shine: 0, standardize: 0, sustain: 0 },
    aiRecommendationsJson: [{ action: "Manual inspection required — AI scoring unavailable", why: reason, location: "general" }],
    aiIssuesJson: [{ issue: "AI scoring unavailable", evidence: reason, location: "general" }],
    failingPillars: [],
    modelVersion: "error",
    scoringMode: "FALLBACK",
    profile: { items: [], machines: [], layout: [], observedIssues: [], summary: "" },
  };
}

async function callVLM(
  framePaths: string[],
  areaName: string,
  machineTag: string | null | undefined,
  learnedProfile: ScoringInput["learnedProfile"]
): Promise<AIScoringResult> {
  const profileBlock = learnedProfile && learnedProfile.status === "TRAINED"
    ? `\nLEARNED AREA PROFILE (this area's own norm — score deviations from it as well):
- Summary: ${learnedProfile.summary ?? "(none)"}
- Typical items: ${learnedProfile.items.join(", ") || "(none)"}
- Known machines: ${learnedProfile.machines.join(", ") || "(none)"}
- Layout notes: ${learnedProfile.layout.join("; ") || "(none)"}
- Recurring issues to watch: ${learnedProfile.commonIssues.join("; ") || "(none)"}\n`
    : "\n(No trained profile yet for this area — score on universal 5S+GMP only.)\n";

  const machineLine = machineTag ? `\nThe operator tagged this capture as: "${machineTag}".` : "";

  const content: any[] = [
    {
      type: "text",
      text:
`Area: "${areaName}".${machineLine}\n${profileBlock}\nThe operator submitted ${framePaths.length} frame(s) from a walk-through. Audit the AREA AS A WHOLE across all frames.`,
    },
  ];

  for (let i = 0; i < framePaths.length; i++) {
    const p = framePaths[i];
    if (!fs.existsSync(p)) continue;
    const b64 = imageToBase64(p);
    content.push({ type: "text", text: `FRAME ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }

  const response = await openai.chat.completions.create({
    model: "gpt-5-mini",
    response_format: { type: "json_object" },
    max_completion_tokens: 2048,
    messages: [
      { role: "system", content: FIVE_S_GMP_RUBRIC },
      { role: "user", content },
    ],
  });

  const text = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(text);

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
    modelVersion: "gpt-5-mini-5sgmp-v2",
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
      const kf = await extractKeyframes(fullMediaPath, { maxFrames: 6, intervalSec: 2 });
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
    framePaths = [fullMediaPath];
    frameUrls = [];
  }

  try {
    const result = await callVLM(framePaths, input.areaName, input.machineTag, input.learnedProfile);
    return { ...result, keyframeUrls: frameUrls };
  } catch (err) {
    logger.error({ err }, "VLM scoring failed");
    const fb = emptyResult(err instanceof Error ? err.message : "VLM error");
    return { ...fb, keyframeUrls: frameUrls };
  }
}
