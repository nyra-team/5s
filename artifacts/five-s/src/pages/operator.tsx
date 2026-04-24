import {
  useGetCurrentShift,
  useGetOperatorStatus,
  useCreateSubmission,
  useReuploadSubmission,
  useGetNextChecks,
  AreaStatus,
  getGetOperatorStatusQueryKey,
  getGetNextChecksQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useRef, useEffect } from "react";
import {
  Camera, Upload, CheckCircle2, AlertTriangle, ArrowRight, Info, RefreshCw, Video, Clock, Bell, Tag,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";

const SHIFT_OPTIONS = [
  { value: "A" as const, label: "Shift A", time: "6 AM – 2 PM" },
  { value: "B" as const, label: "Shift B", time: "2 PM – 10 PM" },
  { value: "C" as const, label: "Shift C", time: "10 PM – 6 AM" },
];

function scoreTone(percent: number) {
  if (percent >= 80)
    return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-500/15" };
  if (percent >= 60)
    return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-500/15" };
  return { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-50 dark:bg-rose-500/15" };
}

export default function OperatorHome() {
  const { data: currentShift, isLoading: shiftLoading } = useGetCurrentShift();
  const [selectedShift, setSelectedShift] = useState<"A" | "B" | "C" | null>(null);
  const activeShift = selectedShift ?? currentShift?.shift ?? "A";
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus({ shift: activeShift as "A" | "B" | "C" });
  const { data: nextChecks } = useGetNextChecks({
    query: { refetchInterval: 60_000, queryKey: getGetNextChecksQueryKey() },
  });
  const { toast } = useToast();

  // Detect transitions: when a previously not-overdue check becomes overdue, surface a toast.
  // Uses a ref of last-known overdue keys (areaId|machine) and a tick interval so transitions
  // are noticed even between server refetches.
  const knownOverdueRef = useRef<Set<string>>(new Set());
  const announcedRef = useRef<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
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

  if (shiftLoading || statusLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const completed = statuses?.filter(s => s.submitted).length || 0;
  const total = statuses?.length || 0;

  return (
    <div className="space-y-10 pb-20">
      <header className="space-y-6">
        <div className="space-y-2">
          <p className="eyebrow">Today</p>
          <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Active shift</h1>
          <p className="text-muted-foreground text-[15px]">{completed} of {total} areas submitted</p>
        </div>

        <div role="tablist" className="inline-flex p-1 pill-track rounded-full">
          {SHIFT_OPTIONS.map((opt) => {
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
                  <motion.span layoutId="shift-tab-pill" className="absolute inset-0 pill-thumb-bg rounded-full shadow-soft" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
                )}
                <span className="relative z-10 inline-flex items-center">
                  {opt.label}
                  <span className="ml-1.5 opacity-60 hidden sm:inline">{opt.time}</span>
                  {isCurrent && (
                    <span className={`ml-2 inline-flex items-center w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-emerald-400"}`} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      {nextChecks && nextChecks.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold tracking-tight inline-flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" /> Next checks
            </h2>
            <span className="text-[12.5px] text-muted-foreground">Cadence learned from past audits</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {nextChecks.slice(0, 6).map((nc) => (
              <div
                key={nc.areaId}
                className={`rounded-2xl p-4 shadow-soft flex flex-col gap-1 ${
                  nc.overdue ? "bg-rose-50 dark:bg-rose-500/10" : "bg-card"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-[14px] tracking-tight">{nc.areaName}</p>
                    {nc.machine && <p className="text-[12px] text-muted-foreground">{nc.machine}</p>}
                  </div>
                  <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    nc.overdue
                      ? "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200"
                      : "bg-secondary text-foreground/70"
                  }`}>
                    <Clock className="w-3 h-3" />
                    {nc.overdue ? "Overdue" : `in ${formatDistanceToNowStrict(new Date(nc.nextDueAt))}`}
                  </span>
                </div>
                <p className="text-[12.5px] text-muted-foreground leading-snug">{nc.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-5">
        <h2 className="text-xl font-semibold tracking-tight">Assigned areas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <AnimatePresence mode="popLayout" initial={false}>
            {statuses?.map((status) => (
              <motion.div
                key={`${status.areaId}-${status.submitted ? "done" : "pending"}`}
                layout
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
              >
                <AreaCard status={status} selectedShift={activeShift} />
              </motion.div>
            ))}
          </AnimatePresence>
          {statuses?.length === 0 && (
            <p className="text-muted-foreground py-12 text-center col-span-full">No areas assigned for this shift.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function AreaCard({ status, selectedShift }: { status: AreaStatus; selectedShift: "A" | "B" | "C" }) {
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [isReuploadMode, setIsReuploadMode] = useState(false);
  const [media, setMedia] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [machineTag, setMachineTag] = useState("");
  const videoInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const reuploadInputRef = useRef<HTMLInputElement>(null);

  const createSubmission = useCreateSubmission();
  const reuploadSubmission = useReuploadSubmission();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isVideo = (f: File | null) => !!f && f.type.startsWith("video/");

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMedia(file);
      setPreviewUrl(URL.createObjectURL(file));
      setIsReuploadMode(false);
      setIsSubmitOpen(true);
    }
  };

  const handleReuploadFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMedia(file);
      setPreviewUrl(URL.createObjectURL(file));
      setIsReuploadMode(true);
      setIsSubmitOpen(true);
    }
  };

  const openVideoCapture = () => {
    if (videoInputRef.current) {
      videoInputRef.current.setAttribute("capture", "environment");
      videoInputRef.current.click();
    }
  };
  const openVideoGallery = () => {
    if (videoInputRef.current) {
      videoInputRef.current.removeAttribute("capture");
      videoInputRef.current.click();
    }
  };
  const openPhotoFallback = () => {
    if (photoInputRef.current) {
      photoInputRef.current.setAttribute("capture", "environment");
      photoInputRef.current.click();
    }
  };

  const closeDialog = () => {
    setIsSubmitOpen(false);
    setIsReuploadMode(false);
    setMedia(null);
    setMachineTag("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
  };

  const onSuccess = (msg: string) => {
    toast({ title: msg, description: isVideo(media) ? "Walk-through scored across keyframes." : "Photo scored." });
    queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetNextChecksQueryKey() });
    closeDialog();
  };

  const handleSubmit = () => {
    if (!media) return;
    const tag = machineTag.trim() || undefined;
    if (isReuploadMode && status.submission) {
      reuploadSubmission.mutate({
        id: status.submission.id,
        data: { media: media as Blob, shift: selectedShift, machineTag: tag },
      }, {
        onSuccess: () => onSuccess("Walk-through re-uploaded"),
        onError: () => toast({ variant: "destructive", title: "Re-upload failed", description: "There was an error uploading. Please try again." }),
      });
    } else {
      createSubmission.mutate({
        data: { areaId: status.areaId, media: media as Blob, shift: selectedShift, machineTag: tag },
      }, {
        onSuccess: () => onSuccess("Submitted"),
        onError: () => toast({ variant: "destructive", title: "Submission failed", description: "There was an error uploading. Please try again." }),
      });
    }
  };

  const isMutating = createSubmission.isPending || reuploadSubmission.isPending;

  if (status.submitted && status.submission) {
    const scorePercent = status.submission.scoreTotal * 4;
    const tone = scoreTone(scorePercent);
    const sub = status.submission;
    const isVideoSub = sub.mediaType === "video";

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
          <div className="px-5 pt-4 pb-2 flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-[18px] h-[18px]" />
            <span className="text-[13px] font-semibold">Completed</span>
            {sub.machineTag && (
              <span className="ml-2 text-[11.5px] inline-flex items-center gap-1 text-muted-foreground">
                <Tag className="w-3 h-3" /> {sub.machineTag}
              </span>
            )}
          </div>
          <div className="px-5 pb-5 flex-1">
            <p className="eyebrow flex items-center gap-1.5 mb-3"><Info className="w-3 h-3" /> Action items</p>
            <ul className="space-y-2">
              {sub.suggestionsJson?.map((s, i) => (
                <li key={i} className="text-[13.5px] flex gap-2 items-start bg-secondary/60 p-3 rounded-xl">
                  <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span className="leading-snug text-foreground/90">{s}</span>
                </li>
              ))}
              {(!sub.suggestionsJson || sub.suggestionsJson.length === 0) && (
                <li className="text-[13.5px] text-muted-foreground italic bg-secondary/60 p-3 rounded-xl">No immediate action required.</li>
              )}
            </ul>
          </div>
          <div className="p-4 border-t border-border/70">
            <input type="file" accept="video/*,image/*" className="hidden" ref={reuploadInputRef} onChange={handleReuploadFileSelect} />
            <Button variant="outline" className="w-full rounded-xl h-11" onClick={() => reuploadInputRef.current?.click()}>
              <RefreshCw className="w-4 h-4 mr-2" /> Re-capture
            </Button>
          </div>
        </div>

        <Dialog open={isSubmitOpen && isReuploadMode} onOpenChange={(o) => !o && closeDialog()}>
          <DialogContent className="sm:max-w-md rounded-2xl">
            <DialogHeader>
              <DialogTitle className="text-xl">Re-capture for {status.areaName}</DialogTitle>
              <DialogDescription>This will replace the current capture and re-score the submission.</DialogDescription>
            </DialogHeader>
            <SubmitDialogBody previewUrl={previewUrl} media={media} machineTag={machineTag} setMachineTag={setMachineTag} />
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={closeDialog}>Cancel</Button>
              <Button className="flex-1 rounded-xl h-11" onClick={handleSubmit} disabled={isMutating}>
                {isMutating ? "Scoring…" : "Re-submit"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <div className="bg-card rounded-2xl shadow-elevated p-6 flex flex-col h-full transition-all duration-150 hover:shadow-floating active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none">
        <div className="flex justify-between items-start gap-3">
          <div>
            <h3 className="text-[19px] font-semibold tracking-tight">{status.areaName}</h3>
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-1 rounded-full">
              <AlertTriangle className="w-3.5 h-3.5" /> Pending submission
            </p>
          </div>
        </div>

        <div className="mt-auto pt-8 space-y-2.5">
          <input type="file" accept="video/*" className="hidden" ref={videoInputRef} onChange={handleFileSelect} />
          <input type="file" accept="image/*" className="hidden" ref={photoInputRef} onChange={handleFileSelect} />
          <Button className="w-full h-14 text-[15px] font-semibold rounded-xl shadow-soft" onClick={openVideoCapture}>
            <Video className="w-5 h-5 mr-2" /> Record walk-through
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={openVideoGallery}>
              <Upload className="w-4 h-4 mr-2" /> Upload video
            </Button>
            <Button variant="outline" className="flex-1 h-11 rounded-xl" onClick={openPhotoFallback}>
              <Camera className="w-4 h-4 mr-2" /> Photo only
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={isSubmitOpen && !isReuploadMode} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Submit capture for {status.areaName}</DialogTitle>
            <DialogDescription>
              {isVideo(media) ? "The video will be sampled into 6 keyframes for AI auditing." : "Single photos work too — videos are preferred."}
            </DialogDescription>
          </DialogHeader>
          <SubmitDialogBody previewUrl={previewUrl} media={media} machineTag={machineTag} setMachineTag={setMachineTag} />
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={closeDialog}>Cancel</Button>
            <Button className="flex-1 rounded-xl h-11" onClick={handleSubmit} disabled={isMutating}>
              {isMutating ? "Scoring…" : "Submit"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SubmitDialogBody({
  previewUrl, media, machineTag, setMachineTag,
}: {
  previewUrl: string | null;
  media: File | null;
  machineTag: string;
  setMachineTag: (v: string) => void;
}) {
  const isVideo = !!media && media.type.startsWith("video/");
  return (
    <div className="space-y-4 my-2">
      {previewUrl && (
        <div className="rounded-xl overflow-hidden bg-secondary/60">
          {isVideo ? (
            <video src={previewUrl} controls className="w-full max-h-72" />
          ) : (
            <img src={previewUrl} alt="Preview" className="w-full h-64 object-contain" />
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <label className="eyebrow inline-flex items-center gap-1.5"><Tag className="w-3 h-3" /> Machine / sub-area (optional)</label>
        <Input
          value={machineTag}
          onChange={(e) => setMachineTag(e.target.value)}
          placeholder="e.g. Mixer #2"
          className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
          data-testid="input-machine-tag"
        />
      </div>
    </div>
  );
}
