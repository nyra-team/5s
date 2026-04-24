import { openai } from "@workspace/integrations-openai-ai-server";
// Token-usage shape lifted off the actual openai client's response so we
// don't need to import the openai package directly (it lives behind
// @workspace/integrations-openai-ai-server). chat.completions.create returns
// a union including streaming responses; the non-streaming branch carries
// the typed `usage` field we accumulate across retry attempts.
type ChatCompletionUsage = NonNullable<
  Extract<
    Awaited<ReturnType<typeof openai.chat.completions.create>>,
    { usage?: unknown }
  >["usage"]
>;
import { logger } from "./logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractKeyframes,
  compressForVLM,
  areAllFramesTooDark,
  type KeyframeMetrics,
} from "./keyframes.js";
import { db, aiScoringMetricsTable, type EnvironmentType } from "@workspace/db";
import { loadEffectiveVlmModel } from "./ai-settings.js";

/**
 * Distinct, operator-actionable error codes raised when the scoring pipeline
 * cannot produce a result. These map 1:1 to the toast copy in
 * `artifacts/five-s/src/pages/operator.tsx → buildUploadErrorToast` so the
 * operator sees a hint they can act on (re-aim the camera, retry in a
 * minute, capture more light) instead of a generic "submission failed".
 *
 * The route handler in `submissions.ts` catches `ScoringError` and maps
 * `code` to the response body's `code` field; older clients that don't
 * recognise a new code fall back to the API's `hint` string.
 */
export type ScoringErrorCode =
  | "VIDEO_UNREADABLE"
  | "AI_RATE_LIMITED"
  | "AI_TIMEOUT"
  | "AI_MALFORMED"
  | "FRAMES_TOO_DARK";

export class ScoringError extends Error {
  readonly code: ScoringErrorCode;
  /**
   * Whether the operator should retry the same capture (true: transient
   * upstream issue) or fix the capture itself first (false: dark frames,
   * unreadable video, model wouldn't yield JSON).
   */
  readonly retryable: boolean;
  constructor(code: ScoringErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ScoringError";
    this.code = code;
    this.retryable = retryable;
  }
}

type Severity = "high" | "medium" | "low";

interface VLMIssue {
  issue: string;
  evidence: string;
  location: string;
  pillar?: string;
  principle?: string;
  severity?: Severity;
}

interface VLMRecommendation {
  action: string;
  why: string;
  location: string;
  principle?: string;
  severity?: Severity;
}

interface VLMPillarScores {
  sort: number;
  set: number;
  shine: number;
  standardize: number;
  sustain: number;
}

export interface VLMPillarReasoning {
  sort: string;
  set: string;
  shine: string;
  standardize: string;
  sustain: string;
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
  aiReasoningJson: VLMPillarReasoning | null;
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
  /** What kind of physical setting this area is. Selects the rubric. */
  environmentType?: EnvironmentType;
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
  /**
   * Per-step timings + counts for the keyframe pipeline. Only populated for
   * video submissions (image submissions skip keyframe extraction). Surfaced
   * here so callers (e.g. the submissions route) can attach the metrics to
   * the response or persist them alongside the audit record without having
   * to plumb a second return value through.
   */
  keyframeMetrics?: KeyframeMetrics;
  /**
   * Wall-clock duration of the VLM call (including the optional one-shot
   * retry on JSON-validation failure). Recorded for both image and video
   * submissions so operators can compare ffmpeg/dedup time against the
   * model's own latency. `null` when the call threw before producing a
   * response (the fallback `emptyResult` path).
   */
  vlmMs: number | null;
}

const FACTORY_RUBRIC = `
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
`.trim();

const WAREHOUSE_RUBRIC = `
You are a strict 5S auditor for a WAREHOUSE / distribution centre. Score with rigor.

5S pillars (rate 0-5 each based on visible evidence):
- SORT (Seiri): only inventory and equipment that belongs is present; no orphan pallets, broken packaging, abandoned dunnage or personal items.
- SET IN ORDER (Seiton): racking is laid out logically; bin locations and pick labels are clear; aisles unobstructed; floor markings define pedestrian/forklift lanes; pallets squared on bays.
- SHINE (Seiso): floors swept, no spills, no broken pallets/shrink-wrap on the ground; racking and MHE (forklifts, pallet jacks) clean and undamaged.
- STANDARDIZE (Seiketsu): visual standards (rack labels, location codes, weight limits, fire-exit signage, lane lines, slot markings) are present and consistent.
- SUSTAIN (Shitsuke): evidence of routine — completed cycle counts, daily MHE checks, sign-offs on inspection sheets, hi-vis worn.

WAREHOUSE-specific principles to apply (cite when violated):
- AISLE CLEARANCE: pick aisles and forklift paths free of obstructions; no goods stacked in cross-aisles.
- RACKING SAFETY: no overhanging loads, no damaged uprights/beams, weight rating respected, pallets fully on beams.
- LABELLING & SLOTTING: every bay/level has a location code; SKUs in the right slot; pick labels readable.
- FLOOR MARKING: yellow/red taped lanes, hazard zones, and pedestrian crossings clearly defined.
- FIRE & EXIT: extinguishers and exit doors unblocked, signage visible from the aisle.

Do NOT cite food-GMP principles (no hairnets, no batch records, no calibration tags) — they don't apply here.

Scoring discipline:
- For EACH pillar, FIRST write a brief reasoning string under "reasoning" naming the specific evidence (frame numbers, locations) that drives the score. THEN choose the number. Do not commit to a number until the reasoning is written.
- Score by the worst observable evidence in that pillar — blocked aisles, damaged racking, unlabeled bays, unworn hi-vis are all serious.
- If evidence is unclear, lean toward the lower anchor.
`.trim();

const CORPORATE_OFFICE_RUBRIC = `
You are a strict 5S auditor for a CORPORATE OFFICE workspace (open-plan desks, private offices, meeting rooms, shared kitchens/break areas, copy/print zones, storage rooms). Be professional and respectful — score on what is visibly observable, not on personal judgement.

5S pillars (rate 0-5 each based on visible evidence):
- SORT (Seiri): only items that belong on a working desk are present; no stacks of stale paperwork, dead binders, abandoned mugs, unclaimed personal items, or duplicates piling up.
- SET IN ORDER (Seiton): every desk has a logical layout (monitor, keyboard, inbox tray, stationery cup); meeting rooms reset for the next user (chairs in, whiteboard wiped, markers replaced); shared storage labelled.
- SHINE (Seiso): desks, monitors, keyboards, and shared surfaces (kitchen counters, meeting tables) are clean; no spills, food crumbs, dust, smudged screens, overflowing bins.
- STANDARDIZE (Seiketsu): visible standards — labelled inbox/outbox trays, drawer labels, file/folder naming on shelves, room signage, kitchen cupboard labels, "clear desk" signage on shared/hot-desks.
- SUSTAIN (Shitsuke): evidence the system is upheld — clear-desk policy honoured at end of day, meeting rooms reliably reset, shared kitchen kept tidy, recycling correctly sorted.

CORPORATE-OFFICE-specific principles to cite when violated:
- DESK ORGANISATION: monitor/keyboard/mouse positioned cleanly, cables not draped across the desk, personal items contained to a small footprint, no eating debris on the work surface.
- DOCUMENT CONTROL: no loose papers stacked on desks or filing cabinets; every binder/folder has a spine label; confidential documents are not left out in the open; paper trays are labelled (e.g. "to file", "to shred").
- CABLE MANAGEMENT: monitor/laptop/charger cables routed cleanly (under-desk tray, velcro ties, cable spine); no tangled "cable nests" on or under the desk; no power strips dangling from the desk.
- MEETING ROOM READINESS: chairs pushed in, table free of cups/notes/leftover handouts, whiteboard wiped clean, markers/erasers in their tray, AV cables coiled and stowed, room booking display clear.
- SHARED AMENITIES (kitchen / break room): no dishes piled in the sink, fridge free of expired items / unlabelled containers, coffee station wiped down, milk/condiments returned to the fridge, bins not overflowing and recycling correctly separated.
- STORAGE & STATIONERY: shared supply cupboards organised with labelled bins/shelves; no random boxes stacked on the floor; archive boxes labelled with contents and date.
- WORKSPACE STANDARDISATION: hot desks visibly cleared at the end of the day; shared resources (printers, monitors, dock stations) returned to a known default state.

Do NOT use industrial language. Do NOT mention PPE, hairnets, gloves, GMP, batch records, calibration tags, forklifts, racking, shadow boards, or production-line equipment — none of these apply to an office.

When citing issues and recommendations, name SPECIFIC visible objects and locations (e.g. "the stack of papers on the left desk in frame 2 — file or shred within 24 hours", "tangled cables under the desk in frame 3 — route with velcro ties under the desk"). Recommendations must be concrete office-appropriate actions someone can do today (e.g. "add a labelled inbox tray for incoming mail", "use velcro ties to bundle the monitor and laptop cables under the desk", "wipe down the meeting-room whiteboard and reset the marker tray after each session").

Scoring discipline:
- For EACH pillar, FIRST write a brief reasoning string under "reasoning" naming the specific evidence (frame numbers, locations) that drives the score. THEN choose the number. Do not commit to a number until the reasoning is written.
- Score by the worst observable evidence in that pillar — paper piles, tangled cables, unreset meeting rooms, dirty kitchens are all serious.
- If evidence is unclear, lean toward the lower anchor.
`.trim();

const HOME_RUBRIC = `
You are a friendly home-organisation coach. Apply a LIGHTWEIGHT 5S to a domestic space (kitchen, garage, study, bedroom, etc.). Be encouraging but honest.

5S pillars (rate 0-5 each based on visible evidence):
- SORT: only items that belong in this space are present; obvious clutter, expired items, duplicates, or things "dumped" here are flagged.
- SET IN ORDER: items have a sensible home; like-with-like; frequently used things within reach; clear surfaces.
- SHINE: surfaces, floors, and visible appliances are clean; no spills, dust bunnies, sticky marks, dishes piled up.
- STANDARDIZE: simple visual cues — labels on jars/boxes/drawers, hooks for keys, baskets for categories, a place for the bin.
- SUSTAIN: signs the system is being kept up — recently tidied, no half-finished projects left out, surfaces stay clear.

Domestic principles to apply (cite when violated):
- CLUTTER: piles of paper, mail, unworn clothes, random small items on surfaces.
- STORAGE: open shelves jammed, drawers overflowing, things stacked precariously.
- CLEANING: visible dirt, dishes, laundry, dust, spills, full bins.
- LABELLING: containers without labels, mystery jars, unlabelled boxes.
- SAFETY AT HOME: trip hazards, blocked exits, exposed wires, items stored above eye level that could fall.

Do NOT use industrial language. Do NOT mention PPE, hairnets, GMP, batch records, calibration, forklifts, racking, or shadow boards. Speak like a helpful friend, not an auditor.

Scoring discipline:
- For EACH pillar, FIRST write a brief reasoning string under "reasoning" naming the specific evidence (frame numbers, locations) that drives the score. THEN choose the number. Do not commit to a number until the reasoning is written.
- Score by the worst observable evidence in that pillar — piles, dirty surfaces, blocked walkways are all serious.
- If evidence is unclear, lean toward the lower anchor.
`.trim();

const COMMON_INSTRUCTIONS = `
For each ISSUE you cite:
- Name the pillar (sort/set/shine/standardize/sustain) AND the principle that it violates.
- Reference EVIDENCE by frame number AND describe the specific object you saw (e.g. "frame 2: red toolbox on the workbench, no shadow outline beneath it") plus a coarse location (left/right/top/bottom/center).
- Assign a severity: "high" (safety / immediate action), "medium" (clear standard violation), or "low" (minor / cosmetic).

For each RECOMMENDATION:
- Give a concrete, actionable "how to fix it" step that someone could do today without specialist training (e.g. "buy 25mm yellow vinyl tape and outline the toolbox on the bench" rather than "improve organisation").
- Name the principle the action restores.
- Reuse the same severity as the matching issue.

PRIORITISE the top 3 most severe issues. List up to 3 issues and up to 3 matching recommendations — quality over quantity.

Also extract a structured PROFILE of what is visible in the area:
- items: recurring/notable items (use plain words appropriate to the environment)
- machines: named pieces of equipment / appliances visible (e.g. "Mixer #2", "Conveyor A", or for Home: "kettle", "washing machine")
- layout: spatial notes (e.g. "tool board on rear wall", "fridge to the left of the sink")
- observedIssues: short phrases describing recurring conditions (e.g. "unlabeled jars", "pallets stacked above safe height")
- summary: one short paragraph describing the area as observed, written in the appropriate register for the environment

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
  "issues": [{ "issue": "...", "evidence": "frame N: ...", "location": "left|right|top|bottom|center", "pillar": "sort|set|shine|standardize|sustain", "principle": "...", "severity": "high|medium|low" }],
  "recommendations": [{ "action": "...", "why": "...", "location": "...", "principle": "...", "severity": "high|medium|low" }],
  "profile": { "items": ["..."], "machines": ["..."], "layout": ["..."], "observedIssues": ["..."], "summary": "..." }
}
`.trim();

export function getRubric(environmentType: EnvironmentType | undefined): string {
  const env = environmentType ?? "factory";
  const base =
    env === "warehouse" ? WAREHOUSE_RUBRIC :
    env === "home" ? HOME_RUBRIC :
    env === "corporate_office" ? CORPORATE_OFFICE_RUBRIC :
    FACTORY_RUBRIC;
  return `${base}\n\n${COMMON_INSTRUCTIONS}`;
}

export function getEnvironmentLabel(environmentType: EnvironmentType | undefined): string {
  const env = environmentType ?? "factory";
  if (env === "warehouse") return "warehouse / distribution centre";
  if (env === "home") return "domestic / home space";
  if (env === "corporate_office") return "corporate office workspace";
  return "manufacturing facility";
}

function imageToBase64(imagePath: string): string {
  const buf = fs.readFileSync(imagePath);
  return buf.toString("base64");
}

function clamp05(n: any): number {
  return Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
}

function normalizeSeverity(s: any): Severity | undefined {
  if (typeof s !== "string") return undefined;
  const v = s.toLowerCase();
  return v === "high" || v === "medium" || v === "low" ? v : undefined;
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
    aiReasoningJson: null,
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
  environmentType: EnvironmentType | undefined;
}

// Cap on the validation message we persist so a verbose model error can't
// bloat a row. Aggregates only need the boolean retried flag — the message
// is kept for engineering spelunking, not for display.
const VALIDATION_ERROR_MAX = 500;

interface ScoringMetricExtras {
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/**
 * Final state of a single callVLM() invocation. Persisted on the
 * ai_scoring_metrics row so the dashboard / on-call can group failures by
 * cause without joining against the audit log.
 *
 * - "success": JSON validated cleanly (possibly after JSON-shape retries).
 * - "malformed": JSON-validation retries exhausted; ScoringError thrown.
 * - "rate_limited": OpenAI 429 surfaced after transient retries exhausted.
 * - "timeout": per-attempt AbortController timeout fired and transient
 *              retries exhausted, OR the SDK reported a request timeout.
 * - "transient_failure": connection error / 5xx persisted past all
 *              transient retries (and wasn't a clear rate-limit/timeout).
 */
type ScoringOutcome =
  | "success"
  | "malformed"
  | "rate_limited"
  | "timeout"
  | "transient_failure";

interface ScoringMetricRecord {
  modelVersion: string;
  retried: boolean;
  validationError: string | null;
  jsonAttempts: number;
  transientAttempts: number;
  outcome: ScoringOutcome;
  elapsedMs: number;
  // Cost / latency fields (Task #166). Summed across every chat.completions
  // attempt the call made (transient retries + JSON-validation retries).
  // Nullable when the proxy didn't surface usage / when the call threw
  // before the first response landed.
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/**
 * Append one row to `ai_scoring_metrics` describing the outcome of a VLM
 * call. Logging the metric is best-effort: a DB hiccup must never break
 * scoring, so we swallow errors and emit a warning instead.
 *
 * The row carries both the reliability counters (jsonAttempts /
 * transientAttempts / outcome from Task #203) and the cost/latency figures
 * (latencyMs / *Tokens from Task #166) so the dashboard can group both
 * "did this call cost us extra retries" and "what did this call cost in
 * tokens/time" by `modelVersion` against the same denominator.
 */
async function recordScoringMetric(rec: ScoringMetricRecord): Promise<void> {
  try {
    await db.insert(aiScoringMetricsTable).values({
      modelVersion: rec.modelVersion,
      retried: rec.retried,
      validationError: rec.validationError
        ? rec.validationError.slice(0, VALIDATION_ERROR_MAX)
        : null,
      jsonAttempts: rec.jsonAttempts,
      transientAttempts: rec.transientAttempts,
      outcome: rec.outcome,
      elapsedMs: rec.elapsedMs,
      callKind: "scoring",
      latencyMs: rec.latencyMs,
      promptTokens: rec.promptTokens,
      completionTokens: rec.completionTokens,
      totalTokens: rec.totalTokens,
    });
  } catch (err) {
    logger.warn({ err }, "failed to record AI scoring metric");
  }
}

/**
 * Maximum number of JSON-validation attempts. Each attempt is a fresh
 * round-trip whose response is parsed and validated against the schema; on
 * failure the prior turns are appended to the message history (with the
 * skeleton spelled out) and the next attempt runs. After this many shots
 * we give up and surface AI_MALFORMED to the operator.
 */
const MAX_JSON_ATTEMPTS = 3;

/**
 * Maximum number of *transient-error* retries per single API call (counted
 * separately from JSON-validation retries). A 429, 5xx, network error, or
 * per-attempt timeout triggers a backoff retry up to this many times.
 *
 * Total upper bound on calls per scoring is roughly
 * MAX_JSON_ATTEMPTS * (1 + MAX_TRANSIENT_RETRIES); paired with the
 * per-attempt timeout below it caps worst-case latency.
 */
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Backoff schedule (ms) between transient retries. Indexed by retry attempt
 * number — the first retry sleeps TRANSIENT_BACKOFF_MS[0], etc. Picked to
 * match the task spec (1s/2s/4s) while staying inside the per-attempt
 * timeout so a slow recovery doesn't compound.
 */
const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * Per-attempt wall-clock budget for a single OpenAI request. We pass an
 * AbortSignal as the second arg to `chat.completions.create` so this stays
 * out of the request body (the gpt-5 EXPECTED_REQUEST_KEYS allowlist is
 * locked by the vlm-request unit test).
 *
 * Override via `VLM_TIMEOUT_MS` for environments with chronically slow
 * upstream paths.
 */
function getVlmTimeoutMs(): number {
  const raw = Number(process.env.VLM_TIMEOUT_MS);
  // Tightened from 40s → 20s per attempt. Combined with MAX_TRANSIENT_RETRIES=3
  // and the overall VLM deadline below, this caps the worst-case time we
  // can spend on a single VLM call (across all transient retries) at well
  // under 90s, so a hung upstream surfaces as AI_TIMEOUT to the operator
  // quickly rather than wedging a request.
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

/**
 * Hard ceiling on total wall-clock for the transient-retry loop in
 * `callOpenAIWithTransientRetries`, including backoff sleeps. If exceeded
 * we stop retrying and surface AI_TIMEOUT — better to give the operator a
 * fast failure they can re-shoot than to keep the request open while we
 * chain attempts past the latency budget.
 *
 * Override via `VLM_OVERALL_DEADLINE_MS`.
 */
function getVlmOverallDeadlineMs(): number {
  const raw = Number(process.env.VLM_OVERALL_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
}

// We deliberately classify OpenAI SDK errors by structural duck-typing
// (name + status) rather than `instanceof RateLimitError` etc. The api-server
// package doesn't directly depend on `openai` — it goes through the
// `@workspace/integrations-openai-ai-server` re-export — so importing the
// SDK's error classes here would be a brittle cross-package coupling.
// The shape we read (.name, .status) is part of the SDK's public contract.
function readStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}
function readName(err: unknown): string | undefined {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : undefined;
}

function isRateLimitError(err: unknown): boolean {
  if (readName(err) === "RateLimitError") return true;
  if (readStatus(err) === 429) return true;
  return false;
}

function isServerError(err: unknown): boolean {
  const status = readStatus(err);
  return typeof status === "number" && status >= 500 && status < 600;
}

function isConnectionError(err: unknown): boolean {
  const name = readName(err);
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return true;
  // Node's fetch sometimes surfaces a generic TypeError("fetch failed") when
  // the socket dies mid-request. Match by name + message so we don't depend
  // on a specific node-fetch internal.
  if (name === "TypeError" || name === "FetchError") {
    const msg = (err as { message?: unknown } | null)?.message;
    if (typeof msg === "string" && /fetch|network|ECONN|socket/i.test(msg)) {
      return true;
    }
  }
  return false;
}

function isAbortError(err: unknown): boolean {
  const name = readName(err);
  return name === "AbortError" || name === "APIUserAbortError" || name === "TimeoutError";
}

/**
 * Sleep with `unref()` so a pending backoff doesn't hold the event loop
 * open if the worker is being torn down. Kept inline so the retry loop is
 * self-contained.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Issue one OpenAI request with transient-error backoff and a per-attempt
 * AbortController timeout. Returns the response and the number of attempts
 * actually made (1 = first try succeeded; 4 = exhausted MAX_TRANSIENT_RETRIES).
 *
 * Throws `ScoringError("AI_RATE_LIMITED" | "AI_TIMEOUT" | …)` when retries
 * exhaust without a successful response. Permanent errors (4xx other than
 * 429, JSON-shape errors raised by us, etc) bubble up unchanged so the
 * caller can decide whether to fail-fast or wrap them differently.
 */
async function callOpenAIWithTransientRetries(
  body: Record<string, unknown>,
  opts: { timeoutMs: number; counter?: { attempts: number }; overallDeadlineMs?: number },
): Promise<{ resp: any; attempts: number; firstError: unknown | null }> {
  let lastErr: unknown = null;
  let firstError: unknown = null;
  const overallDeadlineMs = opts.overallDeadlineMs ?? getVlmOverallDeadlineMs();
  const startedAt = Date.now();
  // External counter lets the caller observe attempt count even when this
  // function throws (otherwise the metric row would record 0 transient
  // attempts on a rate-limit/timeout failure, masking the very upstream
  // instability the dashboard should surface).
  if (opts.counter) opts.counter.attempts = 0;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    if (opts.counter) opts.counter.attempts = attempt + 1;
    // Per-attempt deadline: shrink the AbortController timeout so an
    // attempt can never push us past the overall deadline. If we've
    // already exceeded the deadline, don't even start a new request.
    const remaining = overallDeadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      // Synthesize a TimeoutError so the classification below funnels into
      // AI_TIMEOUT rather than a generic transient_failure.
      lastErr = Object.assign(new Error("VLM overall deadline exceeded before next attempt"), { name: "TimeoutError" });
      break;
    }
    const perAttemptTimeoutMs = Math.min(opts.timeoutMs, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perAttemptTimeoutMs);
    timer.unref?.();
    try {
      const resp = await openai.chat.completions.create(body as any, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { resp, attempts: attempt + 1, firstError };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (firstError === null) firstError = err;
      const aborted = controller.signal.aborted;
      const transient =
        aborted ||
        isAbortError(err) ||
        isRateLimitError(err) ||
        isServerError(err) ||
        isConnectionError(err);
      if (!transient) {
        // Permanent error (e.g. 400 bad request from us). Don't retry —
        // bubble up so the caller's catch sees the real reason.
        throw err;
      }
      if (attempt >= MAX_TRANSIENT_RETRIES) break;
      const backoff = TRANSIENT_BACKOFF_MS[Math.min(attempt, TRANSIENT_BACKOFF_MS.length - 1)];
      // Don't sleep past the overall deadline either — bail straight into
      // the structured AI_TIMEOUT rather than burning the budget on a
      // backoff we can't honor.
      if (Date.now() - startedAt + backoff >= overallDeadlineMs) {
        logger.warn(
          { attempt: attempt + 1, elapsedMs: Date.now() - startedAt, overallDeadlineMs },
          "VLM overall deadline reached during backoff; giving up",
        );
        break;
      }
      logger.warn(
        {
          attempt: attempt + 1,
          backoffMs: backoff,
          aborted,
          errName: readName(err),
          errStatus: readStatus(err),
        },
        "VLM transient error; backing off and retrying",
      );
      await sleep(backoff);
    }
  }
  // Out of retries — classify and rethrow as a structured ScoringError.
  if (isRateLimitError(lastErr)) {
    throw new ScoringError(
      "AI_RATE_LIMITED",
      `OpenAI rate-limited after ${MAX_TRANSIENT_RETRIES + 1} attempts`,
      true,
    );
  }
  // AbortError from our timeout, or a generic timeout reported by the SDK.
  if (isAbortError(lastErr)) {
    throw new ScoringError(
      "AI_TIMEOUT",
      `VLM call timed out after ${MAX_TRANSIENT_RETRIES + 1} attempts (${opts.timeoutMs}ms each)`,
      true,
    );
  }
  // Connection / 5xx persisted — also user-recoverable on retry.
  throw new ScoringError(
    "AI_TIMEOUT",
    `VLM upstream failure persisted after ${MAX_TRANSIENT_RETRIES + 1} attempts: ${(lastErr as Error)?.message ?? "unknown error"}`,
    true,
  );
}

export async function callVLM(opts: CallVlmOptions): Promise<AIScoringResult> {
  const { framePaths, areaName, machineTag, learnedProfile, environmentType } = opts;
  // Resolve per call (Task #167) so admin toggles take effect on the next
  // request. modelVersion embeds the live id so post-rollback dashboards
  // stay correct.
  const model = await loadEffectiveVlmModel();
  const modelVersion = `${model}-${environmentType ?? "factory"}-v1`;

  const profileBlock = learnedProfile && learnedProfile.status === "TRAINED"
    ? `\nLEARNED AREA PROFILE (this area's own norm — score deviations from it as well):
- Summary: ${learnedProfile.summary ?? "(none)"}
- Typical items: ${learnedProfile.items.join(", ") || "(none)"}
- Known machines: ${learnedProfile.machines.join(", ") || "(none)"}
- Layout notes: ${learnedProfile.layout.join("; ") || "(none)"}
- Recurring issues to watch: ${learnedProfile.commonIssues.join("; ") || "(none)"}\n`
    : "\n(No trained profile yet for this area — score on the rubric only.)\n";

  const machineLine = machineTag ? `\nThe operator tagged this capture as: "${machineTag}".` : "";
  const envLabel = getEnvironmentLabel(environmentType);

  const userText =
`Area: "${areaName}".\nEnvironment: ${envLabel}.${machineLine}\n${profileBlock}\nThe operator submitted ${framePaths.length} frame(s) from a walk-through. Audit the AREA AS A WHOLE across all frames. Ground EVERY observation in something you can actually see in a specific frame — never invent details.`;

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
  // support it. The gpt-5 family (including gpt-5-mini) only accepts the
  // default temperature (1), so we omit the parameter entirely rather than
  // sending an unsupported value.
  //
  // `max_completion_tokens` must be large enough to cover the model's hidden
  // reasoning tokens AND the structured JSON output. The gpt-5 family spends
  // 1.5k–2k tokens on reasoning before emitting any visible content for this
  // rubric, so a 2048 cap was being fully consumed by reasoning, leaving zero
  // tokens for the actual response (finish_reason="length", empty content,
  // validation failure on "missing object 'pillar_scores'"). 8192 leaves
  // ~6k tokens of headroom for the full reasoning + 5 per-pillar reasonings
  // + up to 8 issues + 8 recommendations + the profile block, with margin
  // for complex scenes that need extra reasoning. gpt-5-mini reasons less
  // than flagship gpt-5, so the headroom is comfortable. (Task #124.)
  const baseRequest = {
    model,
    response_format: { type: "json_object" as const },
    max_completion_tokens: 8192,
    top_p: 1,
    seed: 5,
  };

  const messages: any[] = [
    { role: "system", content: getRubric(environmentType) },
    { role: "user", content: baseContent },
  ];

  // Skeleton appended to every corrective turn so the model has the exact
  // shape in front of it — repeating it is cheap and avoids the model
  // re-inventing keys between attempts. Kept verbatim from the
  // single-shot retry copy that shipped originally so a future reader can
  // diff the two cleanly.
  const JSON_SKELETON = `Re-emit the COMPLETE response as valid JSON in exactly this shape (no prose outside the JSON object):
{
  "reasoning": { "sort": string, "set": string, "shine": string, "standardize": string, "sustain": string },
  "pillar_scores": { "sort": 0-5, "set": 0-5, "shine": 0-5, "standardize": 0-5, "sustain": 0-5 },
  "issues": [...],
  "recommendations": [...],
  "profile": { "items": [...], "machines": [...], "layout": [...], "observedIssues": [...], "summary": "..." }
}`;

  const startedAt = Date.now();
  const timeoutMs = getVlmTimeoutMs();

  let parsed: any = null;
  let validationError: string | null = null;
  // First validation error we observed; mirrors the dashboard's prior
  // semantics ("retried" + the original failure message).
  let firstValidationError: string | null = null;
  let jsonAttempts = 0;
  let transientAttemptsTotal = 0;
  let outcome: ScoringOutcome = "success";

  // Cost / latency accumulators (Task #166). `latencyMs` here is the
  // time the model proxy held our chat.completions requests, summed across
  // every transient + JSON-retry attempt. The token totals come from the
  // proxy's `response.usage`; we guard with Number.isFinite so a missing
  // field becomes "we don't know" instead of poisoning the running totals
  // with NaN.
  let latencyMs = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  const accumulateUsage = (usage: ChatCompletionUsage | undefined): void => {
    if (!usage) return;
    const p = Number(usage.prompt_tokens);
    const c = Number(usage.completion_tokens);
    const t = Number(usage.total_tokens);
    if (Number.isFinite(p)) promptTokens = (promptTokens ?? 0) + p;
    if (Number.isFinite(c)) completionTokens = (completionTokens ?? 0) + c;
    if (Number.isFinite(t)) totalTokens = (totalTokens ?? 0) + t;
  };

  try {
    for (let i = 0; i < MAX_JSON_ATTEMPTS; i++) {
      jsonAttempts++;
      // External counter so we can charge transient attempts to the metric
      // row even when the helper throws (rate-limit/timeout exhaustion).
      const counter = { attempts: 0 };
      let resp: any;
      const tCall = Date.now();
      try {
        // Clone `messages` per call so each captured request body keeps its
        // own snapshot of the conversation. Without this, the JSON-retry
        // path would mutate the array reference held by previous mock
        // .calls[i] entries — a subtle source of confusion for tests
        // that inspect prior payloads after a retry.
        ({ resp } = await callOpenAIWithTransientRetries(
          { ...baseRequest, messages: [...messages] },
          { timeoutMs, counter },
        ));
      } finally {
        transientAttemptsTotal += counter.attempts;
        // Charge wall-clock for this JSON attempt to the latency total
        // even when the transient helper threw — a request we sent and
        // waited on still cost time, and the dashboard panel is most
        // useful when failures show up in latency too.
        latencyMs += Date.now() - tCall;
      }
      accumulateUsage(resp?.usage);
      const text = resp.choices[0]?.message?.content || "{}";

      try {
        parsed = JSON.parse(text);
        validationError = validateVlmJson(parsed);
      } catch (err) {
        parsed = null;
        validationError = `response was not valid JSON: ${(err as Error).message}`;
      }

      if (i === 0) firstValidationError = validationError;
      if (!validationError) break;

      logger.warn(
        { validationError, attempt: i + 1, modelVersion },
        "VLM JSON validation failed; will retry",
      );

      // Append a corrective turn that names exactly what was wrong AND
      // includes the full skeleton so each subsequent attempt has the
      // contract in front of it (some models drop fields after several
      // turns when only the prior assistant reply is visible).
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: `Your previous JSON failed validation: ${validationError}.\n\n${JSON_SKELETON}`,
      });
    }

    if (validationError) {
      outcome = "malformed";
      throw new ScoringError(
        "AI_MALFORMED",
        `VLM returned invalid JSON after ${MAX_JSON_ATTEMPTS} attempts: ${validationError}`,
        false,
      );
    }
  } catch (err) {
    if (err instanceof ScoringError) {
      // Outcome was set above (malformed) or by the transient helper —
      // map by code so the metric row reflects the operator-visible bucket.
      if (outcome === "success") {
        outcome =
          err.code === "AI_RATE_LIMITED" ? "rate_limited" :
          err.code === "AI_TIMEOUT" ? "timeout" :
          err.code === "AI_MALFORMED" ? "malformed" :
          "transient_failure";
      }
    } else {
      outcome = "transient_failure";
    }
    throw err;
  } finally {
    const elapsedMs = Date.now() - startedAt;
    // One row per callVLM, regardless of success/failure path — keeps the
    // dashboard's denominator honest during the exact upstream instability
    // we want it to surface.
    await recordScoringMetric({
      modelVersion,
      retried: jsonAttempts > 1 || transientAttemptsTotal > 1,
      validationError: firstValidationError,
      jsonAttempts,
      transientAttempts: transientAttemptsTotal,
      outcome,
      elapsedMs,
      latencyMs: latencyMs > 0 ? latencyMs : null,
      promptTokens,
      completionTokens,
      totalTokens,
    });
  }

  const ps = parsed.pillar_scores || {};
  const pillars: VLMPillarScores = {
    sort: clamp05(ps.sort),
    set: clamp05(ps.set),
    shine: clamp05(ps.shine),
    standardize: clamp05(ps.standardize),
    sustain: clamp05(ps.sustain),
  };

  // Per-pillar reasoning is required by validateVlmJson, so by the time we get
  // here every key is a non-empty string. Trim and cap to a sane length so a
  // verbose model response can't blow out the JSONB column or the operator UI.
  const REASONING_MAX = 600;
  const r = parsed.reasoning || {};
  const reasoning: VLMPillarReasoning = {
    sort: String(r.sort ?? "").trim().slice(0, REASONING_MAX),
    set: String(r.set ?? "").trim().slice(0, REASONING_MAX),
    shine: String(r.shine ?? "").trim().slice(0, REASONING_MAX),
    standardize: String(r.standardize ?? "").trim().slice(0, REASONING_MAX),
    sustain: String(r.sustain ?? "").trim().slice(0, REASONING_MAX),
  };

  const issues: VLMIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues.slice(0, 8).map((i: any) => ({
        issue: String(i.issue ?? ""),
        evidence: String(i.evidence ?? ""),
        location: String(i.location ?? "general"),
        pillar: i.pillar ? String(i.pillar) : undefined,
        principle: i.principle ? String(i.principle) : undefined,
        severity: normalizeSeverity(i.severity),
      }))
    : [];

  const recs: VLMRecommendation[] = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.slice(0, 8).map((r: any) => ({
        action: String(r.action ?? ""),
        why: String(r.why ?? ""),
        location: String(r.location ?? "general"),
        principle: r.principle ? String(r.principle) : undefined,
        severity: normalizeSeverity(r.severity),
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
    aiReasoningJson: reasoning,
    aiRecommendationsJson: recs,
    aiIssuesJson: issues,
    failingPillars: failing,
    modelVersion,
    scoringMode: "VLM_RUBRIC",
    profile,
  };
}

async function scoreSubmissionDefault(input: ScoringInput): Promise<ScoringOutput> {
  const uploadsDir = path.resolve(process.cwd(), "uploads");
  const fullMediaPath = path.isAbsolute(input.mediaAbsPath)
    ? input.mediaAbsPath
    : path.join(uploadsDir, path.basename(input.mediaAbsPath));

  let framePaths: string[] = [];
  let frameUrls: string[] = [];
  let keyframeMetrics: KeyframeMetrics | undefined;
  // Tracks every temp/derivative file the pipeline writes so the `finally`
  // can sweep them when scoring throws (otherwise a long string of
  // unscoreable submissions would leak inspector frames into uploads/).
  // For successful video submissions the survivors are intentionally kept
  // because we persist them as evidence URLs on the submission row.
  const ephemeralPaths = new Set<string>();
  let succeeded = false;

  try {
    if (input.mediaType === "video") {
      try {
        const kf = await extractKeyframes(fullMediaPath, { maxFrames: 6 });
        framePaths = kf.frameAbsPaths;
        frameUrls = kf.frameUrls;
        keyframeMetrics = kf.metrics;
        for (const p of framePaths) ephemeralPaths.add(p);
      } catch (err) {
        logger.error({ err }, "Keyframe extraction threw");
        throw new ScoringError(
          "VIDEO_UNREADABLE",
          err instanceof Error ? err.message : "Keyframe extraction failed.",
          false,
        );
      }
      if (framePaths.length === 0) {
        // Aggressive 3-level fallback inside extractKeyframes already ran —
        // if we still have nothing the file genuinely cannot be decoded.
        throw new ScoringError(
          "VIDEO_UNREADABLE",
          "No frames could be decoded from the video.",
          false,
        );
      }

      const { allDark, perFrame } = await areAllFramesTooDark(framePaths);
      if (allDark) {
        logger.warn(
          { perFrame, framePaths },
          "All extracted keyframes are below the luminance threshold",
        );
        throw new ScoringError(
          "FRAMES_TOO_DARK",
          "Every extracted frame is too dark for the model to score.",
          false,
        );
      }
    } else {
      // Image submissions: shrink + recompress before the VLM call so the
      // base64 payload stays small. We MUST NOT rewrite the original upload
      // in place — uploads can be PNG/HEIC/WebP and the file URL we hand
      // back to operators uses the original extension/MIME. Always write a
      // sibling `.vlm.jpg` derivative used solely for the VLM call and
      // clean it up afterwards.
      const ext = path.extname(fullMediaPath).toLowerCase();
      const isJpeg = ext === ".jpg" || ext === ".jpeg";
      let vlmPath = fullMediaPath;
      try {
        if (isJpeg) {
          vlmPath = await compressForVLM(fullMediaPath);
        } else {
          const derivative = fullMediaPath + ".vlm.jpg";
          vlmPath = await compressForVLM(fullMediaPath, derivative);
          if (vlmPath === derivative) ephemeralPaths.add(derivative);
        }
      } catch (err) {
        logger.warn({ err }, "image compress failed; sending original");
      }
      framePaths = [vlmPath];
      frameUrls = [];

      const { allDark, perFrame } = await areAllFramesTooDark(framePaths);
      if (allDark) {
        logger.warn(
          { perFrame, framePaths },
          "Image is below the luminance threshold",
        );
        throw new ScoringError(
          "FRAMES_TOO_DARK",
          "The image is too dark for the model to score.",
          false,
        );
      }
    }

    const tVlm = Date.now();
    const result = await callVLM({
      framePaths,
      areaName: input.areaName,
      machineTag: input.machineTag,
      learnedProfile: input.learnedProfile,
      environmentType: input.environmentType,
    });
    const vlmMs = Date.now() - tVlm;

    if (keyframeMetrics) {
      // Combined per-audit structured event: ffmpeg → dedup → compress → VLM.
      logger.info(
        {
          event: "video_analysis",
          videoAbsPath: fullMediaPath,
          ...keyframeMetrics,
          vlmMs,
          totalAnalysisMs: keyframeMetrics.totalMs + vlmMs,
        },
        "video analysis completed",
      );
    }

    succeeded = true;
    return { ...result, keyframeUrls: frameUrls, keyframeMetrics, vlmMs };
  } finally {
    // For video: only sweep the keyframes we extracted if the pipeline
    // failed (so we don't leak evidence frames into uploads/). For images:
    // always sweep the .vlm.jpg derivative — it never appears as evidence.
    for (const p of ephemeralPaths) {
      const isImageDerivative = p.endsWith(".vlm.jpg");
      if (!succeeded || isImageDerivative) {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch { /* best-effort */ }
        }
      }
    }
  }
}

// `scoreSubmission` is exported as a `let`-bound live binding so the
// integration suite can swap it for a deterministic stub via
// `__setScoreSubmissionForTest`. ESM keeps importers in sync with the
// reassignment, so the real `/api/submissions` route handler runs against
// the stub without any module-level rewiring.
export let scoreSubmission: (input: ScoringInput) => Promise<ScoringOutput> =
  scoreSubmissionDefault;

/**
 * Test-only seam. Lets the integration suite stub the AI pipeline so the
 * real POST /api/submissions handler can be exercised end-to-end without a
 * network round-trip to the VLM (and without depending on real keyframe
 * extraction or image compression). Pass `null` to restore the real impl.
 */
export function __setScoreSubmissionForTest(
  fn: ((input: ScoringInput) => Promise<ScoringOutput>) | null,
): void {
  scoreSubmission = fn ?? scoreSubmissionDefault;
}
