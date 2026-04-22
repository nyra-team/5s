import {
  useListSubmissions,
  useListAreas,
  useGetSubmission,
  useGetLabels,
  useCreateLabel,
  useGetAreaModelStatus,
  useGetIdealPhotos,
} from "@workspace/api-client-react";
import { useState } from "react";
import { format } from "date-fns";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2,
  ArrowRight,
  Brain,
  AlertTriangle,
  MapPin,
  Gauge,
  Tag,
  Image as ImageIcon,
} from "lucide-react";

function scoreTone(percent: number) {
  if (percent >= 80) return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-500/15" };
  if (percent >= 60) return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-500/15" };
  return { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-50 dark:bg-rose-500/15" };
}

function ScorePill({ percent, size = "sm" }: { percent: number; size?: "sm" | "lg" }) {
  const tone = scoreTone(percent);
  const cls = size === "lg" ? "px-3.5 py-1.5 text-[15px]" : "px-2.5 py-0.5 text-[12px]";
  return (
    <span className={`inline-flex items-center font-semibold rounded-full ${cls} ${tone.bg} ${tone.text}`}>
      {Math.round(percent)}%
    </span>
  );
}

function ScoringModeBadge({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  const colors: Record<string, string> = {
    CALIBRATED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    SIMILARITY_ONLY: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    FALLBACK: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full ${colors[mode] || "bg-secondary text-foreground"}`}
    >
      <Brain className="w-3 h-3" />
      {mode}
    </span>
  );
}

function PillarBar({
  label,
  value,
  max = 5,
}: {
  label: string;
  value: number;
  max?: number;
}) {
  const pct = (value / max) * 100;
  const color =
    pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex justify-between items-center">
      <span className="capitalize font-medium text-foreground/80 text-[13px]">
        {label}
      </span>
      <div className="flex items-center gap-3">
        <div className="w-28 h-1.5 bg-secondary rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-semibold w-8 text-right text-[13px] tabular-nums">
          {value}/{max}
        </span>
      </div>
    </div>
  );
}

function LabelForm({
  submissionId,
  existingLabel,
}: {
  submissionId: number;
  existingLabel?: any;
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

  if (!isManager) return null;

  const totalScore = Object.values(pillars).reduce((a, b) => a + b, 0);

  const handleSubmit = () => {
    createLabel.mutate({
      data: { submissionId, pillarsJson: pillars as any, totalScore },
    });
  };

  return (
    <div className="rounded-2xl p-5 bg-amber-50/70 dark:bg-amber-500/10">
      <div className="flex items-center gap-2 mb-2">
        <Tag className="w-4 h-4 text-amber-700 dark:text-amber-300" />
        <h4 className="font-semibold text-[14px] text-amber-900 dark:text-amber-200">
          {existingLabel ? "Update label" : "Label this submission"}
        </h4>
      </div>
      <p className="text-[12.5px] text-amber-800/80 dark:text-amber-300/80 mb-4">
        Assign ground-truth pillar scores to calibrate the AI model.
      </p>
      <div className="space-y-2.5">
        {Object.entries(pillars).map(([key, val]) => (
          <div key={key} className="flex items-center gap-3">
            <span className="capitalize text-[12.5px] font-medium w-20 text-right text-amber-900 dark:text-amber-200">
              {key}
            </span>
            <input
              type="range"
              min={0}
              max={5}
              value={val}
              onChange={(e) =>
                setPillars((p) => ({ ...p, [key]: parseInt(e.target.value) }))
              }
              className="flex-1 h-1.5 accent-amber-600 dark:accent-amber-400"
            />
            <span className="text-[12.5px] font-semibold w-4 tabular-nums">{val}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-4">
        <span className="text-[12.5px] font-semibold text-amber-900 dark:text-amber-200">
          Total: {Math.round(totalScore * 4)}%
        </span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={createLabel.isPending}
          className="bg-amber-600 hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400 text-white rounded-full"
        >
          {createLabel.isPending
            ? "Saving…"
            : existingLabel
              ? "Update"
              : "Save label"}
        </Button>
      </div>
      {createLabel.isSuccess && (
        <p className="text-[12.5px] text-emerald-700 dark:text-emerald-300 mt-2 font-medium">
          Label saved successfully.
        </p>
      )}
    </div>
  );
}

function SubmissionDetail({
  submissionId,
}: {
  submissionId: number;
}) {
  const { data: sub } = useGetSubmission(submissionId);
  const { data: labels } = useGetLabels(submissionId);
  const { data: idealPhotos } = useGetIdealPhotos(sub?.areaId ?? 0, {
    query: { enabled: !!sub?.areaId },
  });
  const { data: modelStatus } = useGetAreaModelStatus(sub?.areaId ?? 0, {
    query: { enabled: !!sub?.areaId },
  });

  if (!sub) return null;

  const myLabel = labels?.[0];
  const hasAI = !!sub.scoringMode;
  const scorePercent = sub.scoreTotal * 4;

  return (
    <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl p-0">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* Image-left column */}
        <div className="bg-secondary/40 p-6 md:p-7 space-y-4 md:rounded-l-2xl">
          <div className="rounded-2xl overflow-hidden bg-black/5 shadow-soft">
            <img
              src={`/api${sub.imageUrl}`}
              alt="Submission"
              className="w-full h-auto object-contain"
            />
          </div>

          {idealPhotos && idealPhotos.length > 0 && (
            <div>
              <p className="eyebrow flex items-center gap-1.5 mb-2">
                <ImageIcon className="w-3 h-3" />
                Ideal references
              </p>
              <div className="flex gap-2 overflow-x-auto">
                {idealPhotos.map((photo) => (
                  <div
                    key={photo.id}
                    className="w-20 h-16 rounded-lg overflow-hidden shrink-0 bg-card shadow-soft"
                  >
                    <img
                      src={`/api${photo.imageUrl}`}
                      alt="Ideal"
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasAI && sub.similarityToIdeal !== null && sub.similarityToIdeal !== undefined && (
            <div className="flex items-center gap-3 p-3 bg-sky-50 dark:bg-sky-500/12 rounded-xl">
              <Gauge className="w-5 h-5 text-sky-700 dark:text-sky-300" />
              <div>
                <span className="text-[13px] font-semibold text-sky-900 dark:text-sky-200">
                  Similarity to ideal: {(sub.similarityToIdeal * 100).toFixed(1)}%
                </span>
                <p className="text-[12px] text-sky-700/80 dark:text-sky-300/80">
                  Cosine similarity between CLIP embeddings
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Details-right column */}
        <div className="p-6 md:p-7 space-y-6">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <DialogTitle className="text-2xl font-semibold tracking-tight">{sub.areaName}</DialogTitle>
                <DialogDescription className="text-[13px]">
                  {format(new Date(sub.createdAt), "MMM d, yyyy 'at' h:mm a")} · {sub.userEmail} · Shift {sub.shift}
                </DialogDescription>
              </div>
              <ScorePill percent={scorePercent} size="lg" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <ScoringModeBadge mode={sub.scoringMode} />
              {sub.modelVersion && (
                <span className="text-[11px] font-medium text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  Model: {sub.modelVersion}
                </span>
              )}
            </div>
          </DialogHeader>

          <section>
            <p className="eyebrow mb-3">Score breakdown</p>
            <div className="space-y-2.5">
              {Object.entries(sub.scoreJson || {}).map(([key, value]) => (
                <PillarBar key={key} label={key} value={value as number} />
              ))}
            </div>
          </section>

          {hasAI &&
            sub.aiIssuesJson &&
            Array.isArray(sub.aiIssuesJson) &&
            sub.aiIssuesJson.length > 0 && (
              <section>
                <p className="eyebrow mb-3 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-rose-500" />
                  Issues detected
                </p>
                <ul className="space-y-2">
                  {sub.aiIssuesJson.map((issue: any, i: number) => (
                    <li
                      key={i}
                      className="p-3 rounded-xl bg-rose-50/80 dark:bg-rose-500/12"
                    >
                      <div className="font-medium text-[13.5px] text-rose-900 dark:text-rose-200">
                        {issue.issue}
                      </div>
                      <div className="text-[12.5px] text-rose-800/80 dark:text-rose-300/85 mt-1">
                        {issue.evidence}
                      </div>
                      <div className="flex items-center gap-1 mt-1.5">
                        <MapPin className="w-3 h-3 text-rose-500 dark:text-rose-400" />
                        <span className="text-[12px] text-rose-600 dark:text-rose-300">
                          {issue.location}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

          {hasAI &&
            sub.aiRecommendationsJson &&
            Array.isArray(sub.aiRecommendationsJson) &&
            sub.aiRecommendationsJson.length > 0 && (
              <section>
                <p className="eyebrow mb-3 flex items-center gap-1.5">
                  <Brain className="w-3 h-3 text-primary" />
                  AI recommendations
                </p>
                <ul className="space-y-2">
                  {sub.aiRecommendationsJson.map((rec: any, i: number) => (
                    <li
                      key={i}
                      className="p-3 rounded-xl bg-sky-50/80 dark:bg-sky-500/12"
                    >
                      <div className="font-medium text-[13.5px] text-sky-900 dark:text-sky-200">
                        {rec.action}
                      </div>
                      <div className="text-[12.5px] text-sky-800/80 dark:text-sky-300/85 mt-1">
                        {rec.why}
                      </div>
                      <div className="flex items-center gap-1 mt-1.5">
                        <MapPin className="w-3 h-3 text-sky-500 dark:text-sky-400" />
                        <span className="text-[12px] text-sky-600 dark:text-sky-300">
                          {rec.location}
                        </span>
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
                {sub.suggestionsJson?.map((suggestion, i) => (
                  <li
                    key={i}
                    className="flex gap-2.5 items-start bg-secondary/60 p-3 rounded-xl"
                  >
                    <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span className="text-[13.5px] leading-relaxed">
                      {suggestion}
                    </span>
                  </li>
                ))}
                {(!sub.suggestionsJson ||
                  sub.suggestionsJson.length === 0) && (
                  <li className="text-[13.5px] flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 rounded-xl">
                    <CheckCircle2 className="w-4 h-4" /> No immediate
                    improvement suggestions.
                  </li>
                )}
              </ul>
            </section>
          )}

          <LabelForm submissionId={sub.id} existingLabel={myLabel} />

          {modelStatus && (
            <div className="rounded-xl p-4 bg-secondary/60">
              <p className="eyebrow mb-2.5">Model status</p>
              <div className="grid grid-cols-2 gap-2 text-[12.5px]">
                <div>
                  <span className="text-muted-foreground">Labels:</span>{" "}
                  <span className="font-semibold">{modelStatus.labelsCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Ideal photos:</span>{" "}
                  <span className="font-semibold">
                    {modelStatus.idealPhotosCount}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Submissions:</span>{" "}
                  <span className="font-semibold">
                    {modelStatus.submissionsCount}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Can train:</span>{" "}
                  <span
                    className={`font-semibold ${modelStatus.canTrain ? "text-emerald-600" : "text-amber-600"}`}
                  >
                    {modelStatus.canTrain
                      ? "Yes"
                      : `Need ${5 - modelStatus.labelsCount} more labels`}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

export default function Submissions() {
  const [shiftFilter, setShiftFilter] = useState<string>("");
  const [areaFilter, setAreaFilter] = useState<string>("");
  const [dateFilter, setDateFilter] = useState<string>("");
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<
    number | null
  >(null);

  const { data: areas } = useListAreas();
  const { data: submissions, isLoading } = useListSubmissions({
    shift: shiftFilter ? (shiftFilter as any) : undefined,
    areaId: areaFilter ? parseInt(areaFilter) : undefined,
    date: dateFilter ? dateFilter : undefined,
  });

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-2">
        <p className="eyebrow">History</p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Audit log</h1>
        <p className="text-muted-foreground text-[15px]">
          Review 5S photo submissions across all shifts and areas.
        </p>
      </header>

      <div className="bg-card rounded-2xl shadow-soft p-5 sm:p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label className="eyebrow">Date</Label>
          <Input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="h-11 rounded-xl bg-secondary/60 border-transparent"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="eyebrow">Shift</Label>
          <Select value={shiftFilter} onValueChange={setShiftFilter}>
            <SelectTrigger className="h-11 rounded-xl bg-secondary/60 border-transparent">
              <SelectValue placeholder="All shifts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All shifts</SelectItem>
              <SelectItem value="A">Shift A</SelectItem>
              <SelectItem value="B">Shift B</SelectItem>
              <SelectItem value="C">Shift C</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="eyebrow">Area</Label>
          <Select value={areaFilter} onValueChange={setAreaFilter}>
            <SelectTrigger className="h-11 rounded-xl bg-secondary/60 border-transparent">
              <SelectValue placeholder="All areas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {areas?.map((a) => (
                <SelectItem key={a.id} value={a.id.toString()}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="bg-card rounded-2xl shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="font-medium px-5 py-3.5 w-[88px]">Photo</th>
                <th className="font-medium px-3 py-3.5">Area</th>
                <th className="font-medium px-3 py-3.5">Shift</th>
                <th className="font-medium px-3 py-3.5">Score</th>
                <th className="font-medium px-3 py-3.5">AI</th>
                <th className="font-medium px-3 py-3.5">Time</th>
                <th className="font-medium px-3 py-3.5 pr-5">Operator</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="h-32 text-center text-muted-foreground">
                    Loading submissions…
                  </td>
                </tr>
              ) : submissions?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="h-32 text-center text-muted-foreground">
                    No submissions found matching criteria.
                  </td>
                </tr>
              ) : (
                submissions?.map((sub, idx) => (
                  <tr
                    key={sub.id}
                    className={`cursor-pointer transition-colors ${idx % 2 === 1 ? "bg-secondary/40" : ""} hover:bg-primary/5`}
                    onClick={() => setSelectedSubmissionId(sub.id)}
                  >
                    <td className="px-5 py-3">
                      <div className="w-16 h-12 rounded-lg bg-secondary overflow-hidden">
                        <img
                          src={`/api${sub.imageUrl}`}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 font-medium">{sub.areaName}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold bg-secondary text-foreground/80">
                        {sub.shift}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <ScorePill percent={sub.scoreTotal * 4} />
                    </td>
                    <td className="px-3 py-3">
                      <ScoringModeBadge mode={sub.scoringMode} />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground tabular-nums">
                      {format(new Date(sub.createdAt), "MMM d, HH:mm")}
                    </td>
                    <td className="px-3 py-3 pr-5 text-muted-foreground">
                      {sub.userEmail}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={!!selectedSubmissionId}
        onOpenChange={(open) => !open && setSelectedSubmissionId(null)}
      >
        {selectedSubmissionId && (
          <SubmissionDetail submissionId={selectedSubmissionId} />
        )}
      </Dialog>
    </div>
  );
}
