import {
  useGetCurrentShift,
  useGetOperatorStatus,
  useCreateSubmission,
  useReuploadSubmission,
  useIdentifySubmissionArea,
  useGetNextChecks,
  useGetOperatorRecent,
  useGetAreaProfile,
  useGetSubmission,
  useGetActiveNudges,
  useGetActiveNudgesByArea,
  useDismissNudge,
  useUndismissNudge,
  useListAreas,
  getGetSubmissionQueryKey,
  getGetAreaProfileQueryKey,
  AreaStatus,
  AreaIdentificationCandidate,
  AreaIdentificationResult,
  RecentSubmission,
  NextCheck,
  Nudge,
  AreaProfile,
  ErrorResponse,
  Submission,
  AIIssue,
  getGetCurrentShiftQueryKey,
  getGetOperatorStatusQueryKey,
  getGetNextChecksQueryKey,
  getGetOperatorRecentQueryKey,
  getGetActiveNudgesQueryKey,
  getGetActiveNudgesByAreaQueryKey,
  getGetShiftConfigQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useRef, useEffect, useMemo } from "react";
import {
  Camera,
  Upload,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Info,
  RefreshCw,
  Video,
  Clock,
  Tag,
  Plus,
  Sparkles,
  X,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronDown,
  ChevronUp,
  CalendarClock,
  Bell,
  Save,
  Search,
  Check,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import {
  loadCaptureDraft,
  saveCaptureDraft,
  deleteCaptureDraft,
  peekCaptureDraftMeta,
  purgeStaleCaptureDrafts,
} from "@/lib/capture-drafts";
import { useShiftConfig } from "@/lib/shift-config";
import { useFacilitySettingsChangeListener } from "@/lib/facility-settings";
import { useEffectiveOperatorThresholds } from "@/lib/operator-thresholds";
import { EnvironmentChecklist, normalizeEnvironment } from "@/lib/environment";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { MaskedImage, extractRegions, type IssueRegion } from "@/components/masked-image";

const RECENT_STRIP_PREF_KEY = "operator.recentStrip.collapsed";

type DueState = "overdue" | "due-soon" | "ok";

function scoreTone(percent: number) {
  if (percent >= 80)
    return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-500/15" };
  if (percent >= 60)
    return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-500/15" };
  return { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-50 dark:bg-rose-500/15" };
}

export interface UploadErrorToast {
  title: string;
  description: string;
  variant: "destructive";
}

/**
 * Build the toast payload for a failed createSubmission / reuploadSubmission
 * call. Inspects the (orval-generated) ApiError thrown by customFetch for the
 * structured `{ code, hint, error, retryable }` envelope our /submissions
 * endpoints attach (documented in lib/api-spec/openapi.yaml as
 * `ErrorResponse`) so the operator gets an actionable next step instead of
 * the generic "Submission failed". Exported for unit testing.
 *
 * Distinguishes:
 * - Network failure (no `status` on the error)        → "check your connection"
 * - SCORING_FAILED                                    → "couldn't score" + capture hint
 * - MEDIA_REQUIRED / FORBIDDEN / SUBMISSION_NOT_FOUND → preserve the API hint/error
 * - Anything else                                     → fall back to the API
 *                                                       message if present
 */
export function buildUploadErrorToast(err: unknown, fallbackTitle: string): UploadErrorToast {
  const e = err as { status?: number; data?: ErrorResponse | null; message?: string } | null;
  const data = e && typeof e === "object" ? (e.data ?? null) : null;
  const code = typeof data?.code === "string" ? data.code : null;
  const hint = typeof data?.hint === "string" ? data.hint : null;
  const apiMessage = (typeof data?.error === "string" && data.error) || null;

  if (e && typeof e.status !== "number") {
    return {
      variant: "destructive",
      title: fallbackTitle,
      description: "Couldn't reach the server. Check your connection and try again.",
    };
  }

  if (code === "SCORING_FAILED") {
    return {
      variant: "destructive",
      title: "Couldn't score your capture",
      description:
        hint ??
        "The scoring service couldn't analyse this capture. Try again with brighter lighting and a steadier angle.",
    };
  }

  // Structured pipeline failures from /submissions (Task #203). Each maps to
  // an actionable next step so the operator knows whether to re-shoot the
  // capture (VIDEO_UNREADABLE / FRAMES_TOO_DARK) or just wait and retry the
  // same capture (AI_RATE_LIMITED / AI_TIMEOUT / AI_MALFORMED). The
  // server-supplied `hint` always wins so copy can be tuned without a
  // client release.
  if (code === "VIDEO_UNREADABLE") {
    return {
      variant: "destructive",
      title: "We couldn't read this video",
      description:
        hint ??
        "The video appears unreadable. Try recording again as a short MP4, or capture a still photo instead.",
    };
  }

  if (code === "FRAMES_TOO_DARK") {
    return {
      variant: "destructive",
      title: "Capture is too dark",
      description:
        hint ??
        "Every frame came out too dark to analyse. Turn on more light (or your phone's torch) and capture again.",
    };
  }

  if (code === "AI_RATE_LIMITED") {
    return {
      variant: "destructive",
      title: "AI is busy right now",
      description:
        hint ??
        "Too many audits hit the model at once. Wait about a minute and try again — your capture is fine.",
    };
  }

  if (code === "AI_TIMEOUT") {
    return {
      variant: "destructive",
      title: "AI scoring timed out",
      description:
        hint ??
        "The model didn't respond in time. Try once more — if it keeps timing out, try a smaller capture.",
    };
  }

  if (code === "AI_MALFORMED") {
    return {
      variant: "destructive",
      title: "AI returned an unusable response",
      description:
        hint ??
        "The model couldn't structure its answer. Try the same capture again — this is usually transient.",
    };
  }

  if (code === "MEDIA_REQUIRED") {
    return {
      variant: "destructive",
      title: fallbackTitle,
      description: hint ?? apiMessage ?? "Pick a photo or video before submitting.",
    };
  }

  if (code === "FORBIDDEN" || code === "SUBMISSION_NOT_FOUND") {
    return {
      variant: "destructive",
      title: fallbackTitle,
      description: apiMessage ?? "You can't update this submission.",
    };
  }

  return {
    variant: "destructive",
    title: fallbackTitle,
    description: hint ?? apiMessage ?? "There was an error uploading. Please try again.",
  };
}

// Severity colouring for AI suggestion rows.
// We prefer the AI-provided severity attached to each AIRecommendation/AIIssue
// (`aiRecommendationsJson[i].severity`) — the model now classifies each item
// as high/medium/low and we persist it. For older submissions written before
// that field existed, we fall back to a keyword-driven inference so the row
// still gets a meaningful colour rail instead of silently defaulting to
// "low" for everything historic.
type SuggestionSeverity = "high" | "medium" | "low";

function normalizeAiSeverity(s: string | null | undefined): SuggestionSeverity | null {
  if (s === "high" || s === "medium" || s === "low") return s;
  return null;
}

const HIGH_SEVERITY_PATTERNS: RegExp[] = [
  /\b(contamination|contaminant|hazard|hazardous|unsafe|spill|leak|leakage|fire|smoke|sharp|exposed|broken glass|chemical|toxic|biohazard)\b/i,
  /\b(immediately|urgent|critical|stop the line|do not use|lockout|tagout|loto)\b/i,
  // Safety-critical "missing/no X" combinations — a 5S/GMP audit treats an
  // absent guard, PPE, interlock, or earthing as a hard stop, not a medium
  // housekeeping item. Match within a short window so we don't false-positive
  // on unrelated sentences containing both words.
  /\b(missing|no|without|absent|removed)\b[^.\n]{0,40}\b(guard|ppe|gowning|respirator|gloves?|goggles?|helmet|interlock|earthing|grounding|safety cover|machine cover)\b/i,
];
const MEDIUM_SEVERITY_PATTERNS: RegExp[] = [
  /\b(missing|expired|broken|damaged|out of date|out-of-date|overdue|untagged|unlabel(?:l)?ed|wrong label|incorrect label|cracked|loose)\b/i,
  /\b(label|tag|signage|sign|barrier|guard|ppe|gowning)\b/i,
];

export function inferSuggestionSeverity(text: string): SuggestionSeverity {
  if (!text) return "low";
  for (const re of HIGH_SEVERITY_PATTERNS) if (re.test(text)) return "high";
  for (const re of MEDIUM_SEVERITY_PATTERNS) if (re.test(text)) return "medium";
  return "low";
}

function severityStyles(s: SuggestionSeverity): {
  rail: string;
  iconColor: string;
  pillBg: string;
  pillText: string;
  label: string;
} {
  if (s === "high") {
    return {
      rail: "border-l-4 border-l-rose-500/80 dark:border-l-rose-400/70",
      iconColor: "text-rose-600 dark:text-rose-300",
      pillBg: "bg-rose-50 dark:bg-rose-500/15",
      pillText: "text-rose-700 dark:text-rose-300",
      label: "High",
    };
  }
  if (s === "medium") {
    return {
      rail: "border-l-4 border-l-amber-500/80 dark:border-l-amber-400/70",
      iconColor: "text-amber-600 dark:text-amber-300",
      pillBg: "bg-amber-50 dark:bg-amber-500/15",
      pillText: "text-amber-700 dark:text-amber-300",
      label: "Medium",
    };
  }
  return {
    rail: "border-l-4 border-l-sky-500/70 dark:border-l-sky-400/60",
    iconColor: "text-primary",
    pillBg: "bg-secondary",
    pillText: "text-foreground/70",
    label: "Low",
  };
}

/**
 * Pick the subset of issue regions that this recommendation refers to.
 * The VLM emits recommendations and issues separately, but they share
 * `location` and `principle` strings; we match on those (most-precise
 * principle first, then location). If no clear link can be inferred we
 * surface every flagged region so the operator at least sees what the
 * model was reacting to. Pure function — easy to unit-test.
 */
export function regionsForRecommendation(
  recommendation: { location?: string | null; principle?: string | null } | null | undefined,
  allRegions: IssueRegion[],
  issuesForMatching: ReadonlyArray<{ location?: string | null; principle?: string | null; region?: { frameIndex: number; box: [number, number, number, number] } | null }>,
): IssueRegion[] {
  if (!recommendation || allRegions.length === 0) return allRegions;
  const principle = (recommendation.principle ?? "").trim().toLowerCase();
  const location = (recommendation.location ?? "").trim().toLowerCase();
  const byPrinciple = principle
    ? issuesForMatching.filter(
        (i) => i.region && (i.principle ?? "").trim().toLowerCase() === principle,
      )
    : [];
  const byLocation = byPrinciple.length === 0 && location
    ? issuesForMatching.filter(
        (i) => i.region && (i.location ?? "").trim().toLowerCase() === location,
      )
    : [];
  const matched = (byPrinciple.length > 0 ? byPrinciple : byLocation)
    .map((i) => i.region!)
    .filter((r): r is NonNullable<typeof r> => !!r);
  // Fall back to "all flagged frames" when no link is inferable — better
  // than rendering an action item with no visual context.
  return matched.length > 0
    ? matched.map((r) => ({ frameIndex: r.frameIndex, box: r.box }))
    : allRegions;
}

export function SuggestionRow({
  text,
  index,
  aiSeverity,
  regions,
  keyframeUrls,
  imageUrl,
}: {
  text: string;
  index: number;
  // Severity returned by the AI on the matching AIRecommendation/AIIssue. When
  // present we trust it; when missing (older submissions, or the model omitted
  // it) we fall back to keyword-based inference so the row still gets a useful
  // colour cue instead of silently defaulting to low.
  aiSeverity?: SuggestionSeverity | null;
  // Filtered regions for this recommendation. Empty array hides the thumb
  // strip. Each thumbnail surfaces the frame that contains the region with
  // a semi-transparent red overlay (the same MaskedImage component as the
  // hero image).
  regions?: IssueRegion[];
  // Keyframe URLs (relative to /api) — the source URL used to render each
  // thumbnail. For image-only submissions, `imageUrl` is used as the
  // single-frame fallback.
  keyframeUrls?: string[];
  imageUrl?: string | null;
}) {
  const sev: SuggestionSeverity = aiSeverity ?? inferSuggestionSeverity(text);
  const style = severityStyles(sev);
  const sourceAttr = aiSeverity ? "ai" : "inferred";

  // Build the thumbnail strip: one thumb per unique frameIndex referenced
  // by `regions`. We keep the original frame ordering so the strip reads
  // left-to-right in the same order the operator captured the walk-through.
  const thumbs: { src: string; regions: IssueRegion[]; frameIndex: number }[] = (() => {
    if (!regions || regions.length === 0) return [];
    const byFrame = new Map<number, IssueRegion[]>();
    for (const r of regions) {
      if (!byFrame.has(r.frameIndex)) byFrame.set(r.frameIndex, []);
      byFrame.get(r.frameIndex)!.push(r);
    }
    return [...byFrame.entries()]
      .sort(([a], [b]) => a - b)
      .map(([frameIndex, frameRegions]) => {
        const src = keyframeUrls?.[frameIndex]
          ? `/api${keyframeUrls[frameIndex]}`
          : imageUrl
            ? `/api${imageUrl}`
            : null;
        return src ? { src, regions: frameRegions, frameIndex } : null;
      })
      .filter((x): x is { src: string; regions: IssueRegion[]; frameIndex: number } => !!x);
  })();

  return (
    <li
      className={`text-[13.5px] flex flex-col gap-2 bg-secondary/60 p-3 pl-2.5 rounded-xl ${style.rail}`}
      data-testid={`suggestion-row-${index}`}
      data-severity={sev}
      data-severity-source={sourceAttr}
    >
      <div className="flex gap-2 items-start">
        <ArrowRight className={`w-4 h-4 shrink-0 mt-0.5 ${style.iconColor}`} aria-hidden="true" />
        {(() => {
          const split = bulletize(text);
          if (!split) {
            return (
              <span className="leading-snug text-foreground/90 flex-1 min-w-0">
                {text}
              </span>
            );
          }
          return (
            <div className="flex-1 min-w-0 space-y-1">
              {split.lead && (
                <p className="leading-snug text-foreground/90">{split.lead}:</p>
              )}
              <ul
                className="list-disc list-outside pl-4 space-y-0.5 text-foreground/85 leading-snug"
                data-testid={`suggestion-row-${index}-subbullets`}
              >
                {split.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          );
        })()}
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${style.pillBg} ${style.pillText}`}
          aria-label={`Severity: ${style.label}`}
          title={
            aiSeverity
              ? `AI severity: ${style.label}`
              : `Inferred severity: ${style.label}`
          }
        >
          {style.label}
        </span>
      </div>
      {thumbs.length > 0 && (
        <div
          className="flex gap-1.5 ml-6 overflow-x-auto scrollbar-none -mx-0.5 px-0.5"
          data-testid={`suggestion-row-${index}-thumbs`}
        >
          {thumbs.map((t) => (
            <div
              key={t.frameIndex}
              className="relative rounded-md overflow-hidden shrink-0 bg-card shadow-soft"
              title={`Frame ${t.frameIndex + 1}`}
            >
              <MaskedImage
                src={t.src}
                alt={`Frame ${t.frameIndex + 1}`}
                regions={t.regions}
                frameIndex={t.frameIndex}
                className="w-20 h-14"
                imgClassName="w-full h-full object-cover"
              />
              <span className="absolute bottom-0 right-0 px-1 text-[9px] font-semibold bg-black/60 text-white rounded-tl">
                F{t.frameIndex + 1}
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * Render a single AI-flagged issue with the same severity colouring used by
 * `SuggestionRow`. Issues explain *why* an item failed (e.g. "Leak observed
 * near pump base") whereas suggestions describe the fix ("Replace gasket").
 * We trust the AI-attached severity when present and fall back to keyword
 * inference over `issue + evidence` for older payloads that pre-date the
 * severity field.
 */
/**
 * Break a free-form action item / issue string into crisp sub-points when the
 * model packed several clauses into one suggestion. Returns:
 *   - { lead, points } when 2+ sub-points are detected; `lead` is optional
 *     and used for the "Header: a, b, c" colon-list pattern.
 *   - null when the text is already a single crisp point — caller renders it
 *     as a flat line instead of a 1-item bullet list (which reads sillier).
 *
 * Splitters we *do* trust:
 *   - semicolons ("Clean machine; wipe spill; tag area")
 *   - explicit numbered/bulleted prefixes ("1) X 2) Y 3) Z")
 *   - sentence boundaries when there are 3+ sentences (a long paragraph)
 *   - "Header: a, b, c" colon-then-comma-list (uses `Header` as lead and
 *     promotes each comma item to a sub-bullet)
 *
 * Splitters we *don't* trust:
 *   - plain commas without a colon header — too noisy, easily breaks
 *     legitimate "and/or/then" phrasing.
 */
export function bulletize(text: string): { lead: string | null; points: string[] } | null {
  const cleaned = text.trim().replace(/^[•\-\*]+\s*/, "");
  if (!cleaned) return null;

  // 1) Numbered / parenthesised: "1) foo 2) bar 3) baz" or "1. foo 2. bar"
  const numberedRe = /(?:^|\s)\d+[).]\s+/g;
  const numberedMatches = [...cleaned.matchAll(numberedRe)];
  if (numberedMatches.length >= 2) {
    const points: string[] = [];
    for (let i = 0; i < numberedMatches.length; i++) {
      const start = (numberedMatches[i].index ?? 0) + numberedMatches[i][0].length;
      const end = i + 1 < numberedMatches.length
        ? numberedMatches[i + 1].index ?? cleaned.length
        : cleaned.length;
      const piece = cleaned.slice(start, end).trim().replace(/[.;,]\s*$/, "");
      if (piece) points.push(piece);
    }
    const leadIdx = numberedMatches[0].index ?? 0;
    const lead = leadIdx > 0 ? cleaned.slice(0, leadIdx).trim().replace(/[:.]$/, "") : null;
    if (points.length >= 2) return { lead: lead || null, points };
  }

  // 2) Semicolon-separated clauses
  if (cleaned.includes(";")) {
    const parts = cleaned
      .split(";")
      .map((s) => s.trim().replace(/[.,;]\s*$/, ""))
      .filter(Boolean);
    if (parts.length >= 2) return { lead: null, points: parts };
  }

  // 3) "Header: a, b, c" — colon then a 2+ item comma list. Skip when the
  // colon part itself looks like a sentence (more than ~8 words) so we
  // don't shred prose like "Note: this only matters when X, otherwise Y".
  const colonIdx = cleaned.indexOf(":");
  if (colonIdx > 0 && colonIdx < cleaned.length - 1) {
    const head = cleaned.slice(0, colonIdx).trim();
    const tail = cleaned.slice(colonIdx + 1).trim();
    const looksLikeHeader = head.split(/\s+/).length <= 8 && !/[.!?]$/.test(head);
    if (looksLikeHeader && tail.includes(",")) {
      const tailParts = tail
        .split(",")
        .map((s) => s.trim().replace(/[.,;]\s*$/, ""))
        .filter(Boolean);
      if (tailParts.length >= 2) {
        return { lead: head, points: tailParts };
      }
    }
  }

  // 4) Multi-sentence prose (3+ sentences). Two sentences is borderline —
  // keep as a flat line to avoid bullet-noise on simple "Do X. Then Y."
  // pairs.
  const sentences = cleaned
    .split(/(?<=\.)\s+(?=[A-Z0-9])/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length >= 3) {
    return {
      lead: null,
      points: sentences.map((s) => (s.endsWith(".") ? s.slice(0, -1) : s)),
    };
  }

  return null;
}

/**
 * Render the VLM's evidence string. The model often emits multi-frame
 * descriptions like "Frame 1: cable on floor; Frame 4: tangled cables;
 * Frame 5: …", which read as a wall of text. When we detect that pattern
 * we split on the per-frame separator and render a bulleted list — much
 * easier to skim. Plain prose (no Frame-N markers) falls through to the
 * original paragraph rendering.
 */
function EvidenceBlock({ evidence }: { evidence: string }) {
  const text = evidence.trim();
  // Match "Frame N:" at the start of a segment, with segments separated by
  // semicolons OR by another "Frame N:" beginning. We split into chunks
  // starting with a Frame-N marker; anything before the first marker is
  // kept as a lead-in paragraph.
  const markerRe = /(\bFrames?\s+\d+(?:[-,\s\d]*\d+)?\s*:)/g;
  const markers = [...text.matchAll(markerRe)];
  if (markers.length < 2) {
    // No per-frame markers, but the model may still have packed multiple
    // observations into one string (semicolons, "Header: a, b, c", or 3+
    // sentences). Promote those into sub-bullets the same way action items
    // do so the operator sees crisp points instead of a paragraph wall.
    const split = bulletize(text);
    if (!split) {
      return <p className="text-[12.5px] leading-snug text-muted-foreground">{text}</p>;
    }
    return (
      <div className="text-[12.5px] leading-snug text-muted-foreground space-y-1">
        {split.lead && <p>{split.lead}:</p>}
        <ul className="list-disc list-outside pl-4 space-y-0.5">
          {split.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>
    );
  }
  const items: { label: string; body: string }[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index ?? 0;
    const end = i + 1 < markers.length ? markers[i + 1].index ?? text.length : text.length;
    const label = markers[i][1].replace(/:$/, "");
    const body = text.slice(start + markers[i][1].length, end).trim().replace(/[;.]\s*$/, "");
    if (body) items.push({ label, body });
  }
  const leadIn = markers[0].index && markers[0].index > 0
    ? text.slice(0, markers[0].index).trim().replace(/[;.]\s*$/, "")
    : null;
  return (
    <div className="text-[12.5px] leading-snug text-muted-foreground space-y-1">
      {leadIn && <p>{leadIn}</p>}
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="font-medium text-foreground/70 shrink-0">{it.label}:</span>
            <span>{it.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Render multi-sentence prose as a bullet list when there are 2+
 * sentences. Used for pillar reasoning (Set 2/5, Sort 3/5, etc.) where
 * the VLM emits 4–6 sentences of analysis per pillar — a single
 * paragraph reads as a wall of text. Single-sentence reasoning falls
 * through to a paragraph (one sentence in a bullet would be sillier).
 *
 * Sentence boundary detection: split on `. ` followed by an uppercase
 * letter (so "e.g." doesn't break) OR on the marker-style "Frame N:"
 * patterns the model uses. Trailing punctuation is normalised so each
 * bullet ends with a single period regardless of how the model emitted it.
 */
export function ReasoningBlock({
  text,
  className,
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}) {
  const trimmed = text.trim();
  // Split on `. ` + uppercase OR `. ` + digit ("Frame 5..."). Keeps
  // common abbreviations (e.g., i.e., U.S.) from getting mis-split.
  const sentences = trimmed
    .split(/(?<=\.)\s+(?=[A-Z0-9])/g)
    .map((s) => s.trim().replace(/^[•\-\s]+/, ""))
    .filter(Boolean);

  if (sentences.length < 2) {
    return (
      <p
        className={className ?? "text-[12.5px] leading-snug text-muted-foreground"}
        data-testid={testId}
      >
        {trimmed}
      </p>
    );
  }

  return (
    <ul
      className={`${className ?? "text-[12.5px] leading-snug text-muted-foreground"} space-y-0.5 list-disc list-outside pl-4`}
      data-testid={testId}
    >
      {sentences.map((s, i) => (
        <li key={i}>{s.endsWith(".") ? s : `${s}.`}</li>
      ))}
    </ul>
  );
}

export function IssueRow({
  issue,
  index,
}: {
  issue: AIIssue;
  index: number;
}) {
  const aiSev = normalizeAiSeverity(issue.severity ?? null);
  const sev: SuggestionSeverity =
    aiSev ?? inferSuggestionSeverity(`${issue.issue} ${issue.evidence ?? ""}`);
  const style = severityStyles(sev);
  const sourceAttr = aiSev ? "ai" : "inferred";
  const meta: string[] = [];
  if (issue.location) meta.push(issue.location);
  if (issue.principle) meta.push(issue.principle);
  return (
    <li
      className={`text-[13.5px] flex gap-2 items-start bg-secondary/60 p-3 pl-2.5 rounded-xl ${style.rail}`}
      data-testid={`issue-row-${index}`}
      data-severity={sev}
      data-severity-source={sourceAttr}
    >
      <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${style.iconColor}`} aria-hidden="true" />
      <div className="flex-1 min-w-0 space-y-1">
        {(() => {
          const split = bulletize(issue.issue);
          if (!split) {
            return <p className="leading-snug text-foreground/90">{issue.issue}</p>;
          }
          return (
            <>
              {split.lead && (
                <p className="leading-snug text-foreground/90">{split.lead}:</p>
              )}
              <ul
                className="list-disc list-outside pl-4 space-y-0.5 text-foreground/85 leading-snug"
                data-testid={`issue-row-${index}-subbullets`}
              >
                {split.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          );
        })()}
        {issue.evidence && <EvidenceBlock evidence={issue.evidence} />}
        {(meta.length > 0 || issue.pillar) && (
          <div className="flex items-center gap-1.5 flex-wrap text-[11.5px] text-muted-foreground/80">
            {meta.length > 0 && <span>{meta.join(" · ")}</span>}
            {issue.pillar && (
              <span className="capitalize px-1.5 py-0.5 rounded-md bg-background/60 font-medium text-foreground/70">
                {issue.pillar}
              </span>
            )}
          </div>
        )}
      </div>
      <span
        className={`shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide ${style.pillBg} ${style.pillText}`}
        aria-label={`Severity: ${style.label}`}
        title={
          aiSev
            ? `AI severity: ${style.label}`
            : `Inferred severity: ${style.label}`
        }
      >
        {style.label}
      </span>
    </li>
  );
}

function dueStateFor(
  nc: NextCheck | undefined,
  now: number,
  dueSoonThresholdMs: number,
): DueState {
  if (!nc) return "ok";
  if (nc.overdue || new Date(nc.nextDueAt).getTime() <= now) return "overdue";
  if (new Date(nc.nextDueAt).getTime() - now <= dueSoonThresholdMs) return "due-soon";
  return "ok";
}

export default function OperatorHome() {
  // Re-poll the current shift so the suggested shift updates within ~1 minute
  // when the IST shift boundary crosses (e.g. 1:55 PM → 2:05 PM IST).
  const {
    data: currentShift,
    isLoading: shiftLoading,
    isError: shiftError,
    isRefetching: shiftRefetching,
    refetch: refetchCurrentShift,
  } = useGetCurrentShift({
    query: { refetchInterval: 60_000, queryKey: getGetCurrentShiftQueryKey() },
  });
  // Shift pill labels ("Shift A · 7 AM – 3 PM") are derived from the backend
  // /shift/config so the operator switcher always matches the server's notion
  // of when each shift starts/ends — even for facilities running off the
  // 6/14/22 IST defaults.
  const { shiftLabels } = useShiftConfig();
  const [selectedShift, setSelectedShift] = useState<"A" | "B" | "C" | null>(null);
  // Treat "shift unknown" as a real state distinct from A/B/C. Do NOT silently
  // fall back to "A" — that would mis-tag the page as Shift A whenever the
  // current-shift call is loading, errored, or briefly unreachable.
  const activeShift: "A" | "B" | "C" | null =
    selectedShift ?? currentShift?.shift ?? null;
  const shiftKnown = activeShift !== null;
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus(
    { shift: (activeShift ?? "A") as "A" | "B" | "C" },
    { query: { enabled: shiftKnown } },
  );
  // Used purely to disambiguate the empty-state copy when an operator's
  // status response comes back with zero areas: that can mean either "the
  // site has no areas configured at all" or "areas exist but the manager
  // hasn't assigned any to me yet". Both render a friendly message instead
  // of leaving the page blank, but the wording is different. We hold the
  // empty-state until this query has resolved so a transient failure on
  // /areas doesn't flash the wrong copy ("site has no areas") at the
  // operator before the real result lands.
  const {
    data: allAreas,
    isLoading: allAreasLoading,
    isError: allAreasError,
  } = useListAreas();
  const { data: nextChecks } = useGetNextChecks({
    query: { refetchInterval: 60_000, queryKey: getGetNextChecksQueryKey() },
  });
  const { data: recentRaw } = useGetOperatorRecent(
    { limit: 12 },
    { query: { queryKey: getGetOperatorRecentQueryKey({ limit: 12 }) } }
  );
  const recent = recentRaw ?? [];
  // Resolved operator thresholds (env > DB > default), polled slowly so admin
  // tweaks land on the next refetch without a hard refresh.
  const thresholds = useEffectiveOperatorThresholds();
  // Pull active nudges from managers periodically. The endpoint is OPERATOR-only
  // and tracks per-recipient seen state server-side via seen_by_user_ids_json,
  // so each operator sees a given nudge exactly once across refetches. We still
  // de-dupe locally to avoid re-toasting within the same page load.
  const { data: activeNudges } = useGetActiveNudges({
    query: { refetchInterval: 60_000, queryKey: getGetActiveNudgesQueryKey() },
  });
  // Persistent per-area badges. Same data shape, but the toast endpoint above
  // dismisses on read; this one does not, so the badge stays until the area
  // gets a submission this shift (or the operator switches shift). Filtered
  // server-side to the active shift so we only see relevant prompts. While the
  // shift is unknown we disable this query so we never request /nudges?shift=A
  // on behalf of an operator whose real shift might be B or C.
  const nudgesShiftParam = { shift: (activeShift ?? "A") as "A" | "B" | "C" };
  const { data: activeNudgesByArea } = useGetActiveNudgesByArea(
    nudgesShiftParam,
    {
      query: {
        refetchInterval: 60_000,
        queryKey: getGetActiveNudgesByAreaQueryKey(nudgesShiftParam),
        enabled: shiftKnown,
      },
    },
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const seenNudgesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!activeNudges || activeNudges.length === 0) return;
    for (const n of activeNudges) {
      if (seenNudgesRef.current.has(n.id)) continue;
      seenNudgesRef.current.add(n.id);
      toast({
        title: "Manager nudge",
        description: n.machine
          ? `${n.areaName} · ${n.machine} needs a check this shift`
          : `${n.areaName} needs a check this shift`,
      });
    }
  }, [activeNudges, toast]);

  // When a manager retunes shift A/B/C hours (or the timezone) from the
  // Shifts page, surface a non-blocking toast so the operator knows their
  // schedule just shifted under them — and proactively invalidate the
  // queries that bucket by shift (current shift, area grid, next checks)
  // so the page reflects the new boundaries on the next tick instead of
  // waiting up to a minute for the polled refetch to land. The shift-config
  // query is cached for an hour with no focus/mount refetch, so it MUST be
  // invalidated explicitly here or the pill labels ("6 AM – 2 PM") will
  // keep showing the old hours after everything else has refreshed.
  useFacilitySettingsChangeListener(() => {
    toast({
      title: "Shift hours just updated",
      description:
        "A manager changed the shift schedule. Refreshing your view…",
    });
    queryClient.invalidateQueries({ queryKey: getGetCurrentShiftQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetNextChecksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetShiftConfigQueryKey() });
  });

  // Build the area-level due map (machine === null entries) for the area grid.
  const areaDueMap = useMemo(() => {
    const m = new Map<number, NextCheck>();
    for (const nc of nextChecks ?? []) {
      if (nc.machine == null && !m.has(nc.areaId)) m.set(nc.areaId, nc);
    }
    return m;
  }, [nextChecks]);

  // Group active nudges by area so each AreaCard can render its prompts. Most
  // areas have at most one open nudge; we still pass the full list so the card
  // can show a count when a manager has piled on (e.g. "Mixer #2" + area-level).
  const nudgesByAreaId = useMemo(() => {
    const m = new Map<number, Nudge[]>();
    for (const n of activeNudgesByArea ?? []) {
      const arr = m.get(n.areaId);
      if (arr) arr.push(n);
      else m.set(n.areaId, [n]);
    }
    return m;
  }, [activeNudgesByArea]);

  // Detect overdue transitions (still useful even without the standalone
  // section): surface a toast when a previously-OK area becomes overdue.
  const knownOverdueRef = useRef<Set<string>>(new Set());
  const announcedRef = useRef<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Purge any draft captures older than 24h on each operator-page mount, so
  // stale media doesn't accumulate in IndexedDB across shifts.
  useEffect(() => {
    void purgeStaleCaptureDrafts();
  }, []);

  useEffect(() => {
    if (!nextChecks) return;
    const now = Date.now();
    for (const c of nextChecks) {
      const key = `${c.areaId}|${c.machine ?? ""}`;
      const isOverdue = c.overdue || new Date(c.nextDueAt).getTime() <= now;
      if (isOverdue && !knownOverdueRef.current.has(key) && !announcedRef.current.has(key)) {
        toast({
          title: "Check is now due",
          description: c.machine ? `${c.areaName} · ${c.machine}` : c.areaName,
        });
        announcedRef.current.add(key);
      }
      if (isOverdue) knownOverdueRef.current.add(key);
      else knownOverdueRef.current.delete(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextChecks, tick]);

  // Sort the area grid: overdue → due-soon → rest, keeping submitted areas at
  // the bottom so the operator's eye lands on what still needs attention.
  const sortedStatuses = useMemo(() => {
    if (!statuses) return [] as AreaStatus[];
    const now = Date.now();
    const priority = (s: AreaStatus): number => {
      if (s.submitted) return 4;
      // Honour per-area "due soon" overrides — managers can tighten the lead
      // for a fast-cycling line via the /operator-thresholds admin screen and
      // we want that area to flag earlier than the rest of the plant.
      const due = dueStateFor(
        areaDueMap.get(s.areaId),
        now,
        thresholds.dueSoonThresholdMsForArea(s.areaId),
      );
      if (due === "overdue") return 0;
      if (due === "due-soon") return 1;
      return 2;
    };
    return [...statuses].sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return a.areaId - b.areaId;
    });
    // tick keeps sorting fresh as time passes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    statuses,
    areaDueMap,
    tick,
    thresholds.dueSoonThresholdMs,
    thresholds.dueSoonThresholdMsByAreaId,
  ]);

  // Map submission.id -> RecentSubmission so AreaCard can read prior-week best
  // for the encouragement chip without a second fetch.
  const recentBySubmissionId = useMemo(() => {
    const m = new Map<number, RecentSubmission>();
    for (const r of recent) m.set(r.id, r);
    return m;
  }, [recent]);

  // For each area, surface the operator's most recent "good" submission (≥80%)
  // so the capture sheet can show "Last good: NN% on <date>" and prime the
  // operator with what passing looked like.
  const lastGoodByAreaId = useMemo(() => {
    const m = new Map<number, { scorePercent: number; createdAt: string }>();
    // recent is DESC by createdAt; first hit per area is the most recent good.
    for (const r of recent) {
      if (m.has(r.areaId)) continue;
      const pct = Math.round(r.scoreTotal * 4);
      if (pct >= thresholds.encouragementMinPercent) m.set(r.areaId, { scorePercent: pct, createdAt: r.createdAt });
    }
    return m;
  }, [recent, thresholds.encouragementMinPercent]);

  // When we don't yet know the current shift, render an explicit loading or
  // error state for the shift pills instead of pre-selecting "A". The operator
  // can recover from a failed lookup by hitting Retry, or by tapping a pill —
  // selecting one renders the normal page on the next tick.
  if (activeShift === null) {
    // Treat "the query has settled but produced no shift" the same as an
    // explicit error, so the UI never sits forever on "Checking…" copy when
    // the server returned an empty/invalid body.
    const shiftLookupFailed = shiftError || !shiftLoading;
    return (
      <ShiftUnknownView
        shiftLoading={shiftLoading}
        shiftError={shiftLookupFailed}
        shiftRefetching={shiftRefetching}
        onRetry={() => {
          void refetchCurrentShift();
        }}
        onSelectShift={setSelectedShift}
      />
    );
  }

  if (statusLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const completed = statuses?.filter((s) => s.submitted).length || 0;
  const total = statuses?.length || 0;
  // Only render the friendly empty-state once we *know* the operator's
  // status list resolved cleanly to zero rows. A `statuses === undefined`
  // (transient query error / mid-refetch) must NOT render the empty-state
  // — that would falsely tell an operator they have no assignments when
  // we simply haven't heard back from the server yet.
  const showAssignmentEmptyState = Array.isArray(statuses) && total === 0;

  return (
    <div className="space-y-8 pb-20">
      <header className="space-y-6">
        <div className="space-y-2">
          <p className="eyebrow">Today</p>
          <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Active shift</h1>
          <p className="text-muted-foreground text-[15px]">
            {completed} of {total} areas submitted
          </p>
        </div>

        <div role="tablist" className="inline-flex p-1 pill-track rounded-full">
          {shiftLabels.map((opt) => {
            const active = activeShift === opt.value;
            const isCurrent = currentShift?.shift === opt.value;
            return (
              <button
                key={opt.value}
                role="tab"
                aria-selected={active}
                onClick={() => setSelectedShift(opt.value)}
                className={`relative px-4 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="shift-tab-pill"
                    className="absolute inset-0 pill-thumb-bg rounded-full shadow-soft"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative z-10 inline-flex items-center">
                  {opt.label}
                  <span className="ml-1.5 opacity-60 hidden sm:inline">{opt.time}</span>
                  {isCurrent && (
                    <span
                      className={`ml-2 inline-flex items-center w-1.5 h-1.5 rounded-full ${
                        active ? "bg-emerald-500" : "bg-emerald-400"
                      }`}
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <RecentAuditsStrip recent={recent} />

      <section className="space-y-5">
        <h2 className="text-xl font-semibold tracking-tight">Assigned areas</h2>
        {/* Single-column stack on every breakpoint so each card gets full
            width — at desktop sizes the action-items + observed-issues
            split inside the card has room to breathe and reads cleanly
            one-area-at-a-time instead of being squashed into a 2-up grid. */}
        <div className="grid grid-cols-1 gap-5">
          <AnimatePresence mode="popLayout" initial={false}>
            {sortedStatuses.map((status) => (
              <motion.div
                key={`${status.areaId}-${status.submitted ? "done" : "pending"}`}
                layout
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
              >
                <AreaCard
                  status={status}
                  selectedShift={activeShift}
                  assignedAreas={statuses ?? []}
                  dueState={dueStateFor(
                    areaDueMap.get(status.areaId),
                    Date.now(),
                    thresholds.dueSoonThresholdMsForArea(status.areaId),
                  )}
                  dueInfo={areaDueMap.get(status.areaId)}
                  recentForSubmission={
                    status.submitted && status.submission
                      ? recentBySubmissionId.get(status.submission.id)
                      : undefined
                  }
                  lastGood={lastGoodByAreaId.get(status.areaId) ?? null}
                  activeNudges={nudgesByAreaId.get(status.areaId) ?? []}
                  encouragementMinPercent={thresholds.encouragementMinPercent}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {showAssignmentEmptyState && (
            <NoAssignedAreasEmptyState
              siteHasAnyAreas={Array.isArray(allAreas) && allAreas.length > 0}
              siteAreaCountKnown={Array.isArray(allAreas) && !allAreasError}
              siteAreaCountLoading={allAreasLoading}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/* --------------------------- Shift unknown view -------------------------- */

/**
 * Rendered while the current-shift API call is still loading or has errored,
 * BEFORE we know which shift to fetch operator data for. The shift pills are
 * shown so the operator can manually pick one and unblock the page even when
 * the API is briefly unreachable. We never silently pre-select "A" here —
 * doing so was the original bug, since IST is often outside the 6 AM – 2 PM
 * window when this screen mounts.
 */
function ShiftUnknownView({
  shiftLoading,
  shiftError,
  shiftRefetching,
  onRetry,
  onSelectShift,
}: {
  shiftLoading: boolean;
  shiftError: boolean;
  shiftRefetching: boolean;
  onRetry: () => void;
  onSelectShift: (s: "A" | "B" | "C") => void;
}) {
  const { shiftLabels } = useShiftConfig();
  return (
    <div className="space-y-8 pb-20">
      <header className="space-y-6">
        <div className="space-y-2">
          <p className="eyebrow">Today</p>
          <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Active shift</h1>
          {shiftError ? (
            <p
              className="text-[15px] text-rose-700 dark:text-rose-300"
              data-testid="text-shift-error"
            >
              Couldn't determine current shift.
            </p>
          ) : (
            <p
              className="text-muted-foreground text-[15px]"
              data-testid="text-shift-loading"
            >
              Checking current shift…
            </p>
          )}
        </div>

        <div
          role="tablist"
          aria-busy={shiftLoading}
          className="inline-flex p-1 pill-track rounded-full"
        >
          {shiftLabels.map((opt) => (
            <button
              key={opt.value}
              role="tab"
              aria-selected={false}
              disabled={shiftLoading}
              onClick={() => onSelectShift(opt.value)}
              data-testid={`button-shift-${opt.value}`}
              className={`relative px-4 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors text-muted-foreground ${
                shiftLoading
                  ? "opacity-60 cursor-wait"
                  : "hover:text-foreground"
              }`}
            >
              <span className="relative z-10 inline-flex items-center">
                {opt.label}
                <span className="ml-1.5 opacity-60 hidden sm:inline">{opt.time}</span>
              </span>
            </button>
          ))}
        </div>

        {shiftError && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={shiftRefetching}
              data-testid="button-retry-current-shift"
              className="rounded-full"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 mr-1.5 ${shiftRefetching ? "animate-spin" : ""}`}
              />
              {shiftRefetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )}
      </header>
    </div>
  );
}

/* ------------------------ No assigned areas state ------------------------ */

/**
 * Friendly empty-state for the assigned-areas grid. Two distinct messages so
 * the operator knows whether the site is brand-new (no areas exist yet) or
 * whether a manager has set things up but missed assigning them — the second
 * case is almost always a configuration mistake on the manager's side and
 * the previous "see everything" fallback was actively misleading.
 */
function NoAssignedAreasEmptyState({
  siteHasAnyAreas,
  siteAreaCountKnown,
  siteAreaCountLoading,
}: {
  siteHasAnyAreas: boolean;
  // True only after the /areas lookup has settled cleanly. We hold the
  // strongly-worded "no areas exist" copy until then so a transient
  // failure on /areas can't flash the wrong message at the operator.
  siteAreaCountKnown: boolean;
  siteAreaCountLoading: boolean;
}) {
  let variant: "unassigned" | "no-areas" | "unknown";
  let title: string;
  let body: string;
  if (siteHasAnyAreas) {
    variant = "unassigned";
    title = "No areas assigned to you yet";
    body =
      "Your manager hasn't assigned you any areas. Ask them to add you to the areas you're responsible for so this list fills in.";
  } else if (siteAreaCountKnown) {
    variant = "no-areas";
    title = "No audit areas have been set up yet";
    body =
      "There are no audit areas configured for this site yet. Ask your manager to add some so you can start submitting checks.";
  } else {
    // /areas is still loading or errored — fall back to the neutral
    // wording so we don't claim the site has no areas when we don't
    // actually know.
    variant = "unknown";
    title = "No areas to audit right now";
    body = siteAreaCountLoading
      ? "Hang on while we check your assignments. If this list stays empty, ask your manager whether you're set up for any areas."
      : "We couldn't load the area list. Ask your manager whether you're assigned to any areas, then refresh this page.";
  }
  return (
    <div
      className="col-span-full"
      data-testid="empty-no-assigned-areas"
      data-variant={variant}
    >
      <div className="rounded-2xl border border-dashed border-border/70 bg-secondary/40 px-6 py-10 text-center space-y-2">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-secondary text-muted-foreground">
          <Info className="w-5 h-5" aria-hidden="true" />
        </div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto leading-snug">
          {body}
        </p>
      </div>
    </div>
  );
}

/* ----------------------------- Recent strip ------------------------------ */

function RecentAuditsStrip({ recent }: { recent: RecentSubmission[] }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RECENT_STRIP_PREF_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [openSubId, setOpenSubId] = useState<number | null>(null);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RECENT_STRIP_PREF_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / privacy mode
      }
      return next;
    });
  };

  if (!recent || recent.length === 0) return null;

  const items = recent.slice(0, 6);

  return (
    <section aria-label="Your recent audits" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Your recent audits</h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="recent-audits-list"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors min-h-[44px] px-2"
          data-testid="button-toggle-recent-audits"
        >
          {collapsed ? (
            <>
              Show <ChevronDown className="w-4 h-4" />
            </>
          ) : (
            <>
              Hide <ChevronUp className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            id="recent-audits-list"
            key="recent-strip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
              {items.map((r) => (
                <RecentAuditCard key={r.id} recent={r} onOpen={() => setOpenSubId(r.id)} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <RecentDetailDialog
        submissionId={openSubId}
        onClose={() => setOpenSubId(null)}
      />
    </section>
  );
}

function RecentAuditCard({
  recent,
  onOpen,
}: {
  recent: RecentSubmission;
  onOpen: () => void;
}) {
  const percent = recent.scoreTotal * 4;
  const tone = scoreTone(percent);
  // FALLBACK = the upload landed and the row was saved, but the AI couldn't
  // grade it. The persisted scoreTotal is 0 by construction, but it isn't a
  // real audit result — surface that distinctly so an operator who navigated
  // away from (or missed) the submit toast doesn't mistake it for a real 0%.
  const isFallback = recent.scoringMode === "FALLBACK";
  const prevPercent = recent.prevScoreTotal != null ? recent.prevScoreTotal * 4 : null;
  const delta = prevPercent != null ? Math.round(percent - prevPercent) : null;

  let trendIcon: React.ReactNode = null;
  let trendLabel = "";
  if (isFallback) {
    // The trend line is meaningless when the score itself isn't real.
    trendIcon = <AlertTriangle className="w-3 h-3" />;
    trendLabel = "Tap to re-upload";
  } else if (delta != null) {
    if (delta > 0) {
      trendIcon = <TrendingUp className="w-3 h-3" />;
      trendLabel = `+${delta} pts vs last`;
    } else if (delta < 0) {
      trendIcon = <TrendingDown className="w-3 h-3" />;
      trendLabel = `${delta} pts vs last`;
    } else {
      trendIcon = <Minus className="w-3 h-3" />;
      trendLabel = "same as last";
    }
  } else {
    trendLabel = "First submission";
  }

  const trendColor = isFallback
    ? "text-rose-600 dark:text-rose-400"
    : delta != null && delta > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : delta != null && delta < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";

  // Show up to 2 outstanding actions inline so the operator can prioritize
  // re-captures while walking the floor. The trend line stays directly under
  // the score; actions sit between the trend line and the timestamp footer
  // (which is pinned to the bottom via mt-auto so a long action label can
  // never push the trend off-card). Suppressed for FALLBACK rows since any
  // "actions" attached to them are derived from a meaningless score.
  const topActions = isFallback ? [] : (recent.topActions ?? []);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="snap-start shrink-0 w-[200px] min-h-[112px] text-left bg-card rounded-2xl shadow-soft p-4 flex flex-col gap-2 hover:shadow-elevated active:scale-[0.99] transition-all motion-reduce:active:scale-100 motion-reduce:transition-none"
      data-testid={`recent-card-${recent.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-[14px] tracking-tight leading-snug line-clamp-2">
          {recent.areaName}
        </p>
        {isFallback ? (
          <span
            className="shrink-0 px-2 py-0.5 rounded-full text-[11.5px] font-semibold bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 inline-flex items-center gap-1"
            data-testid={`recent-card-fallback-badge-${recent.id}`}
          >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            Couldn't be scored
          </span>
        ) : (
          <span
            className={`shrink-0 px-2 py-0.5 rounded-full text-[11.5px] font-semibold ${tone.bg} ${tone.text}`}
          >
            {Math.round(percent)}%
          </span>
        )}
      </div>
      <div className={`inline-flex items-center gap-1 text-[11.5px] font-medium ${trendColor}`}>
        {trendIcon}
        <span>{trendLabel}</span>
      </div>
      {topActions.length > 0 && (
        <ul
          className="space-y-1"
          aria-label="Top action items"
          data-testid={`recent-card-actions-${recent.id}`}
        >
          {topActions.map((action, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11.5px] text-foreground/80 leading-snug"
            >
              <ArrowRight className="w-3 h-3 text-primary shrink-0 mt-0.5" aria-hidden="true" />
              {/* min-w-0 lets the flex child shrink below its intrinsic width
                  so the truncate/ellipsis actually kicks in on long labels. */}
              <span className="truncate min-w-0" title={action}>
                {action}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground mt-auto">
        Shift {recent.shift} · {format(new Date(recent.createdAt), "MMM d, h:mm a")}
      </p>
    </button>
  );
}

function RecentDetailDialog({
  submissionId,
  onClose,
}: {
  submissionId: number | null;
  onClose: () => void;
}) {
  const open = submissionId != null;
  const { data, isLoading } = useGetSubmission(submissionId ?? 0, {
    query: {
      enabled: open && submissionId != null,
      queryKey: getGetSubmissionQueryKey(submissionId ?? 0),
    },
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reupload = useReuploadSubmission();
  const reuploadInputRef = useRef<HTMLInputElement>(null);

  // FALLBACK = the upload landed and the row was saved, but the AI couldn't
  // grade it. The pillar reasoning / "Action items" sections are seeded with
  // placeholder data in that case (the no-op fallback action), so we replace
  // the whole detail body with an explanation + a one-tap re-upload button so
  // the operator can fix it without leaving the dialog.
  const isFallback = data?.scoringMode === "FALLBACK";

  const triggerReupload = () => {
    reuploadInputRef.current?.click();
  };

  const handleReuploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still triggers change.
    e.target.value = "";
    if (!file || !data) return;
    reupload.mutate(
      {
        id: data.id,
        // Re-upload preserves the original area; the body just needs the new
        // media. We forward the existing shift + machineTag so the server
        // doesn't accidentally reset them when re-scoring.
        data: {
          media: file as Blob,
          shift: data.shift as "A" | "B" | "C",
          ...(data.machineTag ? { machineTag: data.machineTag } : {}),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Re-upload submitted",
            description: "We'll re-score the new capture in a moment.",
          });
          // Refresh both the audit detail (so the dialog doesn't re-open with
          // stale data if the user opens it again) and the lists that show
          // the recent strip / area grid so the new score / state appears
          // without waiting for the next poll.
          if (data.id != null) {
            queryClient.invalidateQueries({ queryKey: getGetSubmissionQueryKey(data.id) });
          }
          queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOperatorRecentQueryKey({ limit: 12 }) });
          onClose();
        },
        onError: (err) => {
          toast(buildUploadErrorToast(err, "Re-upload failed"));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl" style={{ maxWidth: "1100px" }}>
        <DialogHeader>
          <DialogTitle className="text-xl">{data?.areaName ?? "Submission"}</DialogTitle>
          <DialogDescription>
            {data ? `Submitted ${format(new Date(data.createdAt), "MMM d, h:mm a")}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <div className="py-6 flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted border-t-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl overflow-hidden bg-secondary/60">
              {data.mediaType === "video" && data.keyframesJson && data.keyframesJson.length > 0 ? (
                <MaskedImage
                  src={`/api${data.keyframesJson[0]}`}
                  alt={data.areaName}
                  regions={extractRegions(data.aiIssuesJson)}
                  frameIndex={0}
                  className="w-full h-56"
                />
              ) : (
                <MaskedImage
                  src={`/api${data.imageUrl}`}
                  alt={data.areaName}
                  regions={extractRegions(data.aiIssuesJson)}
                  frameIndex={0}
                  className="w-full h-56"
                />
              )}
            </div>
            {isFallback ? (
              <>
                {/* `videoUnreadable` is a stricter sub-case of FALLBACK: ffmpeg
                    couldn't pull any keyframes out of the upload (malformed
                    file, wall-clock timeout, etc). Re-uploading the same clip
                    with brighter lighting won't help, so we swap in a softer,
                    amber banner whose remediation hint actually applies
                    (re-record shorter or upload a still photo). The re-upload
                    button below is shared — it works for both paths. */}
                {data.videoUnreadable ? (
                  <div
                    className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-4 flex gap-2.5"
                    role="status"
                    data-testid="video-unreadable-banner"
                  >
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    <div className="space-y-1">
                      <p className="text-[14px] font-semibold text-amber-900 dark:text-amber-100">
                        We couldn't analyze this video
                      </p>
                      <p className="text-[12.5px] leading-snug text-amber-900/80 dark:text-amber-100/80">
                        Your upload reached us, but our scoring service couldn't read it. Try re-recording a shorter walk-through (about 30&nbsp;seconds) or uploading a still photo of the area instead.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div
                    className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-500/10 p-4 space-y-2"
                    data-testid="recent-detail-fallback-banner"
                  >
                    <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <p className="font-semibold text-[14px]">Couldn't be scored</p>
                    </div>
                    <p className="text-[12.5px] leading-snug text-rose-800/80 dark:text-rose-200/80">
                      We saved your capture, but our scoring service couldn't grade it. The 0% on this row isn't a real audit result — re-upload with brighter lighting and a steadier angle and we'll try again.
                    </p>
                  </div>
                )}
                <Button
                  type="button"
                  className="w-full h-11 rounded-xl"
                  onClick={triggerReupload}
                  disabled={reupload.isPending}
                  data-testid={`recent-detail-reupload-${data.id}`}
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${reupload.isPending ? "animate-spin" : ""}`} />
                  {reupload.isPending ? "Re-uploading…" : "Re-upload"}
                </Button>
                <input
                  ref={reuploadInputRef}
                  type="file"
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={handleReuploadFile}
                  data-testid={`recent-detail-reupload-input-${data.id}`}
                />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-[13px] text-muted-foreground">Score</p>
                  <span
                    className={`px-3 py-1 rounded-full text-[13px] font-semibold ${
                      scoreTone(data.scoreTotal * 4).bg
                    } ${scoreTone(data.scoreTotal * 4).text}`}
                  >
                    {Math.round(data.scoreTotal * 4)}%
                  </span>
                </div>
                {/* Three-column comparison at lg+ so the operator can read
                    "why each pillar scored what it did", "what to fix", and
                    "what the AI actually flagged" side-by-side. Stepped
                    down at narrower breakpoints:
                      lg+ (1024px) → 3 columns
                      sm (640px)   → 2 columns, with Observed issues spanning
                                     the full second row so the bottom item
                                     doesn't dangle alone
                      mobile       → single-column stack */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {data.scoreJson && (
                    <div className="space-y-2 sm:col-span-1">
                      <p className="eyebrow flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3" /> Why each pillar got the score it did
                      </p>
                      <ul className="space-y-2" data-testid="recent-pillar-reasoning">
                        {Object.entries(data.scoreJson as Record<string, number>).map(([key, value]) => {
                          const reason = (data.aiReasoningJson as Record<string, string> | null | undefined)?.[key];
                          return (
                            <li key={key} className="bg-secondary/60 p-3 rounded-xl">
                              <div className="flex items-center justify-between gap-3">
                                <span className="capitalize text-[12.5px] font-semibold text-foreground/80">{key}</span>
                                <span className="text-[12.5px] font-semibold tabular-nums">{value}/5</span>
                              </div>
                              {reason ? (
                                <div className="mt-1">
                                  <ReasoningBlock
                                    text={reason}
                                    testId={`recent-pillar-reasoning-${key}`}
                                  />
                                </div>
                              ) : (
                                <p className="text-[12px] italic text-muted-foreground/70 mt-1">
                                  No reasoning recorded.
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {data.suggestionsJson && data.suggestionsJson.length > 0 && (
                    <div className="space-y-1.5 sm:col-span-1">
                      <p className="eyebrow flex items-center gap-1.5">
                        <Info className="w-3 h-3" /> Action items
                      </p>
                      <ul className="space-y-2">
                        {data.suggestionsJson.map((s: string, i: number) => (
                          <SuggestionRow
                            key={i}
                            text={s}
                            index={i}
                            // suggestionsJson is derived 1:1 from
                            // aiRecommendationsJson on the server, so the
                            // indices line up. Older submissions lack the
                            // recommendations array entirely; SuggestionRow
                            // falls back to keyword inference when severity
                            // is null.
                            aiSeverity={normalizeAiSeverity(
                              data.aiRecommendationsJson?.[i]?.severity ?? null,
                            )}
                            regions={regionsForRecommendation(
                              data.aiRecommendationsJson?.[i] ?? null,
                              extractRegions(data.aiIssuesJson),
                              (data.aiIssuesJson ?? []) as ReadonlyArray<{
                                location?: string | null;
                                principle?: string | null;
                                region?: { frameIndex: number; box: [number, number, number, number] } | null;
                              }>,
                            )}
                            keyframeUrls={data.keyframesJson ?? []}
                            imageUrl={data.imageUrl}
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.aiIssuesJson && data.aiIssuesJson.length > 0 && (
                    <div
                      className="space-y-1.5 sm:col-span-2 lg:col-span-1"
                      data-testid="recent-observed-issues"
                    >
                      <p className="eyebrow flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3" /> Observed issues
                      </p>
                      <ul className="space-y-2">
                        {data.aiIssuesJson.map((issue, i) => (
                          <IssueRow key={i} issue={issue} index={i} />
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Area card -------------------------------- */

export function AreaCard({
  status,
  selectedShift,
  assignedAreas,
  dueState,
  dueInfo,
  recentForSubmission,
  lastGood,
  activeNudges,
  encouragementMinPercent,
}: {
  status: AreaStatus;
  selectedShift: "A" | "B" | "C";
  assignedAreas: AreaStatus[];
  dueState: DueState;
  dueInfo: NextCheck | undefined;
  recentForSubmission: RecentSubmission | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
  activeNudges: Nudge[];
  encouragementMinPercent: number;
}) {
  // Tick once a minute so the relative-time labels this card owns
  // ("Last checked X ago", "Next due in X", "Draft saved X ago") stay
  // fresh without waiting for the next data refetch.
  useMinuteTick();
  const [isCaptureOpen, setIsCaptureOpen] = useState(false);
  const [isReuploadMode, setIsReuploadMode] = useState(false);
  const [media, setMedia] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [machineTag, setMachineTag] = useState("");
  // Per (operator, area) resumable draft. We only PEEK at the saved timestamp
  // on mount so the pending card can show a "Draft saved" pill without paying
  // the cost of hydrating the media Blob for every card on the grid. The full
  // draft (media + machineTag) is loaded lazily when the operator opens the
  // capture sheet to actually resume.
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftMetaCheckedRef = useRef(false);
  const draftMediaLoadedRef = useRef(false);
  // Submission detail dialog opened from the post-submit "View details" toast
  // action — lets the operator jump straight from the score toast to the full
  // pillar breakdown without hunting for the just-uploaded card.
  const [detailSubmissionId, setDetailSubmissionId] = useState<number | null>(null);

  // Auto-detected area state. The capture sheet runs identification in the
  // background once media is selected (skipped when there's only one assigned
  // area, or a re-capture which inherits the original area). The "chosen"
  // area is what we actually submit with — defaults to the tapped area but
  // the operator may switch to the AI's suggestion or pick manually.
  const [chosenAreaId, setChosenAreaId] = useState<number>(status.areaId);
  const [identification, setIdentification] = useState<AreaIdentificationResult | null>(null);
  const identifyForFileRef = useRef<File | null>(null);

  const recordVideoInputRef = useRef<HTMLInputElement>(null);
  const pickVideoInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const createSubmission = useCreateSubmission();
  const reuploadSubmission = useReuploadSubmission();
  const identifyArea = useIdentifySubmissionArea();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const operatorId = user?.id ?? null;

  // Re-capture is scoped to the existing submission's area, so detection is
  // not meaningful there. With only one assigned area, the suggestion would
  // be a tautology — skip to keep the sheet uncluttered.
  const detectionEnabled = !isReuploadMode && assignedAreas.length > 1;

  // Lazily fetch the learned profile only when the capture sheet is open, so
  // the operator sees "what good looks like" without paying the cost up-front.
  const { data: profile } = useGetAreaProfile(status.areaId, {
    query: {
      enabled: isCaptureOpen,
      queryKey: getGetAreaProfileQueryKey(status.areaId),
    },
  });

  const isVideo = (f: File | null) => !!f && f.type.startsWith("video/");

  // Peek at draft metadata once on mount so the pending card can render a
  // "Draft saved" pill without loading media. We only surface drafts in the
  // "create" flow — once submitted, the operator uses the re-capture flow
  // which doesn't rely on local drafts.
  useEffect(() => {
    if (draftMetaCheckedRef.current) return;
    if (operatorId == null) return;
    if (status.submitted) return;
    draftMetaCheckedRef.current = true;
    let cancelled = false;
    void (async () => {
      const meta = await peekCaptureDraftMeta(operatorId, status.areaId);
      if (cancelled || !meta) return;
      setDraftSavedAt(meta.savedAt);
    })();
    return () => {
      cancelled = true;
    };
  }, [operatorId, status.areaId, status.submitted]);

  // Lazily hydrate the full draft (media + machineTag) — called when the
  // operator opens the capture sheet to actually resume the in-progress draft.
  const hydrateDraftMedia = async (): Promise<boolean> => {
    if (operatorId == null) return false;
    if (draftMediaLoadedRef.current) return media != null;
    draftMediaLoadedRef.current = true;
    const draft = await loadCaptureDraft(operatorId, status.areaId);
    if (!draft) return false;
    const file = new File([draft.media], draft.mediaName || "capture", {
      type: draft.mediaType || draft.media.type || "application/octet-stream",
    });
    setMedia(file);
    setMachineTag(draft.machineTag || "");
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(draft.media);
    });
    setDraftSavedAt(draft.savedAt);
    return true;
  };

  // Persist the in-progress capture (debounced) so a swipe-away or signal drop
  // doesn't lose what the operator just selected.
  useEffect(() => {
    if (operatorId == null) return;
    if (status.submitted) return;
    if (isReuploadMode) return; // re-capture is a separate, non-draftable flow
    if (!media) return;
    const handle = setTimeout(() => {
      const savedAt = Date.now();
      void saveCaptureDraft({
        operatorId,
        areaId: status.areaId,
        media,
        mediaName: media.name || "capture",
        mediaType: media.type || "application/octet-stream",
        machineTag,
        savedAt,
      }).then(() => setDraftSavedAt(savedAt));
    }, 300);
    return () => clearTimeout(handle);
  }, [operatorId, status.areaId, status.submitted, isReuploadMode, media, machineTag]);

  // Run area identification once per distinct media file. We key off the File
  // identity (not just `!!media`) so picking a fresh file re-runs detection,
  // while a re-render with the same file does not. Re-capture inherits the
  // existing area, so detection is skipped there.
  useEffect(() => {
    if (!detectionEnabled) return;
    if (!media) return;
    if (identifyForFileRef.current === media) return;
    identifyForFileRef.current = media;
    setIdentification(null);
    identifyArea.mutate(
      { data: { media: media as Blob } },
      {
        onSuccess: (result) => {
          // Guard against late responses from a discarded file.
          if (identifyForFileRef.current !== media) return;
          setIdentification(result);
          // The spec's "confirm with one tap" UX: when the AI is confident,
          // pre-select its top suggestion so a single Submit tap completes
          // the flow. The operator can still override via the Change picker.
          // Threshold of 0.4 keeps low-signal guesses from auto-switching
          // away from the originally tapped area.
          const top = result.candidates[0];
          if (
            result.hasTrainedAreas &&
            top &&
            top.confidence >= 0.4 &&
            assignedAreas.some((a) => a.areaId === top.areaId)
          ) {
            setChosenAreaId(top.areaId);
          }
        },
        onError: () => {
          // Stay silent on the toast — the sheet's detection block already
          // surfaces the failure inline so the operator can pick manually.
          if (identifyForFileRef.current !== media) return;
          setIdentification({ candidates: [], hasTrainedAreas: true, rationale: null });
        },
      },
    );
    // identifyArea is a stable mutation hook; we intentionally exclude it from
    // deps to avoid restarting detection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, detectionEnabled, assignedAreas]);

  const clearLocalCaptureState = () => {
    setMedia(null);
    setMachineTag("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraftSavedAt(null);
    // Allow a future hydrate attempt if a fresh draft is saved later.
    draftMediaLoadedRef.current = false;
    setIdentification(null);
    setChosenAreaId(status.areaId);
    identifyForFileRef.current = null;
  };

  const handleFileSelect = (mode: "create" | "reupload") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMedia(file);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      setIsReuploadMode(mode === "reupload");
      setIsCaptureOpen(true);
    }
    // reset input so picking the same file twice still triggers change
    e.target.value = "";
  };

  const openCaptureSheet = () => {
    setIsReuploadMode(false);
    // If a draft exists for this (operator, area) but media hasn't been
    // hydrated yet (we only peeked at the timestamp on mount), pull it from
    // IndexedDB now so the resume banner + preview show up. If there's no
    // draft, start clean.
    if (!media) {
      if (draftSavedAt != null && !draftMediaLoadedRef.current) {
        void hydrateDraftMedia();
      } else {
        setMachineTag("");
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
    }
    setIsCaptureOpen(true);
  };

  const openReuploadSheet = () => {
    setIsReuploadMode(true);
    setMedia(null);
    setMachineTag(status.submission?.machineTag ?? "");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraftSavedAt(null);
    setIsCaptureOpen(true);
  };

  const closeCapture = () => {
    setIsCaptureOpen(false);
    if (isReuploadMode) {
      // Re-capture state is ephemeral — don't carry it over to the next open.
      setIsReuploadMode(false);
      clearLocalCaptureState();
    }
    // For the create flow we intentionally keep media + tag so that reopening
    // "Add evidence" resumes the in-progress draft.
  };

  const discardDraft = async () => {
    if (operatorId != null) {
      await deleteCaptureDraft(operatorId, status.areaId);
    }
    clearLocalCaptureState();
  };

  const onUploadError = (err: unknown, fallbackTitle: string) => {
    toast(buildUploadErrorToast(err, fallbackTitle));
  };

  const onSuccess = (msg: string, result?: Submission) => {
    const topSuggestion = result?.suggestionsJson?.[0];
    // The toast headline only has room for one suggestion; expose a "View
    // details" action so an operator who wants the full pillar breakdown can
    // open the submission dialog without hunting for the new card. The action
    // is a real button (focusable + keyboard-activatable) via Radix. We also
    // attach it to the FALLBACK (couldn't-be-scored) toast so the operator
    // can still inspect the saved capture.
    //
    // We capture the toast handle so the action can also dismiss the toast
    // when tapped — otherwise on mobile the toast lingers underneath the
    // submission dialog, stacking two overlays competing for attention.
    let toastHandle: ReturnType<typeof toast> | undefined;
    const detailAction = result
      ? (
          <ToastAction
            altText="View submission details"
            onClick={() => {
              setDetailSubmissionId(result.id);
              toastHandle?.dismiss();
            }}
            data-testid={`toast-action-view-details-${result.id}`}
          >
            View details
          </ToastAction>
        )
      : undefined;
    // PENDING = the upload landed but scoring is still running in the
    // background so the operator can keep capturing videos for other areas.
    // The matching "Scoring completed — X%" toast for THIS submission fires
    // from the global completion poller in App.tsx once the row flips out of
    // PENDING, no matter which screen the operator is on by then.
    if (result?.scoringMode === "PENDING") {
      toastHandle = toast({
        title: `${msg} — scoring in background`,
        description: "You can keep capturing other areas; we'll notify you when scoring finishes.",
        duration: 4_000,
      });
    } else
    // FALLBACK = the upload landed and the row was saved, but the VLM didn't
    // produce a real score. Surface that distinctly so the operator knows to
    // re-capture rather than thinking they got a real "0%" audit.
    //
    // `videoUnreadable` is a stricter sub-case of FALLBACK: the keyframe
    // extractor couldn't read the video at all (malformed file, ffmpeg
    // wall-clock timeout). Re-uploading the same clip with "brighter
    // lighting" won't help — the operator needs to re-record a shorter
    // clip or fall back to a still photo, so we send a different
    // remediation hint. Checked first so the more specific message wins.
    if (result?.videoUnreadable) {
      toastHandle = toast({
        variant: "destructive",
        title: `${msg} — couldn't read this video`,
        description:
          "Saved your upload, but we couldn't read the video to score it. Try a shorter walk-through (around 30 seconds) or upload a still photo instead.",
        action: detailAction,
      });
    } else if (result?.scoringMode === "FALLBACK") {
      toastHandle = toast({
        variant: "destructive",
        title: `${msg} — couldn't be scored`,
        description:
          "Saved your capture, but our scoring service couldn't grade it. Try re-uploading with brighter lighting and a steadier angle.",
        action: detailAction,
      });
    } else if (result && topSuggestion) {
      // Successful score: lead with "Scoring completed" so the operator
      // sees a clear close-of-loop signal for the long-running call. The
      // percent + tone live alongside the title; the first action item
      // becomes the description so they get one concrete next step
      // without opening the dialog. View details opens the full report.
      const percent = Math.round(result.scoreTotal * 4);
      const tone = scoreTone(percent);
      toastHandle = toast({
        title: `Scoring completed — ${percent}%`,
        description: topSuggestion,
        className: `${tone.bg} ${tone.text} border-transparent`,
        action: detailAction,
        // Bump the visible duration so the operator doesn't miss it on
        // mobile (default shadcn toast auto-closes around 5 s; scoring
        // takes 20-60 s so the operator was probably looking elsewhere
        // when it finished).
        duration: 12_000,
      });
    } else {
      toastHandle = toast({
        title: result ? "Scoring completed" : msg,
        description: isVideo(media) ? "Walk-through scored across keyframes." : "Photo scored.",
        action: detailAction,
        duration: 12_000,
      });
    }
    queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetNextChecksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOperatorRecentQueryKey({ limit: 12 }) });
    // Submitting clears any active manager nudges for this area+shift on the
    // server (see dismissNudgesForSubmission); refetch so the badge disappears
    // immediately rather than after the 60s poll.
    queryClient.invalidateQueries({
      queryKey: getGetActiveNudgesByAreaQueryKey({ shift: selectedShift }),
    });
    if (operatorId != null && !isReuploadMode) {
      void deleteCaptureDraft(operatorId, status.areaId);
    }
    setIsCaptureOpen(false);
    setIsReuploadMode(false);
    clearLocalCaptureState();
  };

  const handleSubmit = () => {
    if (!media) return;
    const tag = machineTag.trim() || undefined;
    if (isReuploadMode && status.submission) {
      reuploadSubmission.mutate(
        {
          id: status.submission.id,
          data: { media: media as Blob, shift: selectedShift, machineTag: tag },
        },
        {
          onSuccess: (data) => onSuccess("Walk-through re-uploaded", data),
          onError: (err) => onUploadError(err, "Re-upload failed"),
        }
      );
    } else {
      // chosenAreaId is the AI-detected area when detection succeeded and
      // the operator didn't override it; otherwise it's the originally tapped
      // area. Either way it's the source of truth for which area gets the row.
      // We also send the originally tapped area (so the server can persist
      // intent vs. chosen and surface drift to managers) and the AI's top
      // suggestion, if any, so the server can log explicit overrides for
      // future profile-prompt tuning.
      const aiTopSuggestion = identification?.candidates[0]?.areaId;
      createSubmission.mutate(
        {
          data: {
            areaId: chosenAreaId,
            tappedAreaId: status.areaId,
            aiSuggestedAreaId: aiTopSuggestion,
            media: media as Blob,
            shift: selectedShift,
            machineTag: tag,
          },
        },
        {
          onSuccess: (data) => onSuccess("Submitted", data),
          onError: (err) => onUploadError(err, "Submission failed"),
        }
      );
    }
  };

  const triggerRecord = () => {
    if (recordVideoInputRef.current) {
      recordVideoInputRef.current.setAttribute("capture", "environment");
      recordVideoInputRef.current.click();
    }
  };
  const triggerPickVideo = () => {
    if (pickVideoInputRef.current) {
      pickVideoInputRef.current.removeAttribute("capture");
      pickVideoInputRef.current.click();
    }
  };
  const triggerPhoto = () => {
    if (photoInputRef.current) {
      photoInputRef.current.setAttribute("capture", "environment");
      photoInputRef.current.click();
    }
  };

  const isMutating = createSubmission.isPending || reuploadSubmission.isPending;

  /* ------------------- Submitted (completed) variant -------------------- */

  if (status.submitted && status.submission) {
    const sub = status.submission;

    // PENDING = upload landed, scoring still running in the background. We
    // don't have a real score or action items yet so we render a slim
    // "Scoring…" card instead of the full Completed variant — otherwise it
    // would briefly show "0%" with empty action items until the background
    // pipeline finishes. The card flips to the full Completed render on the
    // next /operator/status refetch after scoring lands.
    if (sub.scoringMode === "PENDING") {
      const isVideoSubPending = sub.mediaType === "video";
      return (
        <div
          className="bg-card rounded-2xl shadow-elevated overflow-hidden flex flex-col"
          data-testid={`area-card-scoring-${status.areaId}`}
        >
          <div className="aspect-[16/10] overflow-hidden bg-muted relative">
            <img
              src={`/api${sub.imageUrl}`}
              alt={status.areaName}
              className="w-full h-full object-cover opacity-90"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
            {isVideoSubPending && (
              <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-black/60 text-white">
                <Video className="w-3 h-3" /> Video walk-through
              </span>
            )}
            <div className="absolute bottom-4 left-5 right-5 text-white flex items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[19px] tracking-tight">{status.areaName}</h3>
                <p className="text-[13px] opacity-85">
                  Submitted {format(new Date(sub.createdAt), "h:mm a")}
                </p>
              </div>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold bg-white/15 text-white backdrop-blur-sm">
                <span className="inline-block w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                Scoring…
              </span>
            </div>
          </div>
          <div className="px-5 pt-4 pb-5 flex items-center gap-2 text-muted-foreground">
            <span className="text-[13px]">
              We're analysing your capture. You can keep moving — we'll notify you when this finishes.
            </span>
          </div>
        </div>
      );
    }

    const scorePercent = sub.scoreTotal * 4;
    const tone = scoreTone(scorePercent);
    const isVideoSub = sub.mediaType === "video";

    // Encouragement chip: only on great submissions, only if it beats the
    // operator's prior best for the area in the last 7 days. Falls back to
    // "+N vs last time" when there is a prior submission but no week-best.
    const ctx = recentForSubmission;
    let encouragement: { kind: "best" | "delta"; label: string } | null = null;
    if (ctx && ctx.scoreTotal === sub.scoreTotal && scorePercent >= encouragementMinPercent) {
      if (
        ctx.bestScoreInLastWeek == null ||
        ctx.scoreTotal > ctx.bestScoreInLastWeek
      ) {
        encouragement = { kind: "best", label: "New best this week" };
      } else if (ctx.prevScoreTotal != null && ctx.scoreTotal > ctx.prevScoreTotal) {
        const delta = Math.round((ctx.scoreTotal - ctx.prevScoreTotal) * 4);
        if (delta > 0) encouragement = { kind: "delta", label: `+${delta} vs last time` };
      }
    }

    return (
      <>
        <div className="bg-card rounded-2xl shadow-elevated overflow-hidden flex flex-col transition-transform duration-150 active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none">
          <div className="aspect-[16/10] overflow-hidden bg-muted relative">
            {isVideoSub && sub.keyframesJson && sub.keyframesJson.length > 0 ? (
              <img src={`/api${sub.keyframesJson[0]}`} alt={status.areaName} className="w-full h-full object-cover" />
            ) : (
              <img src={`/api${sub.imageUrl}`} alt={status.areaName} className="w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
            {isVideoSub && (
              <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-black/60 text-white">
                <Video className="w-3 h-3" /> Video walk-through
              </span>
            )}
            <div className="absolute bottom-4 left-5 right-5 text-white flex items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[19px] tracking-tight">{status.areaName}</h3>
                <p className="text-[13px] opacity-85">Submitted {format(new Date(sub.createdAt), "h:mm a")}</p>
              </div>
              <motion.div
                key={sub.id}
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 22, delay: 0.05 }}
                className={`px-3 py-1 rounded-full text-[12px] font-semibold ${tone.bg} ${tone.text}`}
              >
                {Math.round(scorePercent)}%
              </motion.div>
            </div>
          </div>
          <div className="px-5 pt-4 pb-2 flex items-center gap-2 text-emerald-600 dark:text-emerald-400 flex-wrap">
            <CheckCircle2 className="w-[18px] h-[18px]" />
            <span className="text-[13px] font-semibold">Completed</span>
            {sub.machineTag && (
              <span className="ml-2 text-[11.5px] inline-flex items-center gap-1 text-muted-foreground">
                <Tag className="w-3 h-3" /> {sub.machineTag}
              </span>
            )}
            {/* A machine-specific nudge can survive the area's first submission
                if the operator captured a different machine. Surface it so they
                know to re-capture for the requested machine. */}
            {activeNudges.length > 0 && (
              <span
                className="ml-1 inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200"
                data-testid={`pill-nudge-${status.areaId}`}
              >
                <Bell className="w-3 h-3" /> Manager nudge
                {activeNudges.length > 1 && <span className="ml-0.5">×{activeNudges.length}</span>}
              </span>
            )}
            {encouragement && (
              <motion.span
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200"
                data-testid={`chip-encouragement-${sub.id}`}
              >
                <Sparkles className="w-3 h-3" />
                {encouragement.label}
              </motion.span>
            )}
          </div>
          {/* Action items and Observed issues sit side-by-side at lg+ so
              an operator reviewing the audit on a laptop sees what to FIX
              alongside what's WRONG, with no scrolling between them. On
              mobile/tablet they stack vertically (action items first,
              issues below). When there are no observed issues, action
              items take the full row width. */}
          {(() => {
            const hasIssues = !!sub.aiIssuesJson && sub.aiIssuesJson.length > 0;
            return (
              <div
                className={`px-5 pb-5 flex-1 grid grid-cols-1 ${hasIssues ? "lg:grid-cols-2" : ""} gap-4`}
              >
                <div>
                  <p className="eyebrow flex items-center gap-1.5 mb-3">
                    <Info className="w-3 h-3" /> Action items
                  </p>
                  <ul className="space-y-2">
                    {sub.suggestionsJson?.map((s, i) => (
                      <SuggestionRow
                        key={i}
                        text={s}
                        index={i}
                        // Same indices as aiRecommendationsJson; falls
                        // back to keyword inference for older submissions
                        // without the recommendations payload.
                        aiSeverity={normalizeAiSeverity(
                          sub.aiRecommendationsJson?.[i]?.severity ?? null,
                        )}
                        regions={regionsForRecommendation(
                          sub.aiRecommendationsJson?.[i] ?? null,
                          extractRegions(sub.aiIssuesJson),
                          (sub.aiIssuesJson ?? []) as ReadonlyArray<{
                            location?: string | null;
                            principle?: string | null;
                            region?: { frameIndex: number; box: [number, number, number, number] } | null;
                          }>,
                        )}
                        keyframeUrls={sub.keyframesJson ?? []}
                        imageUrl={sub.imageUrl}
                      />
                    ))}
                    {(!sub.suggestionsJson || sub.suggestionsJson.length === 0) && (
                      <li className="text-[13.5px] text-muted-foreground italic bg-secondary/60 p-3 rounded-xl">
                        No immediate action required.
                      </li>
                    )}
                  </ul>
                </div>
                {/* Observed issues — what the AI flagged as wrong, with
                    severity. Hidden entirely for older submissions whose
                    payload predates aiIssuesJson. */}
                {hasIssues && (
                  <div data-testid={`area-observed-issues-${status.areaId}`}>
                    <p className="eyebrow flex items-center gap-1.5 mb-3">
                      <AlertTriangle className="w-3 h-3" /> Observed issues
                    </p>
                    <ul className="space-y-2">
                      {sub.aiIssuesJson!.map((issue, i) => (
                        <IssueRow key={i} issue={issue} index={i} />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
          <div className="p-4 border-t border-border/70">
            <Button
              variant="outline"
              className="w-full rounded-xl h-11"
              onClick={openReuploadSheet}
              data-testid={`button-recapture-${status.areaId}`}
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Re-capture
            </Button>
          </div>
        </div>

        <CaptureSheet
          open={isCaptureOpen}
          areaName={status.areaName}
          mode={isReuploadMode ? "reupload" : "create"}
          profile={profile}
          lastGood={lastGood}
          previewUrl={previewUrl}
          media={media}
          machineTag={machineTag}
          setMachineTag={setMachineTag}
          isMutating={isMutating}
          draftSavedAt={null}
          onDiscardDraft={null}
          onClose={closeCapture}
          onSubmit={handleSubmit}
          onTriggerRecord={triggerRecord}
          onTriggerPickVideo={triggerPickVideo}
          onTriggerPhoto={triggerPhoto}
          detectionEnabled={detectionEnabled}
          isDetecting={identifyArea.isPending}
          identification={identification}
          assignedAreas={assignedAreas}
          tappedAreaId={status.areaId}
          chosenAreaId={chosenAreaId}
          onChangeArea={setChosenAreaId}
        />

        <input
          type="file"
          accept="video/*"
          className="hidden"
          ref={recordVideoInputRef}
          onChange={handleFileSelect("reupload")}
        />
        <input
          type="file"
          accept="video/*"
          className="hidden"
          ref={pickVideoInputRef}
          onChange={handleFileSelect("reupload")}
        />
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={photoInputRef}
          onChange={handleFileSelect("reupload")}
        />

        <RecentDetailDialog
          submissionId={detailSubmissionId}
          onClose={() => setDetailSubmissionId(null)}
        />
      </>
    );
  }

  /* --------------------- Pending (capture) variant ---------------------- */

  const overdue = dueState === "overdue";
  const dueSoon = dueState === "due-soon";
  const hasNudge = activeNudges.length > 0;
  const cardBorder = hasNudge
    ? "ring-1 ring-indigo-200 dark:ring-indigo-500/30 bg-indigo-50/40 dark:bg-indigo-500/5"
    : overdue
      ? "ring-1 ring-rose-200 dark:ring-rose-500/30 bg-rose-50/40 dark:bg-rose-500/5"
      : "";

  return (
    <>
      <div
        className={`bg-card rounded-2xl shadow-elevated p-6 flex flex-col h-full transition-all duration-150 hover:shadow-floating active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none ${cardBorder}`}
        data-testid={`area-card-${status.areaId}`}
      >
        <div className="flex justify-between items-start gap-3">
          <div className="space-y-1.5">
            <h3 className="text-[19px] font-semibold tracking-tight">{status.areaName}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-1 rounded-full">
                <AlertTriangle className="w-3.5 h-3.5" /> Pending
              </p>
              {hasNudge && (
                <p
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 dark:text-indigo-200 bg-indigo-100 dark:bg-indigo-500/20 px-2.5 py-1 rounded-full"
                  data-testid={`pill-nudge-${status.areaId}`}
                >
                  <Bell className="w-3.5 h-3.5" /> Manager nudge
                  {activeNudges.length > 1 && (
                    <span className="ml-1 text-[11px] opacity-80">×{activeNudges.length}</span>
                  )}
                </p>
              )}
              {overdue && (
                <p
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-200 bg-rose-100 dark:bg-rose-500/20 px-2.5 py-1 rounded-full"
                  data-testid={`pill-overdue-${status.areaId}`}
                >
                  <Clock className="w-3.5 h-3.5" /> Overdue
                </p>
              )}
              {!overdue && dueSoon && (
                <p
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-amber-800 dark:text-amber-200 bg-amber-100/80 dark:bg-amber-500/20 px-2.5 py-1 rounded-full"
                  data-testid={`pill-duesoon-${status.areaId}`}
                >
                  <CalendarClock className="w-3.5 h-3.5" /> Due soon
                </p>
              )}
              {draftSavedAt != null && (
                <button
                  type="button"
                  onClick={openCaptureSheet}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-500/15 hover:bg-sky-100 dark:hover:bg-sky-500/25 active:bg-sky-200/80 dark:active:bg-sky-500/30 active:scale-[0.98] motion-reduce:active:scale-100 transition-colors motion-reduce:transition-none px-2.5 py-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer"
                  data-testid={`pill-draft-saved-${status.areaId}`}
                  title={`Draft saved ${format(new Date(draftSavedAt), "MMM d, h:mm a")} — tap to resume`}
                  aria-label={`Resume draft saved ${formatDistanceToNowStrict(new Date(draftSavedAt), { addSuffix: true })}`}
                >
                  <Save className="w-3.5 h-3.5" /> Draft saved{" "}
                  {formatDistanceToNowStrict(new Date(draftSavedAt), { addSuffix: true })}
                </button>
              )}
            </div>
            {dueInfo && (overdue || dueSoon) && (
              <p
                className="text-[12px] text-muted-foreground leading-snug max-w-[34ch]"
                title={
                  overdue
                    ? dueInfo.lastCheckAt
                      ? `Last checked ${format(new Date(dueInfo.lastCheckAt), "MMM d, yyyy h:mm a")}`
                      : undefined
                    : `Next due ${format(new Date(dueInfo.nextDueAt), "MMM d, yyyy h:mm a")}`
                }
              >
                {overdue
                  ? dueInfo.lastCheckAt
                    ? `Last checked ${formatDistanceToNowStrict(new Date(dueInfo.lastCheckAt))} ago.`
                    : "Never checked — capture a baseline."
                  : `Next due in ${formatDistanceToNowStrict(new Date(dueInfo.nextDueAt))}.`}
              </p>
            )}
          </div>
        </div>

        {hasNudge && (
          <NudgeBanner
            nudges={activeNudges}
            areaId={status.areaId}
            selectedShift={selectedShift}
          />
        )}

        <div className="mt-auto pt-8">
          <Button
            className="w-full h-14 text-[15px] font-semibold rounded-xl shadow-soft"
            onClick={openCaptureSheet}
            data-testid={`button-add-evidence-${status.areaId}`}
          >
            <Plus className="w-5 h-5 mr-2" /> Add evidence
          </Button>
        </div>
      </div>

      <CaptureSheet
        open={isCaptureOpen}
        areaName={status.areaName}
        mode={isReuploadMode ? "reupload" : "create"}
        profile={profile}
        lastGood={lastGood}
        previewUrl={previewUrl}
        media={media}
        machineTag={machineTag}
        setMachineTag={setMachineTag}
        isMutating={isMutating}
        draftSavedAt={isReuploadMode ? null : draftSavedAt}
        onDiscardDraft={isReuploadMode ? null : discardDraft}
        onClose={closeCapture}
        onSubmit={handleSubmit}
        onTriggerRecord={triggerRecord}
        onTriggerPickVideo={triggerPickVideo}
        onTriggerPhoto={triggerPhoto}
        detectionEnabled={detectionEnabled}
        isDetecting={identifyArea.isPending}
        identification={identification}
        assignedAreas={assignedAreas}
        tappedAreaId={status.areaId}
        chosenAreaId={chosenAreaId}
        onChangeArea={setChosenAreaId}
      />

      <input
        type="file"
        accept="video/*"
        className="hidden"
        ref={recordVideoInputRef}
        onChange={handleFileSelect("create")}
      />
      <input
        type="file"
        accept="video/*"
        className="hidden"
        ref={pickVideoInputRef}
        onChange={handleFileSelect("create")}
      />
      <input
        type="file"
        accept="image/*"
        className="hidden"
        ref={photoInputRef}
        onChange={handleFileSelect("create")}
      />

      <RecentDetailDialog
        submissionId={detailSubmissionId}
        onClose={() => setDetailSubmissionId(null)}
      />
    </>
  );
}

/* ----------------------------- Nudge banner ------------------------------ */

// How long the "Nudge dismissed · Undo" toast stays open before it auto-
// closes. Operators on a busy floor can miss the silent disappearance, so
// we surface this same value to a visible countdown bar + numeric label
// rendered inside the toast (see UndoCountdown* below) and to the
// `setTimeout` that actually closes the toast — keeping all three in lock-
// step is what guarantees the indicator hits zero exactly when the toast
// goes away.
const NUDGE_UNDO_TOAST_MS = 6000;

/**
 * Thin progress bar that drains from 100% → 0% over `durationMs`, rendered
 * inside the Undo toast description so the operator can see how much time
 * is left to tap Undo. Self-managed: it captures the current time on mount
 * and ticks every 100 ms, so it stays aligned with the parent's
 * `setTimeout(dismiss, durationMs)` even though the two are separate
 * timers (both anchor on the same React mount tick).
 */
function UndoCountdownBar({ durationMs }: { durationMs: number }) {
  const [remaining, setRemaining] = useState(durationMs);
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, durationMs - (Date.now() - start));
      setRemaining(left);
      if (left === 0) window.clearInterval(id);
    }, 100);
    return () => window.clearInterval(id);
  }, [durationMs]);
  const pct = (remaining / durationMs) * 100;
  return (
    <div
      role="progressbar"
      aria-label="Time remaining to undo"
      aria-valuemin={0}
      aria-valuemax={Math.ceil(durationMs / 1000)}
      aria-valuenow={Math.ceil(remaining / 1000)}
      className="mt-2 h-1 w-full overflow-hidden rounded-full bg-foreground/10"
      data-testid="nudge-undo-countdown-bar"
    >
      <div
        className="h-full bg-foreground/40 transition-[width] duration-100 ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Numeric "(Ns…)" suffix shown on the Undo action button, kept on its own
 * 1 Hz interval (rather than reusing the bar's 100 ms tick) so the label
 * doesn't flicker every frame. Counts down to "0s" right as the toast
 * auto-dismisses.
 */
function UndoCountdownLabel({ durationMs }: { durationMs: number }) {
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(durationMs / 1000));
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      const left = Math.max(0, durationMs - (Date.now() - start));
      setSecondsLeft(Math.ceil(left / 1000));
      if (left === 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [durationMs]);
  return (
    <span className="inline-flex items-center">
      Undo
      <span
        className="ml-1 text-xs font-normal opacity-70 tabular-nums"
        data-testid="nudge-undo-countdown-label"
        aria-hidden="true"
      >
        ({secondsLeft}s…)
      </span>
    </span>
  );
}

// Renders the manager's prompts inline on a pending area card. Picks the most
// recent active nudge as the primary message; if there are multiple (rare —
// area-level + machine-specific), shows a compact "+N more" hint instead of
// stacking full banners.
function NudgeBanner({
  nudges,
  areaId,
  selectedShift,
}: {
  nudges: Nudge[];
  areaId: number;
  selectedShift: "A" | "B" | "C";
}) {
  useMinuteTick();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const dismissMutation = useDismissNudge();
  const undismissMutation = useUndismissNudge();

  if (nudges.length === 0) return null;
  // nudges are returned newest-first by fetchByIds; pick index 0 as primary.
  const primary = nudges[0];
  const extra = nudges.length - 1;
  const createdAt = new Date(primary.createdAt);
  const relative = formatDistanceToNowStrict(createdAt, { addSuffix: true });
  const absolute = format(createdAt, "MMM d, yyyy h:mm a");

  const invalidateBadges = () => {
    // Refetch persistent badges so the banner state updates immediately rather
    // than after the 60s poll. The toast endpoint is per-recipient and
    // doesn't reflect server-side dismissal, so we don't invalidate it.
    queryClient.invalidateQueries({
      queryKey: getGetActiveNudgesByAreaQueryKey({ shift: selectedShift }),
    });
  };

  const handleUndo = (nudgeId: number) => {
    // Radix's ToastAction closes the toast automatically when tapped; we
    // just need to roll back the dismissal on the server and refresh the
    // persistent badge query so the banner re-appears.
    undismissMutation.mutate(
      { id: nudgeId },
      {
        onSuccess: () => invalidateBadges(),
        onError: () =>
          toast({
            variant: "destructive",
            title: "Couldn't restore nudge",
            description: "Please try again.",
          }),
      },
    );
  };

  const handleDismiss = () => {
    dismissMutation.mutate(
      { id: primary.id },
      {
        onSuccess: () => {
          invalidateBadges();
          // Capture the nudge id at toast-creation time so a later undo tap
          // refers to the right row even if `nudges` has since changed.
          const dismissedNudgeId = primary.id;
          const t = toast({
            // Radix's ToastProvider defaults `duration` to 5000ms — without
            // this override the toast would auto-close a full second before
            // the inline countdown hit zero, which is the exact "vanished
            // without warning" surprise this whole feature is meant to
            // remove. Pin both the Radix close timer and the visual
            // countdown to the same NUDGE_UNDO_TOAST_MS budget so they
            // finish in lock-step.
            duration: NUDGE_UNDO_TOAST_MS,
            title: "Nudge dismissed",
            description: (
              <div>
                <p>
                  {primary.machine
                    ? `Cleared “${primary.machine}” reminder.`
                    : "Cleared the manager's reminder."}
                </p>
                <UndoCountdownBar durationMs={NUDGE_UNDO_TOAST_MS} />
              </div>
            ),
            action: (
              <ToastAction
                altText="Undo dismiss"
                data-testid={`button-undo-dismiss-nudge-${dismissedNudgeId}`}
                onClick={() => handleUndo(dismissedNudgeId)}
              >
                <UndoCountdownLabel durationMs={NUDGE_UNDO_TOAST_MS} />
              </ToastAction>
            ),
          });
          // Defensive backstop in case Radix's own auto-close timer is
          // paused (e.g. the user has been hovering the toast, which Radix
          // treats as "keep alive"). The shadcn useToast `TOAST_REMOVE_DELAY`
          // is effectively infinite, so without this the toast could linger
          // far past the countdown reaching zero. Calling `dismiss` on an
          // already-closed toast is a no-op.
          window.setTimeout(() => t.dismiss(), NUDGE_UNDO_TOAST_MS + 250);
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Couldn't dismiss nudge",
            description: "Please try again.",
          }),
      },
    );
  };

  return (
    <div
      className="mt-3 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/20 p-3 space-y-1"
      data-testid={`nudge-banner-${areaId}`}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-indigo-700 dark:text-indigo-200">
        <Bell className="w-3.5 h-3.5" />
        <span className="flex-1">
          {primary.machine
            ? `Manager flagged ${primary.machine}`
            : "Manager flagged this area"}
        </span>
        <time
          dateTime={createdAt.toISOString()}
          title={absolute}
          aria-label={`Sent ${relative} (${absolute})`}
          className="text-indigo-500/80 dark:text-indigo-300/80 font-medium"
          data-testid={`nudge-banner-time-${areaId}`}
        >
          · {relative}
        </time>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={dismissMutation.isPending}
          aria-label="Dismiss nudge"
          title="Dismiss"
          className="-mr-2 -my-2 inline-flex items-center justify-center w-10 h-10 rounded-full text-indigo-500/80 hover:text-indigo-700 hover:bg-indigo-100/70 dark:text-indigo-300/80 dark:hover:text-indigo-100 dark:hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
          data-testid={`button-dismiss-nudge-${primary.id}`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {primary.message && (
        <p className="text-[12.5px] text-indigo-900/85 dark:text-indigo-100/90 leading-snug">
          “{primary.message}”
        </p>
      )}
      <p className="text-[11px] text-indigo-700/70 dark:text-indigo-200/70">
        From {primary.createdByEmail}
        {extra > 0 && <> · +{extra} more open</>}
      </p>
    </div>
  );
}

/* ----------------------------- Capture sheet ----------------------------- */

function CaptureSheet({
  open,
  areaName,
  mode,
  profile,
  lastGood,
  previewUrl,
  media,
  machineTag,
  setMachineTag,
  isMutating,
  draftSavedAt,
  onDiscardDraft,
  onClose,
  onSubmit,
  onTriggerRecord,
  onTriggerPickVideo,
  onTriggerPhoto,
  detectionEnabled,
  isDetecting,
  identification,
  assignedAreas,
  tappedAreaId,
  chosenAreaId,
  onChangeArea,
}: {
  open: boolean;
  areaName: string;
  mode: "create" | "reupload";
  profile: AreaProfile | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
  previewUrl: string | null;
  media: File | null;
  machineTag: string;
  setMachineTag: (v: string) => void;
  isMutating: boolean;
  draftSavedAt: number | null;
  onDiscardDraft: (() => void) | null;
  onClose: () => void;
  onSubmit: () => void;
  onTriggerRecord: () => void;
  onTriggerPickVideo: () => void;
  onTriggerPhoto: () => void;
  detectionEnabled: boolean;
  isDetecting: boolean;
  identification: AreaIdentificationResult | null;
  assignedAreas: AreaStatus[];
  tappedAreaId: number;
  chosenAreaId: number;
  onChangeArea: (areaId: number) => void;
}) {
  // The "Resume draft saved X ago" banner stays fresh because AreaCard
  // (this component's parent) installs useMinuteTick and re-renders us
  // every minute — no need to subscribe again here.
  const isVideo = !!media && media.type.startsWith("video/");
  const chosenAreaName =
    assignedAreas.find((a) => a.areaId === chosenAreaId)?.areaName ?? areaName;
  const title =
    mode === "reupload" ? `Re-capture for ${areaName}` : `Add evidence for ${chosenAreaName}`;
  const description =
    mode === "reupload"
      ? "This will replace the current capture and re-score the submission."
      : "Capture a walk-through video, pick a file, or take a photo. The submission is scored automatically.";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[92vh] overflow-y-auto p-5 sm:p-6 sm:max-w-md sm:left-1/2 sm:-translate-x-1/2 sm:rounded-2xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:border-t"
        data-testid="sheet-capture"
      >
        <SheetHeader className="text-left mb-2">
          <SheetTitle className="text-xl">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 my-2">
          {mode === "create" && draftSavedAt != null && media && (
            <div
              className="flex items-center gap-2 rounded-xl border border-dashed border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-200"
              data-testid="banner-resume-draft"
              title={`Draft saved ${format(new Date(draftSavedAt), "MMM d, yyyy h:mm a")}`}
            >
              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
              <span className="leading-snug flex-1">
                Resume draft — saved{" "}
                {formatDistanceToNowStrict(new Date(draftSavedAt), { addSuffix: true })}.
              </span>
              {onDiscardDraft && (
                <button
                  type="button"
                  onClick={onDiscardDraft}
                  className="text-[12px] font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 min-h-[40px] px-2 inline-flex items-center"
                  data-testid="button-discard-draft"
                >
                  Discard
                </button>
              )}
            </div>
          )}

          {mode === "create" && !previewUrl && (() => {
            // Match by `chosenAreaId` (which already accounts for auto-detect
            // overrides) so the bullets follow whichever area the operator
            // is actually capturing for, not the originally-tapped one.
            const chosen = assignedAreas.find((a) => a.areaId === chosenAreaId);
            return (
              <EnvironmentChecklist
                type={normalizeEnvironment(chosen?.environmentType)}
                override={chosen?.walkthroughHintsOverride ?? null}
              />
            );
          })()}

          <ProfileHint profile={profile} lastGood={lastGood} />

          {previewUrl ? (
            <div className="space-y-2">
              <p className="eyebrow">Preview</p>
              <div className="rounded-xl overflow-hidden bg-secondary/60">
                {isVideo ? (
                  <video src={previewUrl} controls className="w-full max-h-64" />
                ) : (
                  <img src={previewUrl} alt="Preview" className="w-full h-56 object-contain" />
                )}
              </div>
              {mode === "create" && detectionEnabled && (
                <DetectionBlock
                  isDetecting={isDetecting}
                  identification={identification}
                  assignedAreas={assignedAreas}
                  tappedAreaId={tappedAreaId}
                  chosenAreaId={chosenAreaId}
                  onChangeArea={onChangeArea}
                />
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="eyebrow">Add evidence</p>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerRecord}
                  data-testid="button-capture-record"
                >
                  <Video className="w-5 h-5 mr-2" /> Record walk-through
                </Button>
                <Button
                  variant="outline"
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerPickVideo}
                  data-testid="button-capture-pick"
                >
                  <Upload className="w-5 h-5 mr-2" /> Choose video file
                </Button>
                <Button
                  variant="outline"
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerPhoto}
                  data-testid="button-capture-photo"
                >
                  <Camera className="w-5 h-5 mr-2" /> Take photo
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="eyebrow inline-flex items-center gap-1.5">
              <Tag className="w-3 h-3" /> Machine / sub-area (optional)
            </label>
            <Input
              value={machineTag}
              onChange={(e) => setMachineTag(e.target.value)}
              placeholder="e.g. Mixer #2"
              className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
              data-testid="input-machine-tag"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 rounded-xl h-11"
            onClick={onClose}
            data-testid="button-capture-cancel"
          >
            Cancel
          </Button>
          <Button
            className="flex-1 rounded-xl h-11"
            onClick={onSubmit}
            disabled={isMutating || !media}
            data-testid="button-capture-submit"
          >
            {isMutating ? "Scoring…" : mode === "reupload" ? "Re-submit" : "Submit"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* --------------------- Auto-detected area block ---------------------- */

// Renders the result of POST /submissions/identify-area against the captured
// media. Three display modes:
//   - pending: VLM call in flight ("Detecting area…")
//   - no trained profiles: skip detection entirely, prompt manual confirm
//   - results: show top suggestion with confidence + Change picker
// The "Change" picker lists all assigned areas (not just AI candidates) so
// the operator can override even when detection completely missed.
function DetectionBlock({
  isDetecting,
  identification,
  assignedAreas,
  tappedAreaId,
  chosenAreaId,
  onChangeArea,
}: {
  isDetecting: boolean;
  identification: AreaIdentificationResult | null;
  assignedAreas: AreaStatus[];
  tappedAreaId: number;
  chosenAreaId: number;
  onChangeArea: (areaId: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  if (isDetecting) {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-dashed border-blue-200 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-500/10 px-3 py-2.5 text-[12.5px] text-blue-800 dark:text-blue-200"
        data-testid="detection-pending"
      >
        <Search className="w-3.5 h-3.5 shrink-0 animate-pulse" />
        <span className="leading-snug">Detecting area…</span>
      </div>
    );
  }

  // Detection ran and returned no trained profiles — fall back to manual.
  if (identification && !identification.hasTrainedAreas) {
    const tapped = assignedAreas.find((a) => a.areaId === tappedAreaId);
    return (
      <div
        className="rounded-xl border border-dashed border-amber-200 dark:border-amber-500/40 bg-amber-50/70 dark:bg-amber-500/10 px-3 py-2.5 space-y-1.5"
        data-testid="detection-no-profiles"
      >
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-900 dark:text-amber-100">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="leading-snug">
            Auto-detect not ready — please confirm the area manually.
          </span>
        </div>
        <AreaPicker
          assignedAreas={assignedAreas}
          chosenAreaId={chosenAreaId}
          tappedAreaId={tappedAreaId}
          chosenLabel={tapped?.areaName ?? null}
          onChangeArea={onChangeArea}
          open={pickerOpen}
          setOpen={setPickerOpen}
        />
      </div>
    );
  }

  // Detection succeeded with at least one ranked candidate.
  const top = identification?.candidates[0] ?? null;
  if (!top) {
    return null;
  }
  const topName =
    assignedAreas.find((a) => a.areaId === top.areaId)?.areaName ?? `Area #${top.areaId}`;
  const confidencePct = Math.round(top.confidence * 100);
  // Confidence buckets shape the badge color so the operator can tell at a
  // glance whether to trust the suggestion.
  const confidenceTone =
    top.confidence >= 0.7
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
      : top.confidence >= 0.4
        ? "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200"
        : "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200";
  const matchesChosen = chosenAreaId === top.areaId;

  return (
    <div
      className="rounded-xl border border-blue-100 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10 px-3 py-2.5 space-y-2"
      data-testid="detection-result"
    >
      <div className="flex items-start gap-2">
        <Search className="w-3.5 h-3.5 mt-0.5 shrink-0 text-blue-700 dark:text-blue-200" />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-medium text-blue-900 dark:text-blue-100">
              Detected:
            </span>
            <span
              className="text-[13px] font-semibold text-blue-950 dark:text-blue-50 truncate"
              data-testid="detection-top-name"
            >
              {topName}
            </span>
            <span
              className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${confidenceTone}`}
              data-testid="detection-top-confidence"
            >
              {confidencePct}%
            </span>
            {matchesChosen && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                <Check className="w-3 h-3" /> Using
              </span>
            )}
          </div>
          {identification?.rationale && (
            <p className="text-[11.5px] text-blue-900/80 dark:text-blue-100/80 leading-snug">
              {identification.rationale}
            </p>
          )}
        </div>
      </div>
      <AreaPicker
        assignedAreas={assignedAreas}
        chosenAreaId={chosenAreaId}
        tappedAreaId={tappedAreaId}
        chosenLabel={
          assignedAreas.find((a) => a.areaId === chosenAreaId)?.areaName ?? null
        }
        onChangeArea={onChangeArea}
        open={pickerOpen}
        setOpen={setPickerOpen}
      />
    </div>
  );
}

function AreaPicker({
  assignedAreas,
  chosenAreaId,
  tappedAreaId,
  chosenLabel,
  onChangeArea,
  open,
  setOpen,
}: {
  assignedAreas: AreaStatus[];
  chosenAreaId: number;
  tappedAreaId: number;
  chosenLabel: string | null;
  onChangeArea: (areaId: number) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="text-[12px] font-semibold underline underline-offset-2 text-blue-800 dark:text-blue-200 hover:text-blue-950 dark:hover:text-blue-50 min-h-[40px] px-2 inline-flex items-center"
          data-testid="button-change-area"
        >
          Change{chosenLabel ? ` (currently ${chosenLabel})` : ""}
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Choose area</DialogTitle>
          <DialogDescription>
            Pick the area this capture belongs to. The submission will be saved against the
            selected area.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-1 max-h-[55vh] overflow-y-auto -mx-1 px-1">
          <ul className="space-y-1.5">
            {assignedAreas.map((a) => {
              const selected = a.areaId === chosenAreaId;
              const original = a.areaId === tappedAreaId;
              return (
                <li key={a.areaId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChangeArea(a.areaId);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition-colors ${
                      selected
                        ? "bg-primary/10 border border-primary/40 text-foreground"
                        : "bg-secondary/60 hover:bg-secondary border border-transparent"
                    }`}
                    data-testid={`option-area-${a.areaId}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{a.areaName}</div>
                      {original && (
                        <div className="text-[11px] text-muted-foreground">Originally tapped</div>
                      )}
                    </div>
                    {selected ? (
                      <Check className="w-4 h-4 text-primary shrink-0" />
                    ) : (
                      <span className="w-4 h-4 shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex justify-end pt-2">
          <Button
            variant="outline"
            className="rounded-xl"
            onClick={() => setOpen(false)}
            data-testid="button-area-picker-close"
          >
            <X className="w-4 h-4 mr-1.5" /> Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProfileHint({
  profile,
  lastGood,
}: {
  profile: AreaProfile | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
}) {
  // The "(X ago)" suffix on the Last good baseline line stays fresh
  // because the surrounding AreaCard subscribes to useMinuteTick and
  // re-renders this component every minute.
  const lastGoodLine = lastGood ? (
    <p
      className="text-[11.5px] text-emerald-700 dark:text-emerald-300 leading-snug"
      data-testid="profile-last-good"
      title={`Last good baseline ${format(new Date(lastGood.createdAt), "MMM d, yyyy h:mm a")}`}
    >
      Last good: <span className="font-semibold">{lastGood.scorePercent}%</span>{" "}
      on {format(new Date(lastGood.createdAt), "MMM d")} (
      {formatDistanceToNowStrict(new Date(lastGood.createdAt), { addSuffix: true })})
    </p>
  ) : null;

  if (!profile) {
    return (
      <div className="rounded-xl bg-secondary/60 p-3 space-y-1">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> What good looks like
        </p>
        <p className="text-[12.5px] text-muted-foreground">Loading area profile…</p>
        {lastGoodLine}
      </div>
    );
  }

  const isLearning = profile.status === "LEARNING";
  const machines = profile.machines.slice(0, 4);
  const issues = profile.commonIssues.slice(0, 3);
  const items = profile.items.slice(0, 5);
  const hasContent =
    !!profile.summary || machines.length > 0 || issues.length > 0 || items.length > 0;

  if (isLearning && !hasContent) {
    return (
      <div className="rounded-xl bg-secondary/60 p-3 space-y-1">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> What good looks like
        </p>
        <p className="text-[12.5px] text-muted-foreground leading-snug">
          AI is still learning this area — submit a few clean walk-throughs to teach it.
        </p>
        {lastGoodLine}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-secondary/60 p-3 space-y-2">
      <p className="eyebrow inline-flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" /> What good looks like
      </p>
      {profile.summary && (
        <p className="text-[12.5px] text-foreground/85 leading-snug">{profile.summary}</p>
      )}
      {machines.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Capture: </span>
          <span className="text-foreground/85">{machines.join(" · ")}</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Expected items: </span>
          <span className="text-foreground/85">{items.join(", ")}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Watch out for: </span>
          <span className="text-foreground/85">{issues.join("; ")}</span>
        </div>
      )}
      {lastGoodLine}
      {isLearning && (
        <p className="text-[11.5px] text-muted-foreground italic">
          Profile still learning — a few more walk-throughs will sharpen this.
        </p>
      )}
    </div>
  );
}
