import {
  useListAreas,
  useCreateArea,
  useUpdateArea,
  useDeleteArea,
  useGetAreaProfile,
  useResetAreaProfile,
  useUpdateAreaProfile,
  Area,
  getListAreasQueryKey,
  getGetAreaProfileQueryKey,
} from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, Pencil, Trash2, Check, X, BookOpen, RefreshCw, Sparkles, Wrench, Workflow, AlertCircle, Save, Edit3,
} from "lucide-react";
import { EnvironmentBadge, ENVIRONMENT_LABELS, type EnvironmentType } from "@/lib/environment";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Areas() {
  const { data: areas, isLoading } = useListAreas();
  const createArea = useCreateArea();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newAreaName, setNewAreaName] = useState("");
  const [newEnvType, setNewEnvType] = useState<EnvironmentType>("factory");
  const [showAddForm, setShowAddForm] = useState(false);

  const handleCreate = () => {
    if (!newAreaName.trim()) return;
    createArea.mutate(
      { data: { name: newAreaName.trim(), environmentType: newEnvType } },
      {
        onSuccess: () => {
          toast({ title: "Area created", description: `"${newAreaName.trim()}" has been added.` });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setNewAreaName("");
          setNewEnvType("factory");
          setShowAddForm(false);
        },
        onError: () => toast({ variant: "destructive", title: "Failed", description: "Could not create area." }),
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
          <p className="text-muted-foreground text-[15px]">Manage factory areas and view what the AI has learned about each one.</p>
        </div>
        {!showAddForm && (
          <Button onClick={() => setShowAddForm(true)} className="rounded-full h-11 px-5" data-testid="button-add-area">
            <Plus className="w-4 h-4 mr-1.5" /> Add area
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
            <div className="w-full sm:w-44">
              <label className="eyebrow mb-1.5 block">Environment</label>
              <Select value={newEnvType} onValueChange={(v) => setNewEnvType(v as EnvironmentType)}>
                <SelectTrigger
                  className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
                  data-testid="select-new-area-environment"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="factory" data-testid="option-environment-factory">{ENVIRONMENT_LABELS.factory}</SelectItem>
                  <SelectItem value="warehouse" data-testid="option-environment-warehouse">{ENVIRONMENT_LABELS.warehouse}</SelectItem>
                  <SelectItem value="home" data-testid="option-environment-home">{ENVIRONMENT_LABELS.home}</SelectItem>
                  <SelectItem value="corporate_office" data-testid="option-environment-corporate_office">{ENVIRONMENT_LABELS.corporate_office}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleCreate} disabled={createArea.isPending || !newAreaName.trim()} className="rounded-full h-11 px-5" data-testid="button-save-area">
              <Check className="w-4 h-4 mr-1" /> {createArea.isPending ? "Saving…" : "Save"}
            </Button>
            <Button variant="outline" onClick={() => { setShowAddForm(false); setNewAreaName(""); setNewEnvType("factory"); }} className="rounded-full h-11 w-11 p-0" data-testid="button-cancel-add">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {areas?.map((area) => <AreaConfigCard key={area.id} area={area} />)}
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
  const { data: profile, isLoading: profileLoading } = useGetAreaProfile(area.id, {
    query: { enabled: !!area.id, queryKey: getGetAreaProfileQueryKey(area.id) },
  });
  const resetProfile = useResetAreaProfile();
  const updateProfile = useUpdateAreaProfile();
  const updateArea = useUpdateArea();
  const deleteArea = useDeleteArea();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(area.name);
  const [editEnvType, setEditEnvType] = useState<EnvironmentType>(
    (area.environmentType as EnvironmentType) ?? "factory"
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editSummary, setEditSummary] = useState("");
  const [editItems, setEditItems] = useState("");
  const [editMachines, setEditMachines] = useState("");
  const [editLayout, setEditLayout] = useState("");
  const [editIssues, setEditIssues] = useState("");

  useEffect(() => {
    if (profile && !isEditingProfile) {
      setEditSummary(profile.summary ?? "");
      setEditItems((profile.items ?? []).join("\n"));
      setEditMachines((profile.machines ?? []).join("\n"));
      setEditLayout((profile.layout ?? []).join("\n"));
      setEditIssues((profile.commonIssues ?? []).join("\n"));
    }
  }, [profile, isEditingProfile]);

  const splitLines = (s: string) =>
    s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const handleSaveProfile = () => {
    updateProfile.mutate(
      {
        id: area.id,
        data: {
          summary: editSummary.trim() ? editSummary.trim() : null,
          items: splitLines(editItems),
          machines: splitLines(editMachines),
          layout: splitLines(editLayout),
          commonIssues: splitLines(editIssues),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Profile updated", description: `Learned profile for ${area.name} saved.` });
          queryClient.invalidateQueries({ queryKey: getGetAreaProfileQueryKey(area.id) });
          setIsEditingProfile(false);
        },
        onError: () => toast({ variant: "destructive", title: "Save failed", description: "Could not update the profile." }),
      }
    );
  };

  const currentEnvType = (area.environmentType as EnvironmentType) ?? "factory";

  const handleSaveEdits = () => {
    const trimmedName = editName.trim();
    const nameChanged = trimmedName.length > 0 && trimmedName !== area.name;
    const envChanged = editEnvType !== currentEnvType;
    if (!nameChanged && !envChanged) {
      setIsEditing(false);
      setEditName(area.name);
      setEditEnvType(currentEnvType);
      return;
    }
    if (!trimmedName) {
      setEditName(area.name);
      return;
    }
    updateArea.mutate(
      { id: area.id, data: { name: trimmedName, environmentType: editEnvType } },
      {
        onSuccess: () => {
          toast({
            title: "Area updated",
            description: nameChanged
              ? `Renamed to "${trimmedName}"${envChanged ? ` · environment now ${ENVIRONMENT_LABELS[editEnvType]}` : ""}.`
              : `Environment set to ${ENVIRONMENT_LABELS[editEnvType]}.`,
          });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setIsEditing(false);
        },
        onError: () => toast({ variant: "destructive", title: "Save failed", description: "Could not update the area." }),
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
        onError: () => toast({ variant: "destructive", title: "Delete failed", description: "Could not delete the area." }),
      }
    );
    setShowDeleteDialog(false);
  };

  const handleReset = () => {
    resetProfile.mutate(
      { id: area.id },
      {
        onSuccess: () => {
          toast({ title: "Profile reset", description: `Learning will start over for ${area.name}.` });
          queryClient.invalidateQueries({ queryKey: getGetAreaProfileQueryKey(area.id) });
        },
        onError: () => toast({ variant: "destructive", title: "Reset failed", description: "Could not reset profile." }),
      }
    );
    setShowResetDialog(false);
  };

  const status = profile?.status ?? "LEARNING";
  const isTrained = status === "TRAINED";
  const submissions = profile?.submissionsCount ?? 0;
  const target = profile?.targetSubmissions ?? 5;
  const progressPct = Math.min(100, Math.round((submissions / Math.max(target, 1)) * 100));

  return (
    <>
      <div className="bg-card rounded-2xl shadow-soft transition-all duration-150 hover:shadow-elevated active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none flex flex-col p-5 sm:p-6" data-testid={`card-area-${area.id}`}>
        <div className="flex items-start justify-between gap-2 mb-5">
          {isEditing ? (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-1">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEdits();
                  if (e.key === "Escape") {
                    setIsEditing(false);
                    setEditName(area.name);
                    setEditEnvType(currentEnvType);
                  }
                }}
                autoFocus
                className="h-10 rounded-xl bg-secondary/60 border-transparent flex-1"
                data-testid={`input-rename-area-${area.id}`}
              />
              <Select value={editEnvType} onValueChange={(v) => setEditEnvType(v as EnvironmentType)}>
                <SelectTrigger
                  className="h-10 rounded-xl bg-secondary/60 border-transparent w-full sm:w-36"
                  data-testid={`select-environment-${area.id}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="factory" data-testid={`option-environment-factory-${area.id}`}>{ENVIRONMENT_LABELS.factory}</SelectItem>
                  <SelectItem value="warehouse" data-testid={`option-environment-warehouse-${area.id}`}>{ENVIRONMENT_LABELS.warehouse}</SelectItem>
                  <SelectItem value="home" data-testid={`option-environment-home-${area.id}`}>{ENVIRONMENT_LABELS.home}</SelectItem>
                  <SelectItem value="corporate_office" data-testid={`option-environment-corporate_office-${area.id}`}>{ENVIRONMENT_LABELS.corporate_office}</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={handleSaveEdits} disabled={updateArea.isPending} data-testid={`button-confirm-rename-${area.id}`}>
                  <Check className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setIsEditing(false); setEditName(area.name); setEditEnvType(currentEnvType); }}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-[19px] font-semibold tracking-tight truncate">{area.name}</h3>
                  <EnvironmentBadge type={currentEnvType} testId={`badge-environment-${area.id}`} />
                </div>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">ID: {area.id}</p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="rounded-full text-muted-foreground" onClick={() => { setIsEditing(true); setEditName(area.name); setEditEnvType(currentEnvType); }} data-testid={`button-edit-area-${area.id}`}>
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
          <div className="flex items-center justify-between mb-2">
            <p className="eyebrow flex items-center gap-1.5"><BookOpen className="w-3 h-3" /> Learned profile</p>
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                isTrained
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
              }`}
            >
              <Sparkles className="w-3 h-3" />
              {isTrained ? "Trained" : `Learning ${submissions}/${target}`}
            </span>
          </div>

          {profileLoading ? (
            <div className="h-32 bg-secondary rounded-xl animate-pulse"></div>
          ) : isEditingProfile ? (
            <div className="rounded-xl bg-secondary/40 p-4 space-y-3">
              <div>
                <label className="eyebrow mb-1 block">Summary</label>
                <Textarea
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  rows={3}
                  className="text-[13px] rounded-lg bg-card border-transparent focus-visible:border-ring"
                  placeholder="Short paragraph describing this area"
                  data-testid={`textarea-summary-${area.id}`}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ProfileEditField label="Machines (one per line)" value={editMachines} onChange={setEditMachines} testId={`textarea-machines-${area.id}`} />
                <ProfileEditField label="Items (one per line)" value={editItems} onChange={setEditItems} testId={`textarea-items-${area.id}`} />
                <ProfileEditField label="Layout notes (one per line)" value={editLayout} onChange={setEditLayout} testId={`textarea-layout-${area.id}`} />
                <ProfileEditField label="Recurring issues (one per line)" value={editIssues} onChange={setEditIssues} testId={`textarea-issues-${area.id}`} />
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-secondary/40 p-4 space-y-3">
              {!isTrained && (
                <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full" style={{ width: `${progressPct}%` }} />
                </div>
              )}
              {profile?.summary ? (
                <p className="text-[13px] leading-snug text-foreground/85">{profile.summary}</p>
              ) : (
                <p className="text-[12.5px] text-muted-foreground italic">No summary yet — submit a video walk-through to start learning this area.</p>
              )}

              <ProfileChips icon={<Workflow className="w-3 h-3" />} label="Machines" items={profile?.machines ?? []} />
              <ProfileChips icon={<Wrench className="w-3 h-3" />} label="Items" items={profile?.items ?? []} />
              <ProfileChips icon={<AlertCircle className="w-3 h-3" />} label="Recurring issues" items={profile?.commonIssues ?? []} tone="warn" />

              {profile?.updatedAt && (
                <p className="text-[11px] text-muted-foreground pt-1">Updated {format(new Date(profile.updatedAt), "MMM d, h:mm a")}</p>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            {isEditingProfile ? (
              <>
                <Button
                  className="flex-1 h-10 rounded-xl"
                  onClick={handleSaveProfile}
                  disabled={updateProfile.isPending}
                  data-testid={`button-save-profile-${area.id}`}
                >
                  <Save className="w-4 h-4 mr-2" />
                  {updateProfile.isPending ? "Saving…" : "Save profile"}
                </Button>
                <Button variant="outline" className="h-10 rounded-xl" onClick={() => setIsEditingProfile(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl"
                  onClick={() => setIsEditingProfile(true)}
                  data-testid={`button-edit-profile-${area.id}`}
                >
                  <Edit3 className="w-4 h-4 mr-2" /> Edit profile
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl"
                  onClick={() => setShowResetDialog(true)}
                  disabled={resetProfile.isPending || submissions === 0}
                  data-testid={`button-reset-profile-${area.id}`}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {resetProfile.isPending ? "Resetting…" : "Reset"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{area.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this area along with its submissions, learned profile and escalations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full" data-testid={`button-cancel-delete-${area.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-full" data-testid={`button-confirm-delete-${area.id}`}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Reset learned profile for "{area.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI will forget what it has observed in this area and start learning again from the next walk-through.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} className="rounded-full">Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProfileEditField({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div>
      <label className="eyebrow mb-1 block">{label}</label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className="text-[12.5px] rounded-lg bg-card border-transparent focus-visible:border-ring resize-none"
        data-testid={testId}
      />
    </div>
  );
}

function ProfileChips({ icon, label, items, tone = "default" }: { icon: React.ReactNode; label: string; items: string[]; tone?: "default" | "warn" }) {
  if (!items.length) return null;
  const toneCls =
    tone === "warn"
      ? "bg-amber-50 text-amber-800 dark:bg-amber-500/12 dark:text-amber-300"
      : "bg-card text-foreground/80";
  return (
    <div>
      <p className="eyebrow mb-1.5 inline-flex items-center gap-1">{icon} {label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 8).map((s, i) => (
          <span key={i} className={`text-[11.5px] px-2 py-0.5 rounded-full font-medium ${toneCls}`}>{s}</span>
        ))}
      </div>
    </div>
  );
}
