import { useListAreas, useGetIdealPhotos, useUploadIdealPhoto, Area, getGetIdealPhotosQueryKey } from "@workspace/api-client-react";
import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Image as ImageIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

export default function Areas() {
  const { data: areas, isLoading } = useListAreas();

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Area Management</h1>
        <p className="text-muted-foreground mt-1">Manage factory areas and reference photos for AI scoring.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {areas?.map((area) => (
          <AreaConfigCard key={area.id} area={area} />
        ))}
      </div>
    </div>
  );
}

function AreaConfigCard({ area }: { area: Area }) {
  const { data: idealPhotos, isLoading } = useGetIdealPhotos(area.id, {
    query: {
      enabled: !!area.id,
      queryKey: getGetIdealPhotosQueryKey(area.id)
    }
  });
  
  const uploadPhoto = useUploadIdealPhoto();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    uploadPhoto.mutate({
      id: area.id,
      data: { photo: file } as any // File extends Blob
    }, {
      onSuccess: () => {
        toast({
          title: "Reference photo uploaded",
          description: `New reference photo set for ${area.name}.`,
        });
        queryClient.invalidateQueries({ queryKey: getGetIdealPhotosQueryKey(area.id) });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Upload failed",
          description: "Failed to upload the reference photo.",
        });
      }
    });
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const latestPhoto = idealPhotos?.[0];

  return (
    <Card className="border-border shadow-sm flex flex-col">
      <CardHeader className="pb-4 border-b">
        <CardTitle className="text-xl">{area.name}</CardTitle>
        <CardDescription>ID: {area.id}</CardDescription>
      </CardHeader>
      <CardContent className="pt-6 flex-1 flex flex-col">
        <div className="mb-4">
          <h4 className="text-sm font-bold text-muted-foreground uppercase mb-3">Current Reference Photo</h4>
          {isLoading ? (
            <div className="h-48 bg-muted rounded-lg flex items-center justify-center animate-pulse"></div>
          ) : latestPhoto ? (
            <div className="rounded-lg overflow-hidden border border-border bg-muted">
              <img 
                src={`/api${latestPhoto.imageUrl}`} 
                alt={`Reference for ${area.name}`} 
                className="w-full h-48 object-cover" 
              />
              <div className="bg-secondary/10 p-2 text-xs font-medium text-secondary-foreground border-t border-border flex justify-between">
                <span>Active Reference</span>
                <span>Uploaded {format(new Date(latestPhoto.createdAt), "MMM d, yyyy")}</span>
              </div>
            </div>
          ) : (
            <div className="h-48 rounded-lg border-2 border-dashed border-border bg-muted/30 flex flex-col items-center justify-center text-muted-foreground">
              <ImageIcon className="w-10 h-10 mb-2 opacity-50" />
              <p className="font-medium">No reference photo set</p>
              <p className="text-xs opacity-80 mt-1">AI scoring uses general heuristics</p>
            </div>
          )}
        </div>

        <div className="mt-auto pt-4">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileSelect}
            disabled={uploadPhoto.isPending}
          />
          <Button 
            variant="outline" 
            className="w-full font-bold shadow-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadPhoto.isPending}
          >
            <Upload className="w-4 h-4 mr-2" />
            {uploadPhoto.isPending ? "Uploading..." : "Upload New Reference"}
          </Button>
          <p className="text-xs text-center text-muted-foreground mt-2">
            Upload a perfect state photo for AI to compare against.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
