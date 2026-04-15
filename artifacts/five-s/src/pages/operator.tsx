import { useGetCurrentShift, useGetOperatorStatus, useCreateSubmission, AreaStatus, getGetOperatorStatusQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useState, useRef } from "react";
import { Camera, Upload, CheckCircle2, AlertTriangle, ArrowRight, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { format } from "date-fns";

export default function OperatorHome() {
  const { data: shift, isLoading: shiftLoading } = useGetCurrentShift();
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus();
  
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
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Active Shift</h1>
          {shift && (
            <p className="text-muted-foreground mt-1 font-mono">
              Shift {shift.shift} ({shift.startTime} - {shift.endTime})
            </p>
          )}
        </div>
        <div className="px-4 py-2 bg-primary/10 text-primary font-bold rounded-lg border border-primary/20">
          {statuses?.filter(s => s.submitted).length || 0} / {statuses?.length || 0} COMPLETED
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold tracking-tight border-b pb-2">Assigned Areas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {statuses?.map((status) => (
            <AreaCard key={status.areaId} status={status} />
          ))}
          {statuses?.length === 0 && (
            <p className="text-muted-foreground py-8 text-center col-span-full">No areas assigned for this shift.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function AreaCard({ status }: { status: AreaStatus }) {
  const [isSubmitOpen, setIsSubmitOpen] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const createSubmission = useCreateSubmission();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhoto(file);
      setPreviewUrl(URL.createObjectURL(file));
      setIsSubmitOpen(true);
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

    createSubmission.mutate({
      data: {
        areaId: status.areaId,
        photo: photo,
      } as any, // TypeScript expects Blob but File extends Blob
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
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Submission failed",
          description: "There was an error uploading the photo. Please try again.",
        });
      }
    });
  };

  if (status.submitted && status.submission) {
    const scoreColor = status.submission.scoreTotal >= 20 ? "text-green-600 bg-green-50 border-green-200" 
      : status.submission.scoreTotal >= 15 ? "text-yellow-600 bg-yellow-50 border-yellow-200" 
      : "text-red-600 bg-red-50 border-red-200";

    return (
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
        </CardContent>
      </Card>
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
              disabled={createSubmission.isPending}
            >
              {createSubmission.isPending ? "Scoring..." : "Submit for Score"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
