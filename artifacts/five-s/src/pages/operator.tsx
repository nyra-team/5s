import { useGetCurrentShift, useGetOperatorStatus, useCreateSubmission, useReuploadSubmission, AreaStatus, getGetOperatorStatusQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useState, useRef } from "react";
import { Camera, Upload, CheckCircle2, AlertTriangle, ArrowRight, Info, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { format } from "date-fns";
import { motion } from "framer-motion";

const SHIFT_OPTIONS = [
  { value: "A" as const, label: "Shift A", time: "6 AM – 2 PM" },
  { value: "B" as const, label: "Shift B", time: "2 PM – 10 PM" },
  { value: "C" as const, label: "Shift C", time: "10 PM – 6 AM" },
];

function scoreTone(percent: number) {
  if (percent >= 80)
    return {
      text: "text-emerald-700 dark:text-emerald-300",
      bg: "bg-emerald-50 dark:bg-emerald-500/15",
      border: "border-emerald-100 dark:border-emerald-500/20",
    };
  if (percent >= 60)
    return {
      text: "text-amber-700 dark:text-amber-300",
      bg: "bg-amber-50 dark:bg-amber-500/15",
      border: "border-amber-100 dark:border-amber-500/20",
    };
  return {
    text: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-500/15",
    border: "border-rose-100 dark:border-rose-500/20",
  };
}

export default function OperatorHome() {
  const { data: currentShift, isLoading: shiftLoading } = useGetCurrentShift();
  const [selectedShift, setSelectedShift] = useState<"A" | "B" | "C" | null>(null);

  const activeShift = selectedShift ?? currentShift?.shift ?? "A";
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus(
    { shift: activeShift as "A" | "B" | "C" },
  );

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
          <p className="text-muted-foreground text-[15px]">
            {completed} of {total} areas submitted
          </p>
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
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
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
                    <span className={`ml-2 inline-flex items-center w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-emerald-400"}`} />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <section className="space-y-5">
        <h2 className="text-xl font-semibold tracking-tight">Assigned areas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {statuses?.map((status) => (
            <AreaCard key={status.areaId} status={status} selectedShift={activeShift} />
          ))}
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
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reuploadInputRef = useRef<HTMLInputElement>(null);

  const createSubmission = useCreateSubmission();
  const reuploadSubmission = useReuploadSubmission();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhoto(file);
      setPreviewUrl(URL.createObjectURL(file));
      setIsReuploadMode(false);
      setIsSubmitOpen(true);
    }
  };

  const handleReuploadFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhoto(file);
      setPreviewUrl(URL.createObjectURL(file));
      setIsReuploadMode(true);
      setIsSubmitOpen(true);
    }
  };

  const openReuploadCamera = () => {
    if (reuploadInputRef.current) {
      reuploadInputRef.current.setAttribute("capture", "environment");
      reuploadInputRef.current.click();
    }
  };

  const openReuploadGallery = () => {
    if (reuploadInputRef.current) {
      reuploadInputRef.current.removeAttribute("capture");
      reuploadInputRef.current.click();
    }
  };

  const openCamera = () => {
    if (fileInputRef.current) {
      fileInputRef.current.setAttribute("capture", "environment");
      fileInputRef.current.click();
    }
  };

  const openGallery = () => {
    if (fileInputRef.current) {
      fileInputRef.current.removeAttribute("capture");
      fileInputRef.current.click();
    }
  };

  const handleSubmit = () => {
    if (!photo) return;

    if (isReuploadMode && status.submission) {
      reuploadSubmission.mutate({
        id: status.submission.id,
        data: { photo: photo as Blob, shift: selectedShift },
      }, {
        onSuccess: () => {
          toast({
            title: "Photo re-uploaded",
            description: "New photo submitted and re-scored.",
          });
          queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
          setIsSubmitOpen(false);
          setIsReuploadMode(false);
          setPhoto(null);
          setPreviewUrl(null);
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Re-upload failed",
            description: "There was an error re-uploading the photo. Please try again.",
          });
        }
      });
    } else {
      createSubmission.mutate({
        data: {
          areaId: status.areaId,
          photo: photo as Blob,
          shift: selectedShift,
        },
      }, {
        onSuccess: () => {
          toast({
            title: "Submitted",
            description: "Area photo submitted for scoring.",
          });
          queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
          setIsSubmitOpen(false);
          setPhoto(null);
          setPreviewUrl(null);
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Submission failed",
            description: "There was an error uploading the photo. Please try again.",
          });
        }
      });
    }
  };

  const isMutating = createSubmission.isPending || reuploadSubmission.isPending;

  if (status.submitted && status.submission) {
    const scorePercent = status.submission.scoreTotal * 4;
    const tone = scoreTone(scorePercent);

    return (
      <>
        <div className="bg-card rounded-2xl shadow-elevated overflow-hidden flex flex-col transition-transform duration-150 active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none">
          <div className="aspect-[16/10] overflow-hidden bg-muted relative">
            <img
              src={`/api${status.submission.imageUrl}`}
              alt={status.areaName}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />
            <div className="absolute bottom-4 left-5 right-5 text-white flex items-end justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[19px] tracking-tight">{status.areaName}</h3>
                <p className="text-[13px] opacity-85">Submitted {format(new Date(status.submission.createdAt), "h:mm a")}</p>
              </div>
              <motion.div
                key={status.submission.id}
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
          </div>
          <div className="px-5 pb-5 flex-1">
            <p className="eyebrow flex items-center gap-1.5 mb-3">
              <Info className="w-3 h-3" /> Action items
            </p>
            <ul className="space-y-2">
              {status.submission.suggestionsJson?.map((suggestion, i) => (
                <li key={i} className="text-[13.5px] flex gap-2 items-start bg-secondary/60 p-3 rounded-xl">
                  <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span className="leading-snug text-foreground/90">{suggestion}</span>
                </li>
              ))}
              {(!status.submission.suggestionsJson || status.submission.suggestionsJson.length === 0) && (
                <li className="text-[13.5px] text-muted-foreground italic bg-secondary/60 p-3 rounded-xl">No immediate action required.</li>
              )}
            </ul>
          </div>
          <div className="p-4 border-t border-border/70">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              ref={reuploadInputRef}
              onChange={handleReuploadFileSelect}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-xl h-11"
                onClick={openReuploadCamera}
              >
                <Camera className="w-4 h-4 mr-2" />
                Retake
              </Button>
              <Button
                variant="outline"
                className="flex-1 rounded-xl h-11"
                onClick={openReuploadGallery}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Re-upload
              </Button>
            </div>
          </div>
        </div>

        <Dialog open={isSubmitOpen && isReuploadMode} onOpenChange={setIsSubmitOpen}>
          <DialogContent className="sm:max-w-md rounded-2xl">
            <DialogHeader>
              <DialogTitle className="text-xl">Re-upload for {status.areaName}</DialogTitle>
              <DialogDescription>
                This will replace the current photo and re-score the submission.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 my-2">
              {previewUrl && (
                <div className="rounded-xl overflow-hidden bg-secondary/60">
                  <img src={previewUrl} alt="Preview" className="w-full h-64 object-contain" />
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={() => { setIsSubmitOpen(false); setIsReuploadMode(false); }}>
                Cancel
              </Button>
              <Button
                className="flex-1 rounded-xl h-11"
                onClick={handleSubmit}
                disabled={isMutating}
              >
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
              <AlertTriangle className="w-3.5 h-3.5" />
              Pending submission
            </p>
          </div>
        </div>

        <div className="mt-auto pt-8 space-y-2.5">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileSelect}
          />
          <Button
            className="w-full h-14 text-[15px] font-semibold rounded-xl shadow-soft"
            onClick={openCamera}
          >
            <Camera className="w-5 h-5 mr-2" />
            Take Photo
          </Button>
          <Button
            variant="outline"
            className="w-full h-12 text-[14px] font-medium rounded-xl"
            onClick={openGallery}
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload File
          </Button>
        </div>
      </div>

      <Dialog open={isSubmitOpen} onOpenChange={setIsSubmitOpen}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Submit photo for {status.areaName}</DialogTitle>
            <DialogDescription>
              Review the photo before submitting for 5S scoring.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-2">
            {previewUrl && (
              <div className="rounded-xl overflow-hidden bg-secondary/60">
                <img src={previewUrl} alt="Preview" className="w-full h-64 object-contain" />
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <Button variant="outline" className="flex-1 rounded-xl h-11" onClick={() => setIsSubmitOpen(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1 rounded-xl h-11"
              onClick={handleSubmit}
              disabled={isMutating}
            >
              {isMutating ? "Scoring…" : "Submit"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
