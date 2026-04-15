import { 
  useListAreas, useGetIdealPhotos, useUploadIdealPhoto, useCreateArea, useUpdateArea, useDeleteArea,
  Area, getGetIdealPhotosQueryKey, getListAreasQueryKey
} from "@workspace/api-client-react";
import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, Image as ImageIcon, Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Areas() {
  const { data: areas, isLoading } = useListAreas();
  const createArea = useCreateArea();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newAreaName, setNewAreaName] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  const handleCreate = () => {
    if (!newAreaName.trim()) return;
    createArea.mutate(
      { data: { name: newAreaName.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Area created", description: `"${newAreaName.trim()}" has been added.` });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setNewAreaName("");
          setShowAddForm(false);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Failed", description: "Could not create area." });
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">Area Management</h1>
          <p className="text-muted-foreground mt-1">Manage factory areas and reference photos.</p>
        </div>
        {!showAddForm && (
          <Button onClick={() => setShowAddForm(true)} data-testid="button-add-area">
            <Plus className="w-4 h-4 mr-2" />
            Add Area
          </Button>
        )}
      </div>

      {showAddForm && (
        <Card className="border-primary/30 shadow-md">
          <CardContent className="pt-6">
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="text-sm font-medium mb-1 block">New Area Name</label>
                <Input
                  placeholder="e.g. Welding Bay 2"
                  value={newAreaName}
                  onChange={(e) => setNewAreaName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  autoFocus
                  data-testid="input-new-area-name"
                />
              </div>
              <Button onClick={handleCreate} disabled={createArea.isPending || !newAreaName.trim()} data-testid="button-save-area">
                <Check className="w-4 h-4 mr-1" />
                {createArea.isPending ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" onClick={() => { setShowAddForm(false); setNewAreaName(""); }} data-testid="button-cancel-add">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {areas?.map((area) => (
          <AreaConfigCard key={area.id} area={area} />
        ))}
      </div>

      {areas?.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg font-medium">No areas configured</p>
          <p className="text-sm mt-1">Click "Add Area" to create your first manufacturing area.</p>
        </div>
      )}
    </div>
  );
}

function AreaConfigCard({ area }: { area: Area }) {
  const { data: idealPhotos, isLoading } = useGetIdealPhotos(area.id, {
    query: {
      enabled: !!area.id,
      queryKey: getGetIdealPhotosQueryKey(area.id),
    },
  });

  const uploadPhoto = useUploadIdealPhoto();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(area.name);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    uploadPhoto.mutate(
      { id: area.id, data: { photo: file } as any },
      {
        onSuccess: () => {
          toast({ title: "Reference photo uploaded", description: `New reference photo set for ${area.name}.` });
          queryClient.invalidateQueries({ queryKey: getGetIdealPhotosQueryKey(area.id) });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Upload failed", description: "Failed to upload the reference photo." });
        },
      }
    );

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRename = () => {
    if (!editName.trim() || editName.trim() === area.name) {
      setIsEditing(false);
      setEditName(area.name);
      return;
    }
    updateArea.mutate(
      { id: area.id, data: { name: editName.trim() } },
      {
        onSuccess: () => {
          toast({ title: "Area renamed", description: `Renamed to "${editName.trim()}".` });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setIsEditing(false);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Rename failed", description: "Could not rename the area." });
        },
      }
    );
  };

  const handleDelete = () => {
    deleteArea.mutate(
      { id: area.id },
      {
        onSuccess: () => {
          toast({ title: "Area deleted", description: `"${area.name}" has been removed.` });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
        },
        onError: () => {
          toast({ variant: "destructive", title: "Delete failed", description: "Could not delete the area." });
        },
      }
    );
    setShowDeleteDialog(false);
  };

  const latestPhoto = idealPhotos?.[idealPhotos.length - 1];

  return (
    <>
      <Card className="border-border shadow-sm flex flex-col" data-testid={`card-area-${area.id}`}>
        <CardHeader className="pb-4 border-b">
          <div className="flex items-center justify-between gap-2">
            {isEditing ? (
              <div className="flex items-center gap-2 flex-1">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                    if (e.key === "Escape") { setIsEditing(false); setEditName(area.name); }
                  }}
                  autoFocus
                  className="h-8"
                  data-testid={`input-rename-area-${area.id}`}
                />
                <Button size="sm" variant="ghost" onClick={handleRename} disabled={updateArea.isPending} data-testid={`button-confirm-rename-${area.id}`}>
                  <Check className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setIsEditing(false); setEditName(area.name); }}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <>
                <div>
                  <CardTitle className="text-xl">{area.name}</CardTitle>
                  <CardDescription>ID: {area.id}</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setIsEditing(true); setEditName(area.name); }} data-testid={`button-edit-area-${area.id}`}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setShowDeleteDialog(true)} data-testid={`button-delete-area-${area.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </>
            )}
          </div>
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
                <p className="text-xs opacity-80 mt-1">Upload a baseline photo for scoring</p>
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
              data-testid={`button-upload-photo-${area.id}`}
            >
              <Upload className="w-4 h-4 mr-2" />
              {uploadPhoto.isPending ? "Uploading..." : "Upload New Reference"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{area.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this area and all its associated submissions and reference photos. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-${area.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-delete-${area.id}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
