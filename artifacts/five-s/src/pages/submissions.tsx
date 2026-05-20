import {
  useListSubmissions,
  useListAreas,
  useGetSubmission,
  useGetLabels,
  useCreateLabel,
  useQuickApproveLabel,
  useResolveEscalation,
  useGetAreaModelStatus,
  getGetAreaModelStatusQueryKey,
  getListSubmissionsQueryKey,
  getGetLabelsQueryKey,
  getListEscalationsQueryKey,
  getGetEscalationCountQueryKey,
} from "@workspace/api-client-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2, ArrowRight, Brain, AlertTriangle, MapPin, Tag, Video, Image as ImageIcon, Sparkles, Search, Keyboard, Pencil, Clock,
} from "lucide-react";
import type { KeyframeMetrics } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { MaskedImage, extractRegions } from "@/components/masked-image";
import { ReasoningBlock } from "@/pages/operator";

const SHIFT_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
] as const;

function scoreTone(percent: number) {
  if (percent >= 80) return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-500/15" };
  if (percent >= 60) return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-500/15" };
  return { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-50 dark:bg-rose-500/15" };
}

function ScorePill({ percent, size = "sm" }: { percent: number; size?: "sm" | "lg" }) {
  const tone = scoreTone(percent);
  const cls = size === "lg" ? "px-3.5 py-1.5 text-[15px]" : "px-2.5 py-0.5 text-[12px]";
  return <span className={`inline-flex items-center font-semibold rounded-full ${cls} ${tone.bg} ${tone.text}`}>{Math.round(percent)}%</span>;
}

function ScoringModeBadge({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  const colors: Record<string, string> = {
    VLM_RUBRIC: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    FALLBACK: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full ${colors[mode] || "bg-secondary text-foreground"}`}>
      <Brain className="w-3 h-3" /> {mode === "VLM_RUBRIC" ? "AI 5S+GMP" : mode}
    </span>
  );
}

function MediaTypeBadge({ type }: { type: string | undefined }) {
  if (!type) return null;
  return type === "video" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
      <Video className="w-3 h-3" /> Video
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-secondary text-foreground/70">
      <ImageIcon className="w-3 h-3" /> Photo
    </span>
  );
}

function PillarBar({ label, value, max = 5, reasoning }: { label: string; value: number; max?: number; reasoning?: string }) {
  const pct = (value / max) * 100;
  const color = pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="capitalize font-medium text-foreground/80 text-[13px] shrink-0">{label}</span>
        {/* The bar flexes to fill the row so it never overflows on 320px screens,
            but caps at 7rem on wider rails so it doesn't dwarf the score chip. */}
        <div className="flex items-center gap-3 flex-1 min-w-0 justify-end">
          <div className="flex-1 min-w-[3rem] max-w-[7rem] h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="font-semibold w-8 text-right text-[13px] tabular-nums shrink-0">{value}/{max}</span>
        </div>
      </div>
      {reasoning && (
        <div className="pl-0.5">
          <ReasoningBlock
            text={reasoning}
            className="text-[12px] leading-snug text-muted-foreground"
            testId={`pillar-reasoning-${label}`}
          />
        </div>
      )}
    </div>
  );
}

export function LabelForm({
  submissionId,
  existingLabel,
  autoFocus,
  aiReasoning,
}: {
  submissionId: number;
  existingLabel?: any;
  autoFocus?: boolean;
  aiReasoning?: Record<string, string> | null;
}) {
  const { user } = useAuth();
  const isManager = user?.role === "MANAGER";
  const [pillars, setPillars] = useState<Record<string, number>>({
    sort: existingLabel?.pillarsJson?.sort ?? 3,
    set: existingLabel?.pillarsJson?.set ?? 3,
    shine: existingLabel?.pillarsJson?.shine ?? 3,
    standardize: existingLabel?.pillarsJson?.standardize ?? 3,
    sustain: existingLabel?.pillarsJson?.sustain ?? 3,
  });
  const createLabel = useCreateLabel();
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus && formRef.current) {
      formRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [autoFocus]);
  if (!isManager) return null;
  const totalScore = Object.values(pillars).reduce((a, b) => a + b, 0);
  const handleSubmit = () => createLabel.mutate({ data: { submissionId, pillarsJson: pillars as any, totalScore } });
  const hasAnyReasoning = !!aiReasoning && Object.values(aiReasoning).some((v) => typeof v === "string" && v.trim().length > 0);

  return (
    <div ref={formRef} className="rounded-2xl p-5 bg-amber-50/70 dark:bg-amber-500/10" data-testid="form-label">
      <div className="flex items-center gap-2 mb-2">
        <Tag className="w-4 h-4 text-amber-700 dark:text-amber-300" />
        <h4 className="font-semibold text-[14px] text-amber-900 dark:text-amber-200">{existingLabel ? "Update label" : "Manager label"}</h4>
      </div>
      <p className="text-[12.5px] text-amber-800/80 dark:text-amber-300/80 mb-1">Override the AI score with ground-truth pillar scores.</p>
      {hasAnyReasoning && (
        <p className="text-[11.5px] text-amber-800/70 dark:text-amber-300/70 mb-4 inline-flex items-center gap-1.5">
          <Brain className="w-3 h-3" /> AI reasoning shown below each slider.
        </p>
      )}
      <div className="space-y-3.5">
        {Object.entries(pillars).map(([key, val]) => {
          const reason = aiReasoning?.[key];
          return (
            <div key={key} className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="capitalize text-[12.5px] font-medium w-20 text-right text-amber-900 dark:text-amber-200">{key}</span>
                {/* Radix Slider sets pointer capture on the thumb during drag,
                    so the pointer can move outside this Dialog without firing
                    onPointerDownOutside / onFocusOutside on the dismissable
                    layer. The native <input type="range"> didn't, which let
                    a vigorous drag dismiss the manager-label dialog mid-edit
                    (task #131). */}
                <SliderPrimitive.Root
                  min={0}
                  max={5}
                  step={1}
                  value={[val]}
                  onValueChange={(v) => setPillars((p) => ({ ...p, [key]: v[0] }))}
                  className="relative flex flex-1 touch-none select-none items-center h-5"
                  data-testid={`label-pillar-slider-${key}`}
                  aria-label={`${key} score`}
                >
                  <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-amber-200/70 dark:bg-amber-500/25">
                    <SliderPrimitive.Range className="absolute h-full bg-amber-600 dark:bg-amber-400" />
                  </SliderPrimitive.Track>
                  <SliderPrimitive.Thumb
                    className="block h-4 w-4 rounded-full border border-amber-600 dark:border-amber-400 bg-background shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    aria-label={`${key} score`}
                  />
                </SliderPrimitive.Root>
                <span className="text-[12.5px] font-semibold w-4 tabular-nums">{val}</span>
              </div>
              {reason && (
                <p
                  className="text-[11.5px] leading-snug text-amber-900/75 dark:text-amber-200/75 pl-[92px] pr-7"
                  data-testid={`label-pillar-reasoning-${key}`}
                >
                  {reason}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-4">
        <span className="text-[12.5px] font-semibold text-amber-900 dark:text-amber-200">Total: {Math.round(totalScore * 4)}%</span>
        <Button size="sm" onClick={handleSubmit} disabled={createLabel.isPending} className="bg-amber-600 hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 text-white rounded-full">
          {createLabel.isPending ? "Saving…" : existingLabel ? "Update" : "Save label"}
        </Button>
      </div>
      {createLabel.isSuccess && <p className="text-[12.5px] text-emerald-700 dark:text-emerald-300 mt-2 font-medium">Label saved successfully.</p>}
    </div>
  );
}

/** Format a millisecond duration as a compact, manager-friendly string.
 *  Sub-second values stay in ms so the breakdown isn't all "0.0s"; longer
 *  ones flip to seconds with a single decimal so a 4-step breakdown still
 *  fits on a single line on phones. Exported so the metrics-block test
 *  can lock the formatting rules without rendering the whole page. */
export function formatAnalysisMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A single labelled metric row inside the analysis-time block. Reused for
 *  every step (scene detect, fallback, dedup, compress, total) so the
 *  block stays visually consistent. */
function MetricRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-muted-foreground">
        {label}
        {hint && <span className="ml-1 text-[11px] text-muted-foreground/70">({hint})</span>}
      </span>
      <span className="font-semibold text-[12.5px] tabular-nums">{value}</span>
    </div>
  );
}

/** Manager-facing keyframe pipeline summary for a video submission. Renders
 *  candidate counts (produced / kept / dropped as duplicates / dropped to
 *  cap) AND a per-step time breakdown so a manager can tell whether a slow
 *  walk-through is bottlenecked on scene detection, the fallback sample, the
 *  dedup pass, or the VLM-prep compression — and decide whether to lower
 *  `KEYFRAMES_MAX_CANDIDATES` for their facility. Renders nothing when the
 *  submission has no metrics (image submissions, or legacy video rows
 *  recorded before the metrics column existed). */
export function KeyframeMetricsBlock({ metrics }: { metrics: KeyframeMetrics }) {
  return (
    <section
      data-testid="keyframe-metrics-block"
      className="rounded-xl p-4 bg-secondary/60 space-y-3"
    >
      <p className="eyebrow inline-flex items-center gap-1.5">
        <Clock className="w-3 h-3" /> Last video analysis
      </p>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <MetricRow label="Candidates produced" value={String(metrics.candidatesProduced)} />
        <MetricRow label="Frames kept" value={String(metrics.candidatesKept)} />
        <MetricRow
          label="Dropped as duplicates"
          value={String(metrics.droppedDuplicate)}
        />
        <MetricRow
          label="Dropped over cap"
          value={String(metrics.droppedOverCap)}
        />
      </div>

      <div className="border-t border-border/60 pt-3 space-y-1.5">
        <MetricRow
          label="Total analysis time"
          value={formatAnalysisMs(metrics.totalMs)}
        />
        <MetricRow
          label="Scene detection"
          value={formatAnalysisMs(metrics.sceneDetectMs)}
        />
        {metrics.fallbackSampleMs != null && (
          <MetricRow
            label="Fallback sampling"
            hint="scene detection found nothing"
            value={formatAnalysisMs(metrics.fallbackSampleMs)}
          />
        )}
        <MetricRow label="Deduplication" value={formatAnalysisMs(metrics.dedupMs)} />
        <MetricRow label="Compression" value={formatAnalysisMs(metrics.compressMs)} />
      </div>

      {metrics.usedFallback && (
        <p className="text-[11.5px] text-amber-700 dark:text-amber-300 leading-snug">
          Scene detection found nothing — the fixed-interval fallback ran instead. A
          steadier walk-through with more visual change usually avoids this.
        </p>
      )}
    </section>
  );
}

function SubmissionDetail({ submissionId, autoFocusLabelForm }: { submissionId: number; autoFocusLabelForm?: boolean }) {
  const { data: sub } = useGetSubmission(submissionId);
  const { data: labels } = useGetLabels(submissionId);
  const { data: modelStatus } = useGetAreaModelStatus(sub?.areaId ?? 0, { query: { enabled: !!sub?.areaId, queryKey: getGetAreaModelStatusQueryKey(sub?.areaId ?? 0) } });
  if (!sub) return null;
  const myLabel = labels?.[0];
  const hasAI = !!sub.scoringMode;
  const scorePercent = sub.scoreTotal * 4;
  const isVideoSub = sub.mediaType === "video";
  const keyframes = sub.keyframesJson ?? [];
  // Only show the analysis-time block for video submissions that actually
  // carry keyframe metrics. Image submissions skip keyframe extraction
  // entirely, and legacy video rows recorded before the metrics column
  // existed are null too — both render as "no block" rather than zeros.
  const keyframeMetrics: KeyframeMetrics | null =
    isVideoSub && sub.keyframeMetricsJson ? sub.keyframeMetricsJson : null;

  return (
    <DialogContent
      className="
        left-0 top-0 sm:left-[50%] sm:top-[50%]
        translate-x-0 translate-y-0 sm:translate-x-[-50%] sm:translate-y-[-50%]
        [--dialog-rest-transform:translate(0,0)] sm:[--dialog-rest-transform:translate(-50%,-50%)]
        w-screen sm:w-full
        max-w-none sm:max-w-5xl
        h-[100dvh] sm:h-auto
        max-h-[100dvh] sm:max-h-[92vh]
        overflow-y-auto rounded-none sm:rounded-2xl p-0 border-0 sm:border
      "
    >
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* Left column: just the main image on mobile, plus keyframes/machine tag on
            desktop. On phones the keyframes & tag move into the right column below
            so managers see Score + AI Issues without scrolling past every frame. */}
        <div className="bg-secondary/40 p-5 sm:p-6 md:p-7 space-y-4 md:rounded-l-2xl">
          <div className="rounded-2xl overflow-hidden bg-black/5 shadow-soft">
            {isVideoSub ? (
              <video src={`/api${sub.imageUrl}`} controls className="w-full h-auto" />
            ) : (
              <MaskedImage
                src={`/api${sub.imageUrl}`}
                alt="Submission"
                regions={extractRegions(sub.aiIssuesJson)}
                frameIndex={0}
                className="w-full h-auto"
              />
            )}
          </div>

          {keyframes.length > 0 && (
            <div className="hidden md:block">
              <p className="eyebrow flex items-center gap-1.5 mb-2"><Video className="w-3 h-3" /> Sampled keyframes ({keyframes.length})</p>
              <div className="grid grid-cols-3 gap-2">
                {keyframes.map((k, i) => (
                  <div key={i} className="rounded-lg overflow-hidden bg-card shadow-soft">
                    <MaskedImage
                      src={`/api${k}`}
                      alt={`Frame ${i + 1}`}
                      regions={extractRegions(sub.aiIssuesJson)}
                      frameIndex={i}
                      className="w-full h-20"
                      imgClassName="w-full h-full object-cover"
                    />
                    <div className="text-[10.5px] text-center py-0.5 text-muted-foreground">Frame {i + 1}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Desktop placement: under the keyframes grid in the left column so
              the analysis breakdown sits next to the frames it describes. The
              mobile copy lives in the right column (after AI Issues) so the
              score remains the first thing on phones. */}
          {keyframeMetrics && (
            <div className="hidden md:block">
              <KeyframeMetricsBlock metrics={keyframeMetrics} />
            </div>
          )}

          {sub.machineTag && (
            <div className="hidden md:flex items-center gap-2 p-3 rounded-xl bg-card">
              <Tag className="w-4 h-4 text-muted-foreground" />
              <span className="text-[13px] font-medium">{sub.machineTag}</span>
            </div>
          )}
        </div>

        <div className="p-5 sm:p-6 md:p-7 space-y-6">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <DialogTitle className="text-xl sm:text-2xl font-semibold tracking-tight">{sub.areaName}</DialogTitle>
                <DialogDescription className="text-[12.5px] sm:text-[13px]">
                  {format(new Date(sub.createdAt), "MMM d, yyyy 'at' h:mm a")} · {sub.userEmail} · Shift {sub.shift}
                </DialogDescription>
              </div>
              <ScorePill percent={scorePercent} size="lg" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <MediaTypeBadge type={sub.mediaType} />
              <ScoringModeBadge mode={sub.scoringMode} />
              {sub.modelVersion && <span className="text-[11px] font-medium text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">Model: {sub.modelVersion}</span>}
              {(sub.failingPillarsJson?.length ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/15 px-2 py-0.5 rounded-full">
                  <AlertTriangle className="w-3 h-3" /> Failing: {sub.failingPillarsJson?.join(", ")}
                </span>
              )}
            </div>
          </DialogHeader>

          {sub.machineTag && (
            <div className="md:hidden flex items-center gap-2 p-3 rounded-xl bg-secondary/60">
              <Tag className="w-4 h-4 text-muted-foreground" />
              <span className="text-[13px] font-medium">{sub.machineTag}</span>
            </div>
          )}

          <section data-testid="submission-score-section">
            <p className="eyebrow mb-3">Score breakdown</p>
            {sub.aiReasoningJson && (
              <p className="text-[12px] text-muted-foreground mb-3 inline-flex items-center gap-1.5">
                <Brain className="w-3 h-3 text-primary" /> Why each pillar got the score it did
              </p>
            )}
            <div className="space-y-3.5">
              {Object.entries(sub.scoreJson || {}).map(([key, value]) => (
                <PillarBar
                  key={key}
                  label={key}
                  value={value as number}
                  reasoning={(sub.aiReasoningJson as Record<string, string> | null | undefined)?.[key]}
                />
              ))}
            </div>
          </section>

          {hasAI && Array.isArray(sub.aiIssuesJson) && sub.aiIssuesJson.length > 0 && (
            <section data-testid="submission-ai-issues-section">
              <p className="eyebrow mb-3 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-rose-500" /> Issues detected</p>
              <ul className="space-y-2">
                {sub.aiIssuesJson.map((issue: any, i: number) => (
                  <li key={i} className="p-3 rounded-xl bg-rose-50/80 dark:bg-rose-500/12">
                    <div className="font-medium text-[13.5px] text-rose-900 dark:text-rose-200">{issue.issue}</div>
                    <div className="text-[12.5px] text-rose-800/80 dark:text-rose-300/85 mt-1">{issue.evidence}</div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[12px] text-rose-600 dark:text-rose-300">
                        <MapPin className="w-3 h-3" /> {issue.location}
                      </span>
                      {issue.pillar && (
                        <span className="text-[11px] font-semibold uppercase tracking-wide bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-200 px-2 py-0.5 rounded-full">{issue.pillar}</span>
                      )}
                      {issue.principle && (
                        <span className="text-[11px] text-rose-700/80 dark:text-rose-300/80">{issue.principle}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Mobile-only keyframe strip rendered after AI Issues so the score
              and findings are reachable without scrolling past the frames. */}
          {keyframes.length > 0 && (
            <section className="md:hidden" data-testid="submission-keyframes-mobile">
              <p className="eyebrow flex items-center gap-1.5 mb-2"><Video className="w-3 h-3" /> Sampled keyframes ({keyframes.length})</p>
              <div className="grid grid-cols-3 gap-2">
                {keyframes.map((k, i) => (
                  <div key={i} className="rounded-lg overflow-hidden bg-secondary shadow-soft">
                    <MaskedImage
                      src={`/api${k}`}
                      alt={`Frame ${i + 1}`}
                      regions={extractRegions(sub.aiIssuesJson)}
                      frameIndex={i}
                      className="w-full h-20"
                      imgClassName="w-full h-full object-cover"
                    />
                    <div className="text-[10.5px] text-center py-0.5 text-muted-foreground">Frame {i + 1}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Mobile placement of the analysis-time block — kept right after the
              mobile keyframe strip so the metrics line up with the frames they
              describe even on phones. The desktop copy lives under the
              left-column keyframes grid. */}
          {keyframeMetrics && (
            <div className="md:hidden">
              <KeyframeMetricsBlock metrics={keyframeMetrics} />
            </div>
          )}

          {hasAI && Array.isArray(sub.aiRecommendationsJson) && sub.aiRecommendationsJson.length > 0 && (
            <section>
              <p className="eyebrow mb-3 flex items-center gap-1.5"><Brain className="w-3 h-3 text-primary" /> AI recommendations</p>
              <ul className="space-y-2">
                {sub.aiRecommendationsJson.map((rec: any, i: number) => (
                  <li key={i} className="p-3 rounded-xl bg-sky-50/80 dark:bg-sky-500/12">
                    <div className="font-medium text-[13.5px] text-sky-900 dark:text-sky-200">{rec.action}</div>
                    <div className="text-[12.5px] text-sky-800/80 dark:text-sky-300/85 mt-1">{rec.why}</div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[12px] text-sky-600 dark:text-sky-300"><MapPin className="w-3 h-3" /> {rec.location}</span>
                      {rec.principle && <span className="text-[11px] text-sky-700/80 dark:text-sky-300/80">{rec.principle}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!hasAI && (
            <section>
              <p className="eyebrow mb-3">Suggestions</p>
              <ul className="space-y-2">
                {sub.suggestionsJson?.map((s, i) => (
                  <li key={i} className="flex gap-2.5 items-start bg-secondary/60 p-3 rounded-xl">
                    <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span className="text-[13.5px] leading-relaxed">{s}</span>
                  </li>
                ))}
                {(!sub.suggestionsJson || sub.suggestionsJson.length === 0) && (
                  <li className="text-[13.5px] flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 rounded-xl">
                    <CheckCircle2 className="w-4 h-4" /> No immediate improvement suggestions.
                  </li>
                )}
              </ul>
            </section>
          )}

          <LabelForm
            submissionId={sub.id}
            existingLabel={myLabel}
            autoFocus={autoFocusLabelForm}
            aiReasoning={sub.aiReasoningJson as Record<string, string> | null | undefined}
          />

          {modelStatus && (
            <div className="rounded-xl p-4 bg-secondary/60">
              <p className="eyebrow mb-2.5 inline-flex items-center gap-1.5"><Sparkles className="w-3 h-3" /> Learning status</p>
              <div className="grid grid-cols-2 gap-2 text-[12.5px]">
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <span className={`font-semibold ${modelStatus.learningStatus === "TRAINED" ? "text-emerald-600" : "text-amber-600"}`}>{modelStatus.learningStatus}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Submissions:</span>{" "}
                  <span className="font-semibold">{modelStatus.submissionsCount} / {modelStatus.targetSubmissions}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Manager labels:</span>{" "}
                  <span className="font-semibold">{modelStatus.labelsCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Latest mode:</span>{" "}
                  <span className="font-semibold">{modelStatus.latestScoringMode ?? "—"}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

const KEYBOARD_SHORTCUTS = [
  { keys: "j / ↓", desc: "Next row" },
  { keys: "k / ↑", desc: "Previous row" },
  { keys: "Enter", desc: "Open submission" },
  { keys: "g", desc: "Approve as-is (1-click label)" },
  { keys: "r", desc: "Resolve open escalation on this row" },
  { keys: "?", desc: "Show this cheat sheet" },
  { keys: "Esc", desc: "Close" },
];

// Decide whether the browser is a touch-only device. We only suppress the
// manager keyboard shortcuts when the primary pointer is coarse AND no fine
// pointer is available anywhere on the system (so phones/tablets without a
// keyboard are excluded, but desktops, laptops, hybrid touchscreen laptops,
// and headless test browsers continue to receive shortcuts). Defaults to
// false (i.e. shortcuts enabled) during SSR / before the media queries
// resolve so the desktop experience is unaffected.
function useIsTouchOnly(): boolean {
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const anyFine = window.matchMedia("(any-pointer: fine)");
    const update = () => setTouchOnly(coarse.matches && !anyFine.matches);
    update();
    const add = (mq: MediaQueryList, fn: () => void) => {
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", fn);
      else mq.addListener(fn);
    };
    const rm = (mq: MediaQueryList, fn: () => void) => {
      if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", fn);
      else mq.removeListener(fn);
    };
    add(coarse, update);
    add(anyFine, update);
    return () => {
      rm(coarse, update);
      rm(anyFine, update);
    };
  }, []);
  return touchOnly;
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="inline-flex items-center gap-2"><Keyboard className="w-4 h-4" /> Keyboard shortcuts</DialogTitle>
          <DialogDescription>Move through the audit log without leaving the keyboard.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-[13px]">
          {KEYBOARD_SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between">
              <span className="text-foreground/80">{s.desc}</span>
              <kbd className="px-2 py-0.5 rounded bg-secondary text-[12px] font-mono">{s.keys}</kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export default function Submissions() {
  const { user } = useAuth();
  const isManager = user?.role === "MANAGER";
  const [shiftFilter, setShiftFilter] = useState<string>("");
  const [areaFilter, setAreaFilter] = useState<string>("");
  const [dateFilter, setDateFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [minScore, setMinScore] = useState<string>("");
  const [maxScore, setMaxScore] = useState<string>("");
  const [debouncedMin, setDebouncedMin] = useState<string>("");
  const [debouncedMax, setDebouncedMax] = useState<string>("");
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);
  const [autoFocusLabelForm, setAutoFocusLabelForm] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const quickApprove = useQuickApproveLabel();
  const resolveEscalation = useResolveEscalation();
  const isTouchOnly = useIsTouchOnly();

  // Debounce search and score inputs to avoid hammering the API on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedMin(minScore);
      setDebouncedMax(maxScore);
    }, 250);
    return () => clearTimeout(id);
  }, [minScore, maxScore]);

  const { data: areas } = useListAreas();
  const params = useMemo(
    () => ({
      shift: shiftFilter ? (shiftFilter as any) : undefined,
      areaId: areaFilter && areaFilter !== "all" ? parseInt(areaFilter) : undefined,
      date: dateFilter ? dateFilter : undefined,
      q: debouncedSearch || undefined,
      minScorePercent: debouncedMin ? Math.max(0, Math.min(100, parseInt(debouncedMin))) : undefined,
      maxScorePercent: debouncedMax ? Math.max(0, Math.min(100, parseInt(debouncedMax))) : undefined,
    }),
    [shiftFilter, areaFilter, dateFilter, debouncedSearch, debouncedMin, debouncedMax],
  );
  const { data: submissions, isLoading } = useListSubmissions(params as any);

  // Reset focused row when results change.
  useEffect(() => {
    if (!submissions || submissions.length === 0) {
      setActiveIdx(-1);
    } else if (activeIdx >= submissions.length) {
      setActiveIdx(submissions.length - 1);
    }
  }, [submissions, activeIdx]);

  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = rowRefs.current[activeIdx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const openWithLabelForm = (id: number) => {
    setAutoFocusLabelForm(true);
    setSelectedSubmissionId(id);
  };

  const handleApprove = (id: number) => {
    quickApprove.mutate(
      { data: { submissionId: id } },
      {
        onSuccess: () => {
          toast({ title: "Approved", description: "AI score saved as your label." });
          queryClient.invalidateQueries({ queryKey: getListSubmissionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetLabelsQueryKey(id) });
        },
        onError: (e: any) => {
          const desc = e?.message ?? "Could not save label.";
          toast({ variant: "destructive", title: "Approve failed", description: desc });
        },
      },
    );
  };

  // Keyboard shortcuts: ignore when a modal is open or focus is in a text input.
  // Only register on devices with a fine pointer (real keyboard); touch-only
  // devices skip this entirely so we don't intercept on-screen keyboards.
  useEffect(() => {
    if (!isManager) return;
    if (isTouchOnly) return;
    const handler = (e: KeyboardEvent) => {
      if (selectedSubmissionId !== null) return;
      if (shortcutsOpen) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = submissions ?? [];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (list.length > 0) {
            e.preventDefault();
            setActiveIdx((i) => Math.min(list.length - 1, (i < 0 ? -1 : i) + 1));
          }
          break;
        case "k":
        case "ArrowUp":
          if (list.length > 0) {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, (i < 0 ? 1 : i) - 1));
          }
          break;
        case "Enter":
          if (activeIdx >= 0 && list[activeIdx]) {
            e.preventDefault();
            setSelectedSubmissionId(list[activeIdx].id);
          }
          break;
        case "g":
          if (activeIdx >= 0 && list[activeIdx]) {
            e.preventDefault();
            handleApprove(list[activeIdx].id);
          }
          break;
        case "r":
          if (activeIdx >= 0 && list[activeIdx]) {
            e.preventDefault();
            const row = list[activeIdx];
            if (row.openEscalationId != null) {
              resolveEscalation.mutate(
                { id: row.openEscalationId },
                {
                  onSuccess: () => {
                    toast({ title: "Escalation resolved", description: row.areaName });
                    queryClient.invalidateQueries({ queryKey: getListSubmissionsQueryKey() });
                    queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey() });
                    queryClient.invalidateQueries({ queryKey: getGetEscalationCountQueryKey() });
                  },
                  onError: (err: any) =>
                    toast({
                      variant: "destructive",
                      title: "Could not resolve",
                      description: err?.message ?? "Try again from the Escalations tab.",
                    }),
                },
              );
            } else {
              toast({
                title: "No open escalation on this row",
                description: "Use the Escalations tab to act on others.",
              });
            }
          }
          break;
        case "?":
          e.preventDefault();
          setShortcutsOpen(true);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager, submissions, activeIdx, selectedSubmissionId, shortcutsOpen]);

  return (
    <div className="space-y-8 pb-12">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <p className="eyebrow">History</p>
          <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Audit log</h1>
          <p className="text-muted-foreground text-[15px]">Review 5S/GMP submissions across all shifts and areas.</p>
        </div>
        {isManager && (
          <button
            onClick={() => setShortcutsOpen(true)}
            className="hidden md:inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground rounded-full px-3 py-1.5 hover-overlay"
            data-testid="button-shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="w-3.5 h-3.5" /> Shortcuts
          </button>
        )}
      </header>

      <div className="bg-card rounded-2xl shadow-soft p-5 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label className="eyebrow">Date</Label>
            <Input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="h-11 rounded-xl bg-secondary/60 border-transparent" />
          </div>
          <div className="space-y-1.5">
            <Label className="eyebrow">Shift</Label>
            <div role="tablist" className="inline-flex p-1 pill-track rounded-full h-11">
              {SHIFT_FILTER_OPTIONS.map((opt) => {
                const active = shiftFilter === opt.value;
                return (
                  <button
                    key={opt.value || "all"}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setShiftFilter(opt.value)}
                    data-testid={`button-shift-filter-${opt.value || "all"}`}
                    className={`relative px-4 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors min-w-[52px] ${
                      active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="submissions-shift-filter-pill"
                        className="absolute inset-0 pill-thumb-bg rounded-full shadow-soft"
                        transition={{ type: "spring", stiffness: 500, damping: 38 }}
                      />
                    )}
                    <span className="relative z-10">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="eyebrow">Area</Label>
            <Select value={areaFilter} onValueChange={setAreaFilter}>
              <SelectTrigger className="h-11 rounded-xl bg-secondary/60 border-transparent"><SelectValue placeholder="All areas" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All areas</SelectItem>
                {areas?.map((a) => (<SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
          <div className="space-y-1.5">
            <Label className="eyebrow">Search</Label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Operator email, machine tag, or area name"
                className="h-11 pl-9 rounded-xl bg-secondary/60 border-transparent"
                data-testid="input-search"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="eyebrow">Score range</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={minScore}
                onChange={(e) => setMinScore(e.target.value)}
                placeholder="Min %"
                className="h-11 rounded-xl bg-secondary/60 border-transparent"
                data-testid="input-min-score"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
                placeholder="Max %"
                className="h-11 rounded-xl bg-secondary/60 border-transparent"
                data-testid="input-max-score"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: stacked cards. The desktop table overflows a 375px viewport
          even with overflow-x-auto, so below the small breakpoint we render a
          tap-friendly card list with the same fields and row actions. */}
      <div className="sm:hidden bg-card rounded-2xl shadow-soft overflow-hidden">
        {isLoading ? (
          <p className="px-5 py-12 text-center text-muted-foreground text-[13.5px]">Loading submissions…</p>
        ) : submissions?.length === 0 ? (
          <p className="px-5 py-12 text-center text-muted-foreground text-[13.5px]">No submissions found matching criteria.</p>
        ) : (
          <ul className="divide-y divide-border">
            {submissions?.map((sub, idx) => {
              const thumb = sub.mediaType === "video" && sub.keyframesJson?.[0] ? sub.keyframesJson[0] : sub.imageUrl;
              const isActive = activeIdx === idx;
              return (
                <li
                  key={sub.id}
                  className={`${isActive ? "bg-primary/5 ring-2 ring-inset ring-primary/60" : ""}`}
                  data-testid={`card-submission-${sub.id}`}
                >
                  <button
                    type="button"
                    onClick={() => { setActiveIdx(idx); setSelectedSubmissionId(sub.id); }}
                    className="w-full text-left px-4 pt-4 pb-3 flex gap-3 items-start active:bg-primary/10 transition-colors"
                  >
                    <div className="w-16 h-16 rounded-lg bg-secondary overflow-hidden shrink-0">
                      <MaskedImage
                        src={`/api${thumb}`}
                        alt=""
                        regions={extractRegions(sub.aiIssuesJson)}
                        frameIndex={0}
                        className="w-full h-full"
                        imgClassName="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-[14px] truncate">{sub.areaName}</p>
                        <ScorePill percent={sub.scoreTotal * 4} />
                      </div>
                      <p className="text-[12.5px] text-muted-foreground">
                        Shift {sub.shift} · <span className="tabular-nums">{format(new Date(sub.createdAt), "MMM d, HH:mm")}</span>
                      </p>
                      <p className="text-[12px] text-muted-foreground truncate">{sub.userEmail}</p>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        <MediaTypeBadge type={sub.mediaType} />
                        <ScoringModeBadge mode={sub.scoringMode} />
                      </div>
                    </div>
                  </button>
                  {isManager && (
                    <div className="flex gap-2 px-4 pb-4">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-full h-10 text-[12px] flex-1"
                        disabled={quickApprove.isPending}
                        onClick={(e) => { e.stopPropagation(); handleApprove(sub.id); }}
                        data-testid={`button-approve-mobile-${sub.id}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-full h-10 text-[12px] flex-1 bg-secondary/60"
                        onClick={(e) => { e.stopPropagation(); openWithLabelForm(sub.id); }}
                        data-testid={`button-needswork-mobile-${sub.id}`}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" /> Needs work
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Desktop: original table. Hidden below the small breakpoint. */}
      <div className="hidden sm:block bg-card rounded-2xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="font-medium px-5 py-3.5 w-[88px]">Capture</th>
                <th className="font-medium px-3 py-3.5">Area</th>
                <th className="font-medium px-3 py-3.5">Shift</th>
                <th className="font-medium px-3 py-3.5">Score</th>
                <th className="font-medium px-3 py-3.5">Type</th>
                <th className="font-medium px-3 py-3.5">Time</th>
                <th className="font-medium px-3 py-3.5">Operator</th>
                {isManager && <th className="font-medium px-3 py-3.5 pr-5 text-right">Quick label</th>}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={isManager ? 8 : 7} className="h-32 text-center text-muted-foreground">Loading submissions…</td></tr>
              ) : submissions?.length === 0 ? (
                <tr><td colSpan={isManager ? 8 : 7} className="h-32 text-center text-muted-foreground">No submissions found matching criteria.</td></tr>
              ) : (
                submissions?.map((sub, idx) => {
                  const thumb = sub.mediaType === "video" && sub.keyframesJson?.[0] ? sub.keyframesJson[0] : sub.imageUrl;
                  const isActive = activeIdx === idx;
                  return (
                    <tr
                      key={sub.id}
                      ref={(el) => { rowRefs.current[idx] = el; }}
                      className={`cursor-pointer transition-all duration-150 ${idx % 2 === 1 ? "bg-secondary/40" : ""} ${isActive ? "ring-2 ring-inset ring-primary/60 bg-primary/5" : "hover:bg-primary/5"} active:bg-primary/10 active:scale-[0.997] motion-reduce:active:scale-100 motion-reduce:transition-none`}
                      onClick={() => { setActiveIdx(idx); setSelectedSubmissionId(sub.id); }}
                      data-testid={`row-submission-${sub.id}`}
                    >
                      <td className="px-5 py-3">
                        <div className="w-16 h-12 rounded-lg bg-secondary overflow-hidden">
                          <MaskedImage
                            src={`/api${thumb}`}
                            alt=""
                            regions={extractRegions(sub.aiIssuesJson)}
                            frameIndex={0}
                            className="w-full h-full"
                            imgClassName="w-full h-full object-cover"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-3 font-medium">{sub.areaName}</td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold bg-secondary text-foreground/80">{sub.shift}</span>
                      </td>
                      <td className="px-3 py-3"><ScorePill percent={sub.scoreTotal * 4} /></td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          <MediaTypeBadge type={sub.mediaType} />
                          <ScoringModeBadge mode={sub.scoringMode} />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground tabular-nums">{format(new Date(sub.createdAt), "MMM d, HH:mm")}</td>
                      <td className="px-3 py-3 text-muted-foreground">{sub.userEmail}</td>
                      {isManager && (
                        <td className="px-3 py-3 pr-5">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-full h-10 text-[12px] px-3"
                              disabled={quickApprove.isPending}
                              onClick={(e) => { e.stopPropagation(); handleApprove(sub.id); }}
                              data-testid={`button-approve-${sub.id}`}
                              title="Approve as-is (g)"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="rounded-full h-10 text-[12px] px-3"
                              onClick={(e) => { e.stopPropagation(); openWithLabelForm(sub.id); }}
                              data-testid={`button-needswork-${sub.id}`}
                              title="Needs work (r)"
                            >
                              <Pencil className="w-3.5 h-3.5 mr-1" /> Needs work
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={!!selectedSubmissionId}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSubmissionId(null);
            setAutoFocusLabelForm(false);
          }
        }}
      >
        {selectedSubmissionId && (
          <SubmissionDetail submissionId={selectedSubmissionId} autoFocusLabelForm={autoFocusLabelForm} />
        )}
      </Dialog>

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
