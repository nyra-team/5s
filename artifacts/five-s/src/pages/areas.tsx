import {
  useListAreas,
  useCreateArea,
  useUpdateArea,
  useDeleteArea,
  useGetAreaProfile,
  useResetAreaProfile,
  useUpdateAreaProfile,
  useListOperators,
  useGetAreaAssignments,
  useSetAreaAssignments,
  useGetUserAreaAssignments,
  useSetUserAreaAssignments,
  Area,
  getListAreasQueryKey,
  getGetAreaProfileQueryKey,
  getGetAreaAssignmentsQueryKey,
  getGetUserAreaAssignmentsQueryKey,
  getGetDashboardOperatorCoverageQueryKey,
} from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import {
  Plus, Pencil, Trash2, Check, X, BookOpen, RefreshCw, Sparkles, Wrench, Workflow, AlertCircle, Save, Edit3, Users, LayoutGrid, UserCog, ListChecks, RotateCcw,
} from "lucide-react";
import { EnvironmentBadge, EnvironmentChecklist, ENVIRONMENT_LABELS, ENVIRONMENT_CHECKLIST, type EnvironmentType } from "@/lib/environment";
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
  // Two views over the same `area_assignments` table: pin one area and pick
  // operators (the per-area cards), or pin one operator and pick areas (the
  // by-operator picker). The by-operator view is the bulk-onboarding tool —
  // dozens of areas times dozens of operators is a lot of clicks otherwise.
  const [view, setView] = useState<"areas" | "operators">("areas");

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
          <p className="text-muted-foreground text-[15px]">Manage factory areas, see what the AI has learned, and assign operators by area or by person.</p>
        </div>
        {view === "areas" && !showAddForm && (
          <Button onClick={() => setShowAddForm(true)} className="rounded-full h-11 px-5" data-testid="button-add-area">
            <Plus className="w-4 h-4 mr-1.5" /> Add area
          </Button>
        )}
      </header>

      <Tabs value={view} onValueChange={(v) => setView(v as "areas" | "operators")} className="space-y-6">
        <TabsList className="rounded-full bg-secondary/60 p-1 h-10" data-testid="tabs-area-view">
          <TabsTrigger
            value="areas"
            className="rounded-full px-4 h-8 text-[13px] data-[state=active]:bg-card data-[state=active]:shadow-soft"
            data-testid="tab-by-area"
          >
            <LayoutGrid className="w-3.5 h-3.5 mr-1.5" /> By area
          </TabsTrigger>
          <TabsTrigger
            value="operators"
            className="rounded-full px-4 h-8 text-[13px] data-[state=active]:bg-card data-[state=active]:shadow-soft"
            data-testid="tab-by-operator"
          >
            <UserCog className="w-3.5 h-3.5 mr-1.5" /> By operator
          </TabsTrigger>
        </TabsList>

        <TabsContent value="areas" className="space-y-6 mt-0">
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
              <div className="mt-4">
                <p className="text-[12px] text-muted-foreground mb-2">Operators will be asked to capture…</p>
                <EnvironmentChecklist type={newEnvType} testId="environment-checklist-new-area" />
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
        </TabsContent>

        <TabsContent value="operators" className="mt-0">
          <ByOperatorAssignments areas={areas ?? []} />
        </TabsContent>
      </Tabs>
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
            <div className="flex flex-col gap-3 flex-1">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
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
              <div>
                <p className="text-[12px] text-muted-foreground mb-2">Operators will be asked to capture…</p>
                <EnvironmentChecklist type={editEnvType} testId={`environment-checklist-edit-${area.id}`} />
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
            // Cap the edit grid's height on narrow screens so the Save button
            // (rendered just below this block) is always reachable without
            // scrolling the whole page past five textareas.
            <div
              className="rounded-xl bg-secondary/40 p-4 space-y-3 max-h-[55vh] overflow-y-auto sm:max-h-none sm:overflow-visible"
              data-testid={`profile-edit-scroll-${area.id}`}
            >
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

          <WalkthroughHintsSection area={area} />

          <AreaAssignmentsSection areaId={area.id} areaName={area.name} />
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

// Per-area panel for overriding the walk-through hint bullets that operators
// see in the capture sheet. By default operators see the static list keyed
// off the area's environmentType (factory/warehouse/home/corporate_office);
// this section lets a manager replace those bullets for a specific area
// — e.g. "include the cleanroom airlock" or "show the back loading bay" —
// or reset back to the env default. Only non-empty arrays round-trip as
// overrides; an empty list (blank Save or `[]`) is normalized server-side
// to null so the operator UI consistently falls back to the env default
// (see EnvironmentChecklist in lib/environment.tsx).
function WalkthroughHintsSection({ area }: { area: Area }) {
  const envType = (area.environmentType as EnvironmentType) ?? "factory";
  const updateArea = useUpdateArea();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const override = area.walkthroughHintsOverride ?? null;
  const defaultHints = ENVIRONMENT_CHECKLIST[envType] ?? [];
  const currentHints = override && override.length > 0 ? override : defaultHints;
  const usingOverride = override !== null;

  const startEditing = () => {
    // Seed the textarea with whatever's currently shown so the manager can
    // tweak the env default rather than start from a blank box.
    setDraft(currentHints.join("\n"));
    setEditing(true);
  };

  const splitLines = (s: string) =>
    s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const handleSave = () => {
    const bullets = splitLines(draft);
    // Saving an empty textarea is treated the same as Reset — there's no UI
    // for "hide the checklist entirely", so an empty list always means
    // "fall back to the env default" to keep manager and operator views in
    // sync with the rendering rule (override is only applied when non-empty).
    const payload = bullets.length > 0 ? bullets : null;
    const reverting = payload === null;
    updateArea.mutate(
      { id: area.id, data: { name: area.name, walkthroughHintsOverride: payload } },
      {
        onSuccess: () => {
          toast({
            title: reverting ? "Reverted to default" : "Walk-through hints saved",
            description: reverting
              ? `${ENVIRONMENT_LABELS[envType]} default hints will be shown for ${area.name}.`
              : `Operators capturing for ${area.name} will see your custom list.`,
          });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setEditing(false);
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Save failed",
            description: "Could not update walk-through hints.",
          }),
      },
    );
  };

  const handleReset = () => {
    updateArea.mutate(
      { id: area.id, data: { name: area.name, walkthroughHintsOverride: null } },
      {
        onSuccess: () => {
          toast({
            title: "Reverted to default",
            description: `${ENVIRONMENT_LABELS[envType]} default hints will be shown for ${area.name}.`,
          });
          queryClient.invalidateQueries({ queryKey: getListAreasQueryKey() });
          setEditing(false);
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Reset failed",
            description: "Could not clear the override.",
          }),
      },
    );
  };

  const handleCancel = () => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="mt-5 pt-4 border-t border-border/60">
      <div className="flex items-center justify-between mb-2">
        <p className="eyebrow flex items-center gap-1.5">
          <ListChecks className="w-3 h-3" /> Walk-through hints
        </p>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${
              usingOverride
                ? "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
                : "bg-secondary text-muted-foreground"
            }`}
            data-testid={`badge-hints-source-${area.id}`}
          >
            {usingOverride ? "Custom" : `${ENVIRONMENT_LABELS[envType]} default`}
          </span>
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full text-muted-foreground h-10 px-4"
              onClick={startEditing}
              data-testid={`button-edit-hints-${area.id}`}
            >
              <Edit3 className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="rounded-xl bg-secondary/40 p-3 space-y-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(5, Math.min(10, splitLines(draft).length + 2))}
            placeholder="One bullet per line, e.g. Include the cleanroom airlock"
            className="text-[12.5px] rounded-lg bg-card border-transparent focus-visible:border-ring resize-none"
            data-testid={`textarea-hints-${area.id}`}
          />
          <p className="text-[11px] text-muted-foreground leading-snug">
            One bullet per line. Operators see these in the capture sheet before they hit
            record. Leave blank and Save (or use Reset) to revert to the{" "}
            {ENVIRONMENT_LABELS[envType]} default ({defaultHints.length} bullets).
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button
              className="flex-1 h-10 rounded-xl"
              onClick={handleSave}
              disabled={updateArea.isPending}
              data-testid={`button-save-hints-${area.id}`}
            >
              <Save className="w-4 h-4 mr-2" />
              {updateArea.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-xl"
              onClick={handleReset}
              disabled={updateArea.isPending || !usingOverride}
              data-testid={`button-reset-hints-${area.id}`}
            >
              <RotateCcw className="w-4 h-4 mr-2" /> Reset to default
            </Button>
            <Button
              variant="ghost"
              className="h-10 rounded-xl"
              onClick={handleCancel}
              disabled={updateArea.isPending}
              data-testid={`button-cancel-hints-${area.id}`}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="rounded-xl bg-secondary/40 p-3"
          data-testid={`view-hints-${area.id}`}
        >
          {currentHints.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground italic">
              No bullets configured — operators won't see a checklist for this area.
            </p>
          ) : (
            <ul className="space-y-1">
              {currentHints.map((item, i) => (
                <li
                  key={i}
                  className="text-[12.5px] text-foreground/85 leading-snug flex gap-2 items-start"
                  data-testid={`hint-item-${area.id}-${i}`}
                >
                  <span
                    className="mt-1.5 inline-block w-1 h-1 rounded-full bg-foreground/60 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="flex-1">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Per-area panel for picking which operators are assigned to it. Renders the
// full operator directory as a checkbox list and only enables the Save button
// when the local selection differs from what's currently on the server. Empty
// selection is allowed and means "nobody is assigned" (the API treats that
// as: no rows for this area, which intentionally falls back to the default
// "all operators with no assignments configured see all areas" rule
// described in the route).
function AreaAssignmentsSection({ areaId, areaName }: { areaId: number; areaName: string }) {
  const { data: operators, isLoading: operatorsLoading } = useListOperators();
  const { data: assignments, isLoading: assignmentsLoading } = useGetAreaAssignments(areaId, {
    query: { queryKey: getGetAreaAssignmentsQueryKey(areaId) },
  });
  const setAssignments = useSetAreaAssignments();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (assignments?.operatorIds) setSelected(new Set(assignments.operatorIds));
  }, [assignments?.operatorIds]);

  const serverSet = new Set(assignments?.operatorIds ?? []);
  const dirty =
    selected.size !== serverSet.size ||
    Array.from(selected).some((id) => !serverSet.has(id));

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = () => {
    setAssignments.mutate(
      { id: areaId, data: { operatorIds: Array.from(selected) } },
      {
        onSuccess: () => {
          toast({
            title: "Assignments saved",
            description: `${selected.size} operator${selected.size === 1 ? "" : "s"} can now submit for ${areaName}.`,
          });
          queryClient.invalidateQueries({ queryKey: getGetAreaAssignmentsQueryKey(areaId) });
          // Manager dashboard's "operators with no coverage" widget reads
          // from a separate endpoint; refresh it so the operator we just
          // (un)assigned reflects in the live count without a hard reload.
          queryClient.invalidateQueries({ queryKey: getGetDashboardOperatorCoverageQueryKey() });
          setEditing(false);
        },
        onError: () =>
          toast({ variant: "destructive", title: "Save failed", description: "Could not update assignments." }),
      },
    );
  };

  const handleCancel = () => {
    setSelected(new Set(assignments?.operatorIds ?? []));
    setEditing(false);
  };

  const assignedOperators = (operators ?? []).filter((o) => serverSet.has(o.id));

  return (
    <div className="mt-5 pt-4 border-t border-border/60">
      <div className="flex items-center justify-between mb-2">
        <p className="eyebrow flex items-center gap-1.5">
          <Users className="w-3 h-3" /> Assigned operators
        </p>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-muted-foreground h-10 px-4"
            onClick={() => setEditing(true)}
            data-testid={`button-edit-assignments-${areaId}`}
          >
            <Edit3 className="w-3.5 h-3.5 mr-1" /> Edit
          </Button>
        )}
      </div>

      {assignmentsLoading || operatorsLoading ? (
        <div className="h-10 bg-secondary/40 rounded-lg animate-pulse"></div>
      ) : editing ? (
        <div className="rounded-xl bg-secondary/40 p-3 space-y-3">
          {(operators ?? []).length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground italic">
              No operator accounts exist yet — create one before assigning.
            </p>
          ) : (
            <div
              className="max-h-48 overflow-y-auto space-y-1 pr-1"
              data-testid={`list-assignment-operators-${areaId}`}
            >
              {(operators ?? []).map((op) => {
                const checked = selected.has(op.id);
                return (
                  <label
                    key={op.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-card cursor-pointer text-[13px]"
                    data-testid={`row-assignment-operator-${areaId}-${op.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(op.id)}
                      className="w-4 h-4 rounded border-border accent-primary"
                      data-testid={`checkbox-assignment-${areaId}-${op.id}`}
                    />
                    <span className="truncate">{op.email}</span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1 h-9 rounded-xl"
              onClick={handleSave}
              disabled={!dirty || setAssignments.isPending}
              data-testid={`button-save-assignments-${areaId}`}
            >
              <Save className="w-3.5 h-3.5 mr-1.5" />
              {setAssignments.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              className="h-9 rounded-xl"
              onClick={handleCancel}
              data-testid={`button-cancel-assignments-${areaId}`}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : assignedOperators.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground italic" data-testid={`text-no-assignments-${areaId}`}>
          No operators assigned — every operator without a personal assignment list sees this area.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-testid={`chips-assignments-${areaId}`}>
          {assignedOperators.map((op) => (
            <span
              key={op.id}
              className="text-[11.5px] px-2 py-0.5 rounded-full font-medium bg-card text-foreground/80"
              data-testid={`chip-assignment-${areaId}-${op.id}`}
            >
              {op.email}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Bulk-assignment view: pick one operator and toggle every area on/off in
// one screen. Sites with dozens of areas × dozens of operators would
// otherwise need a click per pair when onboarding a new hire. Reads/writes
// the same `area_assignments` table as the per-area picker via a per-user
// endpoint, so there is exactly one source of truth and the "no rows = sees
// everything" backward-compat rule still kicks in when the manager clears
// every box for an operator.
function ByOperatorAssignments({ areas }: { areas: Area[] }) {
  const { data: operators, isLoading: operatorsLoading } = useListOperators();
  const [selectedOperatorId, setSelectedOperatorId] = useState<number | null>(null);

  // Auto-select the first operator once the directory loads so the picker is
  // useful out of the box without an extra click.
  useEffect(() => {
    if (selectedOperatorId == null && operators && operators.length > 0) {
      setSelectedOperatorId(operators[0].id);
    }
  }, [operators, selectedOperatorId]);

  if (operatorsLoading) {
    return (
      <div className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-10 bg-secondary/40 rounded-lg animate-pulse"></div>
      </div>
    );
  }

  if (!operators || operators.length === 0) {
    return (
      <div className="bg-card rounded-2xl shadow-soft p-8 text-center text-muted-foreground" data-testid="empty-no-operators">
        <p className="text-[15px] font-medium">No operator accounts exist yet</p>
        <p className="text-[13px] mt-1 opacity-80">Create an operator user before assigning areas.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-card rounded-2xl shadow-soft p-5 sm:p-6">
        <label className="eyebrow mb-2 block">Operator</label>
        <Select
          value={selectedOperatorId != null ? String(selectedOperatorId) : ""}
          onValueChange={(v) => setSelectedOperatorId(Number(v))}
        >
          <SelectTrigger
            className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring max-w-md"
            data-testid="select-by-operator-user"
          >
            <SelectValue placeholder="Choose an operator" />
          </SelectTrigger>
          <SelectContent>
            {operators.map((op) => (
              <SelectItem
                key={op.id}
                value={String(op.id)}
                data-testid={`option-by-operator-user-${op.id}`}
              >
                {op.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[12.5px] text-muted-foreground mt-2">
          Pick an operator, then check every area they should be able to submit for. Clearing every box reverts them to seeing all areas (the default for unassigned operators).
        </p>
      </div>

      {selectedOperatorId != null && (
        <OperatorAreasPicker
          key={selectedOperatorId}
          operatorId={selectedOperatorId}
          operatorEmail={operators.find((o) => o.id === selectedOperatorId)?.email ?? ""}
          areas={areas}
        />
      )}
    </div>
  );
}

function OperatorAreasPicker({
  operatorId,
  operatorEmail,
  areas,
}: {
  operatorId: number;
  operatorEmail: string;
  areas: Area[];
}) {
  const { data: assignments, isLoading } = useGetUserAreaAssignments(operatorId, {
    query: { queryKey: getGetUserAreaAssignmentsQueryKey(operatorId) },
  });
  const setUserAssignments = useSetUserAreaAssignments();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (assignments?.areaIds) setSelected(new Set(assignments.areaIds));
  }, [assignments?.areaIds]);

  const serverSet = new Set(assignments?.areaIds ?? []);
  const dirty =
    selected.size !== serverSet.size ||
    Array.from(selected).some((id) => !serverSet.has(id));

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(areas.map((a) => a.id)));
  const clearAll = () => setSelected(new Set());

  const handleSave = () => {
    const areaIds = Array.from(selected);
    setUserAssignments.mutate(
      { userId: operatorId, data: { areaIds } },
      {
        onSuccess: () => {
          toast({
            title: "Assignments saved",
            description:
              areaIds.length === 0
                ? `${operatorEmail} can now see every area (no personal list configured).`
                : `${operatorEmail} is assigned to ${areaIds.length} area${areaIds.length === 1 ? "" : "s"}.`,
          });
          // Invalidate both the per-user view and every per-area view so the
          // "By area" tab reflects the change immediately if the manager
          // switches over.
          queryClient.invalidateQueries({ queryKey: getGetUserAreaAssignmentsQueryKey(operatorId) });
          for (const a of areas) {
            queryClient.invalidateQueries({ queryKey: getGetAreaAssignmentsQueryKey(a.id) });
          }
        },
        onError: () =>
          toast({ variant: "destructive", title: "Save failed", description: "Could not update assignments." }),
      },
    );
  };

  const handleReset = () => {
    setSelected(new Set(assignments?.areaIds ?? []));
  };

  if (isLoading) {
    return (
      <div className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-32 bg-secondary/40 rounded-lg animate-pulse"></div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl shadow-soft p-5 sm:p-6 space-y-4" data-testid={`picker-by-operator-${operatorId}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="eyebrow flex items-center gap-1.5"><Users className="w-3 h-3" /> Areas for {operatorEmail}</p>
          <p className="text-[12.5px] text-muted-foreground mt-1" data-testid={`text-by-operator-summary-${operatorId}`}>
            {selected.size} of {areas.length} selected
            {selected.size === 0 && " — currently sees every area"}
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="rounded-full h-9 px-3 text-[12.5px]"
            onClick={selectAll}
            disabled={areas.length === 0 || selected.size === areas.length}
            data-testid={`button-by-operator-select-all-${operatorId}`}
          >
            Select all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full h-9 px-3 text-[12.5px]"
            onClick={clearAll}
            disabled={selected.size === 0}
            data-testid={`button-by-operator-clear-${operatorId}`}
          >
            Clear
          </Button>
        </div>
      </div>

      {areas.length === 0 ? (
        <p className="text-[13px] text-muted-foreground italic">
          No areas have been created yet — add one in the "By area" tab first.
        </p>
      ) : (
        <div
          className="rounded-xl bg-secondary/40 p-2 max-h-[420px] overflow-y-auto"
          data-testid={`list-by-operator-areas-${operatorId}`}
        >
          {areas.map((area) => {
            const checked = selected.has(area.id);
            const envType = (area.environmentType as EnvironmentType) ?? "factory";
            return (
              <label
                key={area.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-card cursor-pointer text-[13.5px]"
                data-testid={`row-by-operator-area-${operatorId}-${area.id}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(area.id)}
                  className="w-4 h-4 rounded border-border accent-primary"
                  data-testid={`checkbox-by-operator-area-${operatorId}-${area.id}`}
                />
                <span className="flex-1 truncate">{area.name}</span>
                <EnvironmentBadge type={envType} testId={`badge-by-operator-area-env-${operatorId}-${area.id}`} />
              </label>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          className="flex-1 h-10 rounded-xl"
          onClick={handleSave}
          disabled={!dirty || setUserAssignments.isPending}
          data-testid={`button-by-operator-save-${operatorId}`}
        >
          <Save className="w-4 h-4 mr-1.5" />
          {setUserAssignments.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          className="h-10 rounded-xl"
          onClick={handleReset}
          disabled={!dirty || setUserAssignments.isPending}
          data-testid={`button-by-operator-reset-${operatorId}`}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
