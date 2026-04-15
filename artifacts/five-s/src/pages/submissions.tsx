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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

function ScoringModeBadge({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  const colors: Record<string, string> = {
    CALIBRATED: "bg-green-100 text-green-800 border-green-200",
    SIMILARITY_ONLY: "bg-blue-100 text-blue-800 border-blue-200",
    FALLBACK: "bg-yellow-100 text-yellow-800 border-yellow-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded border ${colors[mode] || "bg-gray-100 text-gray-800"}`}
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
    pct >= 80 ? "bg-green-500" : pct >= 60 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex justify-between items-center">
      <span className="capitalize font-medium text-muted-foreground text-sm">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
          <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="font-bold w-8 text-right text-sm">
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
    <div className="border rounded-lg p-4 bg-amber-50/50 border-amber-200">
      <div className="flex items-center gap-2 mb-3">
        <Tag className="w-4 h-4 text-amber-600" />
        <h4 className="font-bold text-sm text-amber-800">
          {existingLabel ? "Update Label" : "Label This Submission"}
        </h4>
      </div>
      <p className="text-xs text-amber-700 mb-3">
        Assign ground-truth pillar scores to calibrate the AI model.
      </p>
      <div className="space-y-2">
        {Object.entries(pillars).map(([key, val]) => (
          <div key={key} className="flex items-center gap-3">
            <span className="capitalize text-xs font-medium w-20 text-right">
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
              className="flex-1 h-2 accent-amber-600"
            />
            <span className="text-xs font-bold w-4">{val}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs font-bold text-amber-800">
          Total: {Math.round(totalScore * 4)}%
        </span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={createLabel.isPending}
          className="bg-amber-600 hover:bg-amber-700 text-white"
        >
          {createLabel.isPending
            ? "Saving..."
            : existingLabel
              ? "Update"
              : "Save Label"}
        </Button>
      </div>
      {createLabel.isSuccess && (
        <p className="text-xs text-green-600 mt-2 font-medium">
          Label saved successfully!
        </p>
      )}
    </div>
  );
}

function SubmissionDetail({
  submissionId,
  onClose,
}: {
  submissionId: number;
  onClose: () => void;
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

  return (
    <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-2xl">{sub.areaName}</DialogTitle>
            <DialogDescription className="text-base mt-1">
              Submitted{" "}
              {format(new Date(sub.createdAt), "MMM d, yyyy 'at' h:mm a")} by{" "}
              {sub.userEmail} (Shift {sub.shift})
            </DialogDescription>
            <div className="flex gap-2 mt-2">
              <ScoringModeBadge mode={sub.scoringMode} />
              {sub.modelVersion && (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                  Model: {sub.modelVersion}
                </span>
              )}
            </div>
          </div>
          <div
            className={`px-4 py-2 rounded-lg border-2 font-bold text-xl ${
              sub.scoreTotal * 4 >= 80
                ? "text-green-600 border-green-200 bg-green-50"
                : sub.scoreTotal * 4 >= 60
                  ? "text-yellow-600 border-yellow-200 bg-yellow-50"
                  : "text-red-600 border-red-200 bg-red-50"
            }`}
          >
            {Math.round(sub.scoreTotal * 4)}%
          </div>
        </div>
      </DialogHeader>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <div className="rounded-xl overflow-hidden border-2 border-border shadow-sm">
            <img
              src={`/api${sub.imageUrl}`}
              alt="Submission"
              className="w-full h-auto object-contain bg-black/5"
            />
          </div>

          {idealPhotos && idealPhotos.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ImageIcon className="w-4 h-4 text-muted-foreground" />
                <h4 className="text-sm font-bold text-muted-foreground">
                  Ideal Reference Photos
                </h4>
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {idealPhotos.map((photo) => (
                  <div
                    key={photo.id}
                    className="w-20 h-16 rounded border border-border overflow-hidden shrink-0"
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
            <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
              <Gauge className="w-5 h-5 text-blue-600" />
              <div>
                <span className="text-sm font-bold text-blue-800">
                  Similarity to Ideal:{" "}
                  {(sub.similarityToIdeal * 100).toFixed(1)}%
                </span>
                <p className="text-xs text-blue-600">
                  Cosine similarity between CLIP embeddings
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div>
            <h3 className="font-bold text-lg border-b pb-2 mb-3">
              Score Breakdown
            </h3>
            <div className="space-y-2.5">
              {Object.entries(sub.scoreJson || {}).map(([key, value]) => (
                <PillarBar key={key} label={key} value={value as number} />
              ))}
            </div>
          </div>

          {hasAI &&
            sub.aiIssuesJson &&
            Array.isArray(sub.aiIssuesJson) &&
            sub.aiIssuesJson.length > 0 && (
              <div>
                <h3 className="font-bold text-lg border-b pb-2 mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  Issues Detected
                </h3>
                <ul className="space-y-2">
                  {sub.aiIssuesJson.map((issue: any, i: number) => (
                    <li
                      key={i}
                      className="p-3 rounded-lg border border-red-100 bg-red-50/50"
                    >
                      <div className="font-medium text-sm text-red-800">
                        {issue.issue}
                      </div>
                      <div className="text-xs text-red-600 mt-1">
                        {issue.evidence}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <MapPin className="w-3 h-3 text-red-400" />
                        <span className="text-xs text-red-500">
                          {issue.location}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {hasAI &&
            sub.aiRecommendationsJson &&
            Array.isArray(sub.aiRecommendationsJson) &&
            sub.aiRecommendationsJson.length > 0 && (
              <div>
                <h3 className="font-bold text-lg border-b pb-2 mb-3 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-primary" />
                  AI Recommendations
                </h3>
                <ul className="space-y-2">
                  {sub.aiRecommendationsJson.map((rec: any, i: number) => (
                    <li
                      key={i}
                      className="p-3 rounded-lg border border-blue-100 bg-blue-50/50"
                    >
                      <div className="font-medium text-sm text-blue-800">
                        {rec.action}
                      </div>
                      <div className="text-xs text-blue-600 mt-1">
                        {rec.why}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <MapPin className="w-3 h-3 text-blue-400" />
                        <span className="text-xs text-blue-500">
                          {rec.location}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {!hasAI && (
            <div>
              <h3 className="font-bold text-lg border-b pb-2 mb-3">
                Suggestions
              </h3>
              <ul className="space-y-2">
                {sub.suggestionsJson?.map((suggestion, i) => (
                  <li
                    key={i}
                    className="flex gap-2.5 items-start bg-secondary/5 p-3 rounded-lg border border-secondary/10"
                  >
                    <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span className="text-sm font-medium leading-relaxed">
                      {suggestion}
                    </span>
                  </li>
                ))}
                {(!sub.suggestionsJson ||
                  sub.suggestionsJson.length === 0) && (
                  <li className="text-muted-foreground italic flex items-center gap-2 p-3 bg-green-50 text-green-700 rounded-lg border border-green-100">
                    <CheckCircle2 className="w-5 h-5" /> No immediate
                    improvement suggestions.
                  </li>
                )}
              </ul>
            </div>
          )}

          <LabelForm submissionId={sub.id} existingLabel={myLabel} />

          {modelStatus && (
            <div className="border rounded-lg p-3 bg-muted/30">
              <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">
                Model Status for Area
              </h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">Labels:</span>{" "}
                  <span className="font-bold">{modelStatus.labelsCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Ideal Photos:</span>{" "}
                  <span className="font-bold">
                    {modelStatus.idealPhotosCount}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Submissions:</span>{" "}
                  <span className="font-bold">
                    {modelStatus.submissionsCount}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Can Train:</span>{" "}
                  <span
                    className={`font-bold ${modelStatus.canTrain ? "text-green-600" : "text-yellow-600"}`}
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
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground mt-1">
          Review 5S photo submissions across all shifts and areas.
        </p>
      </div>

      <Card className="border-border shadow-sm">
        <CardHeader className="bg-muted/30 border-b border-border pb-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">
                Date
              </Label>
              <Input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="bg-white"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">
                Shift
              </Label>
              <Select value={shiftFilter} onValueChange={setShiftFilter}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="All Shifts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Shifts</SelectItem>
                  <SelectItem value="A">Shift A</SelectItem>
                  <SelectItem value="B">Shift B</SelectItem>
                  <SelectItem value="C">Shift C</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">
                Area
              </Label>
              <Select value={areaFilter} onValueChange={setAreaFilter}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="All Areas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Areas</SelectItem>
                  {areas?.map((a) => (
                    <SelectItem key={a.id} value={a.id.toString()}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10 hover:bg-muted/10">
                  <TableHead className="font-bold">Photo</TableHead>
                  <TableHead className="font-bold">Area</TableHead>
                  <TableHead className="font-bold">Shift</TableHead>
                  <TableHead className="font-bold">Score</TableHead>
                  <TableHead className="font-bold">AI</TableHead>
                  <TableHead className="font-bold">Time</TableHead>
                  <TableHead className="font-bold">Operator</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground"
                    >
                      Loading submissions...
                    </TableCell>
                  </TableRow>
                ) : submissions?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground font-medium"
                    >
                      No submissions found matching criteria.
                    </TableCell>
                  </TableRow>
                ) : (
                  submissions?.map((sub) => (
                    <TableRow
                      key={sub.id}
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedSubmissionId(sub.id)}
                    >
                      <TableCell>
                        <div className="w-16 h-12 rounded bg-muted overflow-hidden border border-border">
                          <img
                            src={`/api${sub.imageUrl}`}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        </div>
                      </TableCell>
                      <TableCell className="font-bold">
                        {sub.areaName}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-md font-bold text-xs bg-secondary/10 text-secondary-foreground border border-secondary/20">
                          {sub.shift}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`font-bold ${sub.scoreTotal * 4 >= 80 ? "text-green-600" : sub.scoreTotal * 4 >= 60 ? "text-yellow-600" : "text-red-600"}`}
                        >
                          {Math.round(sub.scoreTotal * 4)}%
                        </span>
                      </TableCell>
                      <TableCell>
                        <ScoringModeBadge mode={sub.scoringMode} />
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {format(new Date(sub.createdAt), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {sub.userEmail}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={!!selectedSubmissionId}
        onOpenChange={(open) => !open && setSelectedSubmissionId(null)}
      >
        {selectedSubmissionId && (
          <SubmissionDetail
            submissionId={selectedSubmissionId}
            onClose={() => setSelectedSubmissionId(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
