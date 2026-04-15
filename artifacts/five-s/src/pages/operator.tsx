import { useGetCurrentShift, useGetOperatorStatus, useCreateSubmission, useReuploadSubmission, AreaStatus, getGetOperatorStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useRef } from "react";
import { Camera, Upload, CheckCircle2, AlertTriangle, ArrowRight, Info, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { format } from "date-fns";

const SHIFT_OPTIONS = [
  { value: "A" as const, label: "Shift A (6 AM – 2 PM)" },
  { value: "B" as const, label: "Shift B (2 PM – 10 PM)" },
  { value: "C" as const, label: "Shift C (10 PM – 6 AM)" },
];

export default function OperatorHome() {
  const { data: currentShift, isLoading: shiftLoading } = useGetCurrentShift();
  const [selectedShift, setSelectedShift] = useState<"A" | "B" | "C" | null>(null);

  const activeShift = selectedShift ?? currentShift?.shift ?? "A";
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus(
    { shift: activeShift as "A" | "B" | "C" },
  );

  if (shiftLoading || statusLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20">
      <div className="bg-white p-6 rounded-xl border border-border shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Active Shift</h1>
          <div className="mt-2">
            <select
              value={activeShift}
              onChange={(e) => setSelectedShift(e.target.value as "A" | "B" | "C")}
              className="px-3 py-2 border border-border rounded-lg bg-white text-sm font-mono font-medium focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {SHIFT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{currentShift?.shift === opt.value ? " (current)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="px-4 py-2 bg-primary/10 text-primary font-bold rounded-lg border border-primary/20">
          {statuses?.filter(s => s.submitted).length || 0} / {statuses?.length || 0} COMPLETED
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold tracking-tight border-b pb-2">Assigned Areas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {statuses?.map((status) => (
            <AreaCard key={status.areaId} status={status} selectedShift={activeShift} />
          ))}
          {statuses?.length === 0 && (
            <p className="text-muted-foreground py-8 text-center col-span-full">No areas assigned for this shift.</p>
          )}
        </div>
      </div>
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
            title: "Submission successful",
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
    const scoreColor = status.submission.scoreTotal >= 20 ? "text-green-600 bg-green-50 border-green-200" 
      : status.submission.scoreTotal >= 15 ? "text-yellow-600 bg-yellow-50 border-yellow-200" 
      : "text-red-600 bg-red-50 border-red-200";

    return (
      <>
      <Card className="border-border shadow-sm overflow-hidden flex flex-col h-full">
        <div className="h-48 overflow-hidden bg-muted relative">
          <img 
            src={`/api${status.submission.imageUrl}`} 
            alt={status.areaName} 
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <div className="absolute bottom-4 left-4 right-4 text-white">
            <h3 className="font-bold text-xl">{status.areaName}</h3>
            <p className="text-sm opacity-90">{format(new Date(status.submission.createdAt), "h:mm a")}</p>
          </div>
        </div>
        <CardContent className="p-0 flex-1 flex flex-col">
          <div className="p-4 border-b border-border flex justify-between items-center">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              <span className="font-bold text-green-600 uppercase tracking-wider text-sm">Completed</span>
            </div>
            <div className={`px-3 py-1 rounded-full border font-bold ${scoreColor}`}>
              SCORE: {status.submission.scoreTotal}/25
            </div>
          </div>
          <div className="p-4 bg-gray-50 flex-1">
            <h4 className="text-sm font-bold text-muted-foreground uppercase mb-3 flex items-center gap-1">
              <Info className="w-4 h-4" /> Action Items
            </h4>
            <ul className="space-y-2">
              {status.submission.suggestionsJson?.map((suggestion, i) => (
                <li key={i} className="text-sm flex gap-2 items-start bg-white p-3 rounded-md border border-border">
                  <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span className="leading-snug">{suggestion}</span>
                </li>
              ))}
              {(!status.submission.suggestionsJson || status.submission.suggestionsJson.length === 0) && (
                <li className="text-sm text-muted-foreground italic bg-white p-3 rounded-md border border-border">No immediate action required.</li>
              )}
            </ul>
          </div>
          <div className="p-4 border-t border-border">
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
                className="flex-1 font-semibold"
                onClick={openReuploadCamera}
              >
                <Camera className="w-4 h-4 mr-2" />
                Retake Photo
              </Button>
              <Button
                variant="outline"
                className="flex-1 font-semibold"
                onClick={openReuploadGallery}
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                Re-upload
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={isSubmitOpen && isReuploadMode} onOpenChange={setIsSubmitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Re-upload Photo for {status.areaName}</DialogTitle>
            <DialogDescription>
              This will replace the current photo and re-score the submission.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 my-4">
            {previewUrl && (
              <div className="rounded-lg overflow-hidden border border-border bg-black/5">
                <img src={previewUrl} alt="Preview" className="w-full h-64 object-contain" />
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => { setIsSubmitOpen(false); setIsReuploadMode(false); }}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={handleSubmit}
              disabled={isMutating}
            >
              {isMutating ? "Scoring..." : "Re-submit for Score"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </>
    );
  }

  return (
    <>
      <Card className="border-border shadow-sm flex flex-col h-full hover:border-primary/50 transition-colors">
        <CardHeader className="pb-4">
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="text-xl">{status.areaName}</CardTitle>
              <CardDescription className="mt-1 flex items-center gap-1.5 text-orange-600 font-medium">
                <AlertTriangle className="w-4 h-4" />
                Needs Submission
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="mt-auto pt-0 pb-6 space-y-3">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileSelect}
          />
          <Button 
            className="w-full h-16 text-lg font-bold shadow-sm" 
            onClick={openCamera}
          >
            <Camera className="w-6 h-6 mr-2" />
            TAKE PHOTO
          </Button>
          <Button 
            variant="outline" 
            className="w-full h-14 font-semibold border-2" 
            onClick={openGallery}
          >
            <Upload className="w-5 h-5 mr-2" />
            UPLOAD FILE
          </Button>
        </CardContent>
      </Card>

      <Dialog open={isSubmitOpen} onOpenChange={setIsSubmitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit Photo for {status.areaName}</DialogTitle>
            <DialogDescription>
              Review the photo before submitting for 5S scoring.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 my-4">
            {previewUrl && (
              <div className="rounded-lg overflow-hidden border border-border bg-black/5">
                <img src={previewUrl} alt="Preview" className="w-full h-64 object-contain" />
              </div>
            )}
          </div>
          
          <div className="flex gap-3">
            <Button variant="outline" className="flex-1" onClick={() => setIsSubmitOpen(false)}>
              Cancel
            </Button>
            <Button 
              className="flex-1" 
              onClick={handleSubmit} 
              disabled={isMutating}
            >
              {isMutating ? "Scoring..." : "Submit for Score"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
