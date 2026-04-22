import {
  useListAreas, useGetIdealPhotos, useUploadIdealPhoto, useCreateArea, useUpdateArea, useDeleteArea,
  Area, getGetIdealPhotosQueryKey, getListAreasQueryKey
} from "@workspace/api-client-react";
import { useState, useRef } from "react";
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
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-12">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-2">
          <p className="eyebrow">Configuration</p>
          <h1 className="text-[34px] font-semibold tracking-tight leading-tight" data-testid="text-page-title">
            Area management
          </h1>
          <p className="text-muted-foreground text-[15px]">Manage factory areas and reference photos.</p>
        </div>
        {!showAddForm && (
          <Button onClick={() => setShowAddForm(true)} className="rounded-full h-11 px-5" data-testid="button-add-area">
            <Plus className="w-4 h-4 mr-1.5" />
            Add area
          </Button>
        )}
      </header>

      {showAddForm && (
        <div className="bg-card rounded-2xl shadow-elevated p-5 sm:p-6">
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="eyebrow mb-1.5 block">New area name</label>
              <Input
                placeholder="e.g. Welding Bay 2"
                value={newAreaName}
                onChange={(e) => setNewAreaName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
                className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                data-testid="input-new-area-name"
              />
            </div>
            <Button
              onClick={handleCreate}
              disabled={createArea.isPending || !newAreaName.trim()}
              className="rounded-full h-11 px-5"
              data-testid="button-save-area"
            >
              <Check className="w-4 h-4 mr-1" />
              {createArea.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={() => { setShowAddForm(false); setNewAreaName(""); }}
              className="rounded-full h-11 w-11 p-0"
              data-testid="button-cancel-add"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {areas?.map((area) => (
          <AreaConfigCard key={area.id} area={area} />
        ))}
      </div>

      {areas?.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-[15px] font-medium">No areas configured</p>
          <p className="text-[13px] mt-1 opacity-80">Click "Add area" to create your first manufacturing area.</p>
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
      <div className="bg-card rounded-2xl shadow-soft transition-shadow hover:shadow-elevated flex flex-col p-5 sm:p-6" data-testid={`card-area-${area.id}`}>
        <div className="flex items-center justify-between gap-2 mb-5">
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
                className="h-10 rounded-xl bg-secondary/60 border-transparent"
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
                <h3 className="text-[19px] font-semibold tracking-tight">{area.name}</h3>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">ID: {area.id}</p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="rounded-full text-muted-foreground" onClick={() => { setIsEditing(true); setEditName(area.name); }} data-testid={`button-edit-area-${area.id}`}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full text-muted-foreground hover:text-destructive" onClick={() => setShowDeleteDialog(true)} data-testid={`button-delete-area-${area.id}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="flex-1 flex flex-col">
          <p className="eyebrow mb-2.5">Current reference photo</p>
          {isLoading ? (
            <div className="h-48 bg-secondary rounded-xl animate-pulse"></div>
          ) : latestPhoto ? (
            <div className="rounded-xl overflow-hidden bg-secondary">
              <img
                src={`/api${latestPhoto.imageUrl}`}
                alt={`Reference for ${area.name}`}
                className="w-full h-48 object-cover"
              />
              <div className="px-3 py-2 text-[12px] text-muted-foreground flex justify-between bg-secondary/60">
                <span className="font-medium">Active reference</span>
                <span>Uploaded {format(new Date(latestPhoto.createdAt), "MMM d, yyyy")}</span>
              </div>
            </div>
          ) : (
            <div className="h-48 rounded-xl bg-secondary/60 flex flex-col items-center justify-center text-muted-foreground">
              <ImageIcon className="w-9 h-9 mb-2 opacity-50" />
              <p className="text-[14px] font-medium">No reference photo set</p>
              <p className="text-[12px] opacity-80 mt-1">Upload a baseline photo for scoring</p>
            </div>
          )}

          <div className="mt-5">
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
              className="w-full h-11 rounded-xl"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadPhoto.isPending}
              data-testid={`button-upload-photo-${area.id}`}
            >
              <Upload className="w-4 h-4 mr-2" />
              {uploadPhoto.isPending ? "Uploading…" : "Upload new reference"}
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{area.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this area and all its associated submissions and reference photos. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full" data-testid={`button-cancel-delete-${area.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-full"
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
