import {
  useGetCurrentShift,
  useGetOperatorStatus,
  useCreateSubmission,
  useReuploadSubmission,
  useGetNextChecks,
  useGetOperatorRecent,
  useGetAreaProfile,
  useGetSubmission,
  useGetActiveNudges,
  getGetSubmissionQueryKey,
  getGetAreaProfileQueryKey,
  AreaStatus,
  RecentSubmission,
  NextCheck,
  AreaProfile,
  getGetCurrentShiftQueryKey,
  getGetOperatorStatusQueryKey,
  getGetNextChecksQueryKey,
  getGetOperatorRecentQueryKey,
  getGetActiveNudgesQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useRef, useEffect, useMemo } from "react";
import {
  Camera,
  Upload,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Info,
  RefreshCw,
  Video,
  Clock,
  Tag,
  Plus,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronDown,
  ChevronUp,
  CalendarClock,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/lib/auth";
import {
  loadCaptureDraft,
  saveCaptureDraft,
  deleteCaptureDraft,
  purgeStaleCaptureDrafts,
} from "@/lib/capture-drafts";

const SHIFT_OPTIONS = [
  { value: "A" as const, label: "Shift A", time: "6 AM – 2 PM" },
  { value: "B" as const, label: "Shift B", time: "2 PM – 10 PM" },
  { value: "C" as const, label: "Shift C", time: "10 PM – 6 AM" },
];

const RECENT_STRIP_PREF_KEY = "operator.recentStrip.collapsed";
const DUE_SOON_THRESHOLD_MS = 60 * 60 * 1000; // 1h

type DueState = "overdue" | "due-soon" | "ok";

function scoreTone(percent: number) {
  if (percent >= 80)
    return { text: "text-emerald-700 dark:text-emerald-300", bg: "bg-emerald-50 dark:bg-emerald-500/15" };
  if (percent >= 60)
    return { text: "text-amber-700 dark:text-amber-300", bg: "bg-amber-50 dark:bg-amber-500/15" };
  return { text: "text-rose-700 dark:text-rose-300", bg: "bg-rose-50 dark:bg-rose-500/15" };
}

function dueStateFor(nc: NextCheck | undefined, now: number): DueState {
  if (!nc) return "ok";
  if (nc.overdue || new Date(nc.nextDueAt).getTime() <= now) return "overdue";
  if (new Date(nc.nextDueAt).getTime() - now <= DUE_SOON_THRESHOLD_MS) return "due-soon";
  return "ok";
}

export default function OperatorHome() {
  // Re-poll the current shift so the suggested shift updates within ~1 minute
  // when the IST shift boundary crosses (e.g. 1:55 PM → 2:05 PM IST).
  const { data: currentShift, isLoading: shiftLoading } = useGetCurrentShift({
    query: { refetchInterval: 60_000, queryKey: getGetCurrentShiftQueryKey() },
  });
  const [selectedShift, setSelectedShift] = useState<"A" | "B" | "C" | null>(null);
  const activeShift = selectedShift ?? currentShift?.shift ?? "A";
  const { data: statuses, isLoading: statusLoading } = useGetOperatorStatus({
    shift: activeShift as "A" | "B" | "C",
  });
  const { data: nextChecks } = useGetNextChecks({
    query: { refetchInterval: 60_000, queryKey: getGetNextChecksQueryKey() },
  });
  const { data: recentRaw } = useGetOperatorRecent(
    { limit: 12 },
    { query: { queryKey: getGetOperatorRecentQueryKey({ limit: 12 }) } }
  );
  const recent = recentRaw ?? [];
  // Pull active nudges from managers periodically. The endpoint is OPERATOR-only
  // and tracks per-recipient seen state server-side via seen_by_user_ids_json,
  // so each operator sees a given nudge exactly once across refetches. We still
  // de-dupe locally to avoid re-toasting within the same page load.
  const { data: activeNudges } = useGetActiveNudges({
    query: { refetchInterval: 60_000, queryKey: getGetActiveNudgesQueryKey() },
  });
  const { toast } = useToast();
  const seenNudgesRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!activeNudges || activeNudges.length === 0) return;
    for (const n of activeNudges) {
      if (seenNudgesRef.current.has(n.id)) continue;
      seenNudgesRef.current.add(n.id);
      toast({
        title: "Manager nudge",
        description: n.machine
          ? `${n.areaName} · ${n.machine} needs a check this shift`
          : `${n.areaName} needs a check this shift`,
      });
    }
  }, [activeNudges, toast]);

  // Build the area-level due map (machine === null entries) for the area grid.
  const areaDueMap = useMemo(() => {
    const m = new Map<number, NextCheck>();
    for (const nc of nextChecks ?? []) {
      if (nc.machine == null && !m.has(nc.areaId)) m.set(nc.areaId, nc);
    }
    return m;
  }, [nextChecks]);

  // Detect overdue transitions (still useful even without the standalone
  // section): surface a toast when a previously-OK area becomes overdue.
  const knownOverdueRef = useRef<Set<string>>(new Set());
  const announcedRef = useRef<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Purge any draft captures older than 24h on each operator-page mount, so
  // stale media doesn't accumulate in IndexedDB across shifts.
  useEffect(() => {
    void purgeStaleCaptureDrafts();
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

  // Sort the area grid: overdue → due-soon → rest, keeping submitted areas at
  // the bottom so the operator's eye lands on what still needs attention.
  const sortedStatuses = useMemo(() => {
    if (!statuses) return [] as AreaStatus[];
    const now = Date.now();
    const priority = (s: AreaStatus): number => {
      if (s.submitted) return 4;
      const due = dueStateFor(areaDueMap.get(s.areaId), now);
      if (due === "overdue") return 0;
      if (due === "due-soon") return 1;
      return 2;
    };
    return [...statuses].sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return a.areaId - b.areaId;
    });
    // tick keeps sorting fresh as time passes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, areaDueMap, tick]);

  // Map submission.id -> RecentSubmission so AreaCard can read prior-week best
  // for the encouragement chip without a second fetch.
  const recentBySubmissionId = useMemo(() => {
    const m = new Map<number, RecentSubmission>();
    for (const r of recent) m.set(r.id, r);
    return m;
  }, [recent]);

  // For each area, surface the operator's most recent "good" submission (≥80%)
  // so the capture sheet can show "Last good: NN% on <date>" and prime the
  // operator with what passing looked like.
  const lastGoodByAreaId = useMemo(() => {
    const m = new Map<number, { scorePercent: number; createdAt: string }>();
    // recent is DESC by createdAt; first hit per area is the most recent good.
    for (const r of recent) {
      if (m.has(r.areaId)) continue;
      const pct = Math.round(r.scoreTotal * 4);
      if (pct >= 80) m.set(r.areaId, { scorePercent: pct, createdAt: r.createdAt });
    }
    return m;
  }, [recent]);

  if (shiftLoading || statusLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const completed = statuses?.filter((s) => s.submitted).length || 0;
  const total = statuses?.length || 0;

  return (
    <div className="space-y-8 pb-20">
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
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
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
                    <span
                      className={`ml-2 inline-flex items-center w-1.5 h-1.5 rounded-full ${
                        active ? "bg-emerald-500" : "bg-emerald-400"
                      }`}
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <RecentAuditsStrip recent={recent} />

      <section className="space-y-5">
        <h2 className="text-xl font-semibold tracking-tight">Assigned areas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <AnimatePresence mode="popLayout" initial={false}>
            {sortedStatuses.map((status) => (
              <motion.div
                key={`${status.areaId}-${status.submitted ? "done" : "pending"}`}
                layout
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
              >
                <AreaCard
                  status={status}
                  selectedShift={activeShift}
                  dueState={dueStateFor(areaDueMap.get(status.areaId), Date.now())}
                  dueInfo={areaDueMap.get(status.areaId)}
                  recentForSubmission={
                    status.submitted && status.submission
                      ? recentBySubmissionId.get(status.submission.id)
                      : undefined
                  }
                  lastGood={lastGoodByAreaId.get(status.areaId) ?? null}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {statuses?.length === 0 && (
            <p className="text-muted-foreground py-12 text-center col-span-full">
              No areas assigned for this shift.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/* ----------------------------- Recent strip ------------------------------ */

function RecentAuditsStrip({ recent }: { recent: RecentSubmission[] }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RECENT_STRIP_PREF_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [openSubId, setOpenSubId] = useState<number | null>(null);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RECENT_STRIP_PREF_KEY, next ? "1" : "0");
      } catch {
        // ignore quota / privacy mode
      }
      return next;
    });
  };

  if (!recent || recent.length === 0) return null;

  const items = recent.slice(0, 6);

  return (
    <section aria-label="Your recent audits" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Your recent audits</h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="recent-audits-list"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors min-h-[44px] px-2"
          data-testid="button-toggle-recent-audits"
        >
          {collapsed ? (
            <>
              Show <ChevronDown className="w-4 h-4" />
            </>
          ) : (
            <>
              Hide <ChevronUp className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            id="recent-audits-list"
            key="recent-strip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
              {items.map((r) => (
                <RecentAuditCard key={r.id} recent={r} onOpen={() => setOpenSubId(r.id)} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <RecentDetailDialog
        submissionId={openSubId}
        onClose={() => setOpenSubId(null)}
      />
    </section>
  );
}

function RecentAuditCard({
  recent,
  onOpen,
}: {
  recent: RecentSubmission;
  onOpen: () => void;
}) {
  const percent = recent.scoreTotal * 4;
  const tone = scoreTone(percent);
  const prevPercent = recent.prevScoreTotal != null ? recent.prevScoreTotal * 4 : null;
  const delta = prevPercent != null ? Math.round(percent - prevPercent) : null;

  let trendIcon: React.ReactNode = null;
  let trendLabel = "";
  if (delta != null) {
    if (delta > 0) {
      trendIcon = <TrendingUp className="w-3 h-3" />;
      trendLabel = `+${delta} pts vs last`;
    } else if (delta < 0) {
      trendIcon = <TrendingDown className="w-3 h-3" />;
      trendLabel = `${delta} pts vs last`;
    } else {
      trendIcon = <Minus className="w-3 h-3" />;
      trendLabel = "same as last";
    }
  } else {
    trendLabel = "First submission";
  }

  const trendColor =
    delta != null && delta > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : delta != null && delta < 0
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";

  // Show up to 2 outstanding actions inline so the operator can prioritize
  // re-captures while walking the floor. The trend line stays directly under
  // the score; actions sit between the trend line and the timestamp footer
  // (which is pinned to the bottom via mt-auto so a long action label can
  // never push the trend off-card).
  const topActions = recent.topActions ?? [];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="snap-start shrink-0 w-[200px] min-h-[112px] text-left bg-card rounded-2xl shadow-soft p-4 flex flex-col gap-2 hover:shadow-elevated active:scale-[0.99] transition-all motion-reduce:active:scale-100 motion-reduce:transition-none"
      data-testid={`recent-card-${recent.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-[14px] tracking-tight leading-snug line-clamp-2">
          {recent.areaName}
        </p>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[11.5px] font-semibold ${tone.bg} ${tone.text}`}
        >
          {Math.round(percent)}%
        </span>
      </div>
      <div className={`inline-flex items-center gap-1 text-[11.5px] font-medium ${trendColor}`}>
        {trendIcon}
        <span>{trendLabel}</span>
      </div>
      {topActions.length > 0 && (
        <ul
          className="space-y-1"
          aria-label="Top action items"
          data-testid={`recent-card-actions-${recent.id}`}
        >
          {topActions.map((action, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11.5px] text-foreground/80 leading-snug"
            >
              <ArrowRight className="w-3 h-3 text-primary shrink-0 mt-0.5" aria-hidden="true" />
              {/* min-w-0 lets the flex child shrink below its intrinsic width
                  so the truncate/ellipsis actually kicks in on long labels. */}
              <span className="truncate min-w-0" title={action}>
                {action}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground mt-auto">
        Shift {recent.shift} · {format(new Date(recent.createdAt), "MMM d, h:mm a")}
      </p>
    </button>
  );
}

function RecentDetailDialog({
  submissionId,
  onClose,
}: {
  submissionId: number | null;
  onClose: () => void;
}) {
  const open = submissionId != null;
  const { data, isLoading } = useGetSubmission(submissionId ?? 0, {
    query: {
      enabled: open && submissionId != null,
      queryKey: getGetSubmissionQueryKey(submissionId ?? 0),
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">{data?.areaName ?? "Submission"}</DialogTitle>
          <DialogDescription>
            {data ? `Submitted ${format(new Date(data.createdAt), "MMM d, h:mm a")}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <div className="py-6 flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted border-t-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl overflow-hidden bg-secondary/60">
              {data.mediaType === "video" && data.keyframesJson && data.keyframesJson.length > 0 ? (
                <img
                  src={`/api${data.keyframesJson[0]}`}
                  alt={data.areaName}
                  className="w-full h-56 object-cover"
                />
              ) : (
                <img
                  src={`/api${data.imageUrl}`}
                  alt={data.areaName}
                  className="w-full h-56 object-cover"
                />
              )}
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-muted-foreground">Score</p>
              <span
                className={`px-3 py-1 rounded-full text-[13px] font-semibold ${
                  scoreTone(data.scoreTotal * 4).bg
                } ${scoreTone(data.scoreTotal * 4).text}`}
              >
                {Math.round(data.scoreTotal * 4)}%
              </span>
            </div>
            {data.suggestionsJson && data.suggestionsJson.length > 0 && (
              <div className="space-y-1.5">
                <p className="eyebrow flex items-center gap-1.5">
                  <Info className="w-3 h-3" /> Action items
                </p>
                <ul className="space-y-2">
                  {data.suggestionsJson.map((s: string, i: number) => (
                    <li
                      key={i}
                      className="text-[13.5px] flex gap-2 items-start bg-secondary/60 p-3 rounded-xl"
                    >
                      <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span className="leading-snug text-foreground/90">{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ Area card -------------------------------- */

function AreaCard({
  status,
  selectedShift,
  dueState,
  dueInfo,
  recentForSubmission,
  lastGood,
}: {
  status: AreaStatus;
  selectedShift: "A" | "B" | "C";
  dueState: DueState;
  dueInfo: NextCheck | undefined;
  recentForSubmission: RecentSubmission | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
}) {
  const [isCaptureOpen, setIsCaptureOpen] = useState(false);
  const [isReuploadMode, setIsReuploadMode] = useState(false);
  const [media, setMedia] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [machineTag, setMachineTag] = useState("");
  // Per (operator, area) resumable draft. Hydrated from IndexedDB on mount so
  // operators don't lose media/tag if they switch apps or get interrupted.
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const draftHydratedRef = useRef(false);

  const recordVideoInputRef = useRef<HTMLInputElement>(null);
  const pickVideoInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const createSubmission = useCreateSubmission();
  const reuploadSubmission = useReuploadSubmission();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const operatorId = user?.id ?? null;

  // Lazily fetch the learned profile only when the capture sheet is open, so
  // the operator sees "what good looks like" without paying the cost up-front.
  const { data: profile } = useGetAreaProfile(status.areaId, {
    query: {
      enabled: isCaptureOpen,
      queryKey: getGetAreaProfileQueryKey(status.areaId),
    },
  });

  const isVideo = (f: File | null) => !!f && f.type.startsWith("video/");

  // Hydrate any saved draft for this (operator, area) once on mount. We only
  // resume drafts in the "create" flow — once submitted, the operator uses
  // the re-capture flow which doesn't rely on local drafts.
  useEffect(() => {
    if (draftHydratedRef.current) return;
    if (operatorId == null) return;
    if (status.submitted) return;
    draftHydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      const draft = await loadCaptureDraft(operatorId, status.areaId);
      if (cancelled || !draft) return;
      const file = new File([draft.media], draft.mediaName || "capture", {
        type: draft.mediaType || draft.media.type || "application/octet-stream",
      });
      setMedia(file);
      setMachineTag(draft.machineTag || "");
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(draft.media);
      });
      setDraftSavedAt(draft.savedAt);
    })();
    return () => {
      cancelled = true;
    };
  }, [operatorId, status.areaId, status.submitted]);

  // Persist the in-progress capture (debounced) so a swipe-away or signal drop
  // doesn't lose what the operator just selected.
  useEffect(() => {
    if (operatorId == null) return;
    if (status.submitted) return;
    if (isReuploadMode) return; // re-capture is a separate, non-draftable flow
    if (!media) return;
    const handle = setTimeout(() => {
      const savedAt = Date.now();
      void saveCaptureDraft({
        operatorId,
        areaId: status.areaId,
        media,
        mediaName: media.name || "capture",
        mediaType: media.type || "application/octet-stream",
        machineTag,
        savedAt,
      }).then(() => setDraftSavedAt(savedAt));
    }, 300);
    return () => clearTimeout(handle);
  }, [operatorId, status.areaId, status.submitted, isReuploadMode, media, machineTag]);

  const clearLocalCaptureState = () => {
    setMedia(null);
    setMachineTag("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraftSavedAt(null);
  };

  const handleFileSelect = (mode: "create" | "reupload") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMedia(file);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
      setIsReuploadMode(mode === "reupload");
      setIsCaptureOpen(true);
    }
    // reset input so picking the same file twice still triggers change
    e.target.value = "";
  };

  const openCaptureSheet = () => {
    setIsReuploadMode(false);
    // If we hydrated a draft (media present from a prior session), keep it so
    // the operator can resume; otherwise start clean.
    if (!media) {
      setMachineTag("");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setIsCaptureOpen(true);
  };

  const openReuploadSheet = () => {
    setIsReuploadMode(true);
    setMedia(null);
    setMachineTag(status.submission?.machineTag ?? "");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setDraftSavedAt(null);
    setIsCaptureOpen(true);
  };

  const closeCapture = () => {
    setIsCaptureOpen(false);
    if (isReuploadMode) {
      // Re-capture state is ephemeral — don't carry it over to the next open.
      setIsReuploadMode(false);
      clearLocalCaptureState();
    }
    // For the create flow we intentionally keep media + tag so that reopening
    // "Add evidence" resumes the in-progress draft.
  };

  const discardDraft = async () => {
    if (operatorId != null) {
      await deleteCaptureDraft(operatorId, status.areaId);
    }
    clearLocalCaptureState();
  };

  const onSuccess = (msg: string) => {
    toast({
      title: msg,
      description: isVideo(media) ? "Walk-through scored across keyframes." : "Photo scored.",
    });
    queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetNextChecksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOperatorRecentQueryKey({ limit: 12 }) });
    if (operatorId != null && !isReuploadMode) {
      void deleteCaptureDraft(operatorId, status.areaId);
    }
    setIsCaptureOpen(false);
    setIsReuploadMode(false);
    clearLocalCaptureState();
  };

  const handleSubmit = () => {
    if (!media) return;
    const tag = machineTag.trim() || undefined;
    if (isReuploadMode && status.submission) {
      reuploadSubmission.mutate(
        {
          id: status.submission.id,
          data: { media: media as Blob, shift: selectedShift, machineTag: tag },
        },
        {
          onSuccess: () => onSuccess("Walk-through re-uploaded"),
          onError: () =>
            toast({
              variant: "destructive",
              title: "Re-upload failed",
              description: "There was an error uploading. Please try again.",
            }),
        }
      );
    } else {
      createSubmission.mutate(
        {
          data: {
            areaId: status.areaId,
            media: media as Blob,
            shift: selectedShift,
            machineTag: tag,
          },
        },
        {
          onSuccess: () => onSuccess("Submitted"),
          onError: () =>
            toast({
              variant: "destructive",
              title: "Submission failed",
              description: "There was an error uploading. Please try again.",
            }),
        }
      );
    }
  };

  const triggerRecord = () => {
    if (recordVideoInputRef.current) {
      recordVideoInputRef.current.setAttribute("capture", "environment");
      recordVideoInputRef.current.click();
    }
  };
  const triggerPickVideo = () => {
    if (pickVideoInputRef.current) {
      pickVideoInputRef.current.removeAttribute("capture");
      pickVideoInputRef.current.click();
    }
  };
  const triggerPhoto = () => {
    if (photoInputRef.current) {
      photoInputRef.current.setAttribute("capture", "environment");
      photoInputRef.current.click();
    }
  };

  const isMutating = createSubmission.isPending || reuploadSubmission.isPending;

  /* ------------------- Submitted (completed) variant -------------------- */

  if (status.submitted && status.submission) {
    const sub = status.submission;
    const scorePercent = sub.scoreTotal * 4;
    const tone = scoreTone(scorePercent);
    const isVideoSub = sub.mediaType === "video";

    // Encouragement chip: only on great submissions, only if it beats the
    // operator's prior best for the area in the last 7 days. Falls back to
    // "+N vs last time" when there is a prior submission but no week-best.
    const ctx = recentForSubmission;
    let encouragement: { kind: "best" | "delta"; label: string } | null = null;
    if (ctx && ctx.scoreTotal === sub.scoreTotal && scorePercent >= 80) {
      if (
        ctx.bestScoreInLastWeek == null ||
        ctx.scoreTotal > ctx.bestScoreInLastWeek
      ) {
        encouragement = { kind: "best", label: "New best this week" };
      } else if (ctx.prevScoreTotal != null && ctx.scoreTotal > ctx.prevScoreTotal) {
        const delta = Math.round((ctx.scoreTotal - ctx.prevScoreTotal) * 4);
        if (delta > 0) encouragement = { kind: "delta", label: `+${delta} vs last time` };
      }
    }

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
          <div className="px-5 pt-4 pb-2 flex items-center gap-2 text-emerald-600 dark:text-emerald-400 flex-wrap">
            <CheckCircle2 className="w-[18px] h-[18px]" />
            <span className="text-[13px] font-semibold">Completed</span>
            {sub.machineTag && (
              <span className="ml-2 text-[11.5px] inline-flex items-center gap-1 text-muted-foreground">
                <Tag className="w-3 h-3" /> {sub.machineTag}
              </span>
            )}
            {encouragement && (
              <motion.span
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200"
                data-testid={`chip-encouragement-${sub.id}`}
              >
                <Sparkles className="w-3 h-3" />
                {encouragement.label}
              </motion.span>
            )}
          </div>
          <div className="px-5 pb-5 flex-1">
            <p className="eyebrow flex items-center gap-1.5 mb-3">
              <Info className="w-3 h-3" /> Action items
            </p>
            <ul className="space-y-2">
              {sub.suggestionsJson?.map((s, i) => (
                <li key={i} className="text-[13.5px] flex gap-2 items-start bg-secondary/60 p-3 rounded-xl">
                  <ArrowRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span className="leading-snug text-foreground/90">{s}</span>
                </li>
              ))}
              {(!sub.suggestionsJson || sub.suggestionsJson.length === 0) && (
                <li className="text-[13.5px] text-muted-foreground italic bg-secondary/60 p-3 rounded-xl">
                  No immediate action required.
                </li>
              )}
            </ul>
          </div>
          <div className="p-4 border-t border-border/70">
            <Button
              variant="outline"
              className="w-full rounded-xl h-11"
              onClick={openReuploadSheet}
              data-testid={`button-recapture-${status.areaId}`}
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Re-capture
            </Button>
          </div>
        </div>

        <CaptureSheet
          open={isCaptureOpen}
          areaName={status.areaName}
          mode={isReuploadMode ? "reupload" : "create"}
          profile={profile}
          lastGood={lastGood}
          previewUrl={previewUrl}
          media={media}
          machineTag={machineTag}
          setMachineTag={setMachineTag}
          isMutating={isMutating}
          draftSavedAt={null}
          onDiscardDraft={null}
          onClose={closeCapture}
          onSubmit={handleSubmit}
          onTriggerRecord={triggerRecord}
          onTriggerPickVideo={triggerPickVideo}
          onTriggerPhoto={triggerPhoto}
        />

        <input
          type="file"
          accept="video/*"
          className="hidden"
          ref={recordVideoInputRef}
          onChange={handleFileSelect("reupload")}
        />
        <input
          type="file"
          accept="video/*"
          className="hidden"
          ref={pickVideoInputRef}
          onChange={handleFileSelect("reupload")}
        />
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={photoInputRef}
          onChange={handleFileSelect("reupload")}
        />
      </>
    );
  }

  /* --------------------- Pending (capture) variant ---------------------- */

  const overdue = dueState === "overdue";
  const dueSoon = dueState === "due-soon";
  const cardBorder = overdue
    ? "ring-1 ring-rose-200 dark:ring-rose-500/30 bg-rose-50/40 dark:bg-rose-500/5"
    : "";

  return (
    <>
      <div
        className={`bg-card rounded-2xl shadow-elevated p-6 flex flex-col h-full transition-all duration-150 hover:shadow-floating active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none ${cardBorder}`}
        data-testid={`area-card-${status.areaId}`}
      >
        <div className="flex justify-between items-start gap-3">
          <div className="space-y-1.5">
            <h3 className="text-[19px] font-semibold tracking-tight">{status.areaName}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-1 rounded-full">
                <AlertTriangle className="w-3.5 h-3.5" /> Pending
              </p>
              {overdue && (
                <p
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-rose-700 dark:text-rose-200 bg-rose-100 dark:bg-rose-500/20 px-2.5 py-1 rounded-full"
                  data-testid={`pill-overdue-${status.areaId}`}
                >
                  <Clock className="w-3.5 h-3.5" /> Overdue
                </p>
              )}
              {!overdue && dueSoon && (
                <p
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-amber-800 dark:text-amber-200 bg-amber-100/80 dark:bg-amber-500/20 px-2.5 py-1 rounded-full"
                  data-testid={`pill-duesoon-${status.areaId}`}
                >
                  <CalendarClock className="w-3.5 h-3.5" /> Due soon
                </p>
              )}
            </div>
            {dueInfo && (overdue || dueSoon) && (
              <p className="text-[12px] text-muted-foreground leading-snug max-w-[34ch]">
                {overdue
                  ? dueInfo.lastCheckAt
                    ? `Last checked ${formatDistanceToNowStrict(new Date(dueInfo.lastCheckAt))} ago.`
                    : "Never checked — capture a baseline."
                  : `Next due in ${formatDistanceToNowStrict(new Date(dueInfo.nextDueAt))}.`}
              </p>
            )}
          </div>
        </div>

        <div className="mt-auto pt-8">
          <Button
            className="w-full h-14 text-[15px] font-semibold rounded-xl shadow-soft"
            onClick={openCaptureSheet}
            data-testid={`button-add-evidence-${status.areaId}`}
          >
            <Plus className="w-5 h-5 mr-2" /> Add evidence
          </Button>
        </div>
      </div>

      <CaptureSheet
        open={isCaptureOpen}
        areaName={status.areaName}
        mode={isReuploadMode ? "reupload" : "create"}
        profile={profile}
        lastGood={lastGood}
        previewUrl={previewUrl}
        media={media}
        machineTag={machineTag}
        setMachineTag={setMachineTag}
        isMutating={isMutating}
        draftSavedAt={isReuploadMode ? null : draftSavedAt}
        onDiscardDraft={isReuploadMode ? null : discardDraft}
        onClose={closeCapture}
        onSubmit={handleSubmit}
        onTriggerRecord={triggerRecord}
        onTriggerPickVideo={triggerPickVideo}
        onTriggerPhoto={triggerPhoto}
      />

      <input
        type="file"
        accept="video/*"
        className="hidden"
        ref={recordVideoInputRef}
        onChange={handleFileSelect("create")}
      />
      <input
        type="file"
        accept="video/*"
        className="hidden"
        ref={pickVideoInputRef}
        onChange={handleFileSelect("create")}
      />
      <input
        type="file"
        accept="image/*"
        className="hidden"
        ref={photoInputRef}
        onChange={handleFileSelect("create")}
      />
    </>
  );
}

/* ----------------------------- Capture sheet ----------------------------- */

function CaptureSheet({
  open,
  areaName,
  mode,
  profile,
  lastGood,
  previewUrl,
  media,
  machineTag,
  setMachineTag,
  isMutating,
  draftSavedAt,
  onDiscardDraft,
  onClose,
  onSubmit,
  onTriggerRecord,
  onTriggerPickVideo,
  onTriggerPhoto,
}: {
  open: boolean;
  areaName: string;
  mode: "create" | "reupload";
  profile: AreaProfile | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
  previewUrl: string | null;
  media: File | null;
  machineTag: string;
  setMachineTag: (v: string) => void;
  isMutating: boolean;
  draftSavedAt: number | null;
  onDiscardDraft: (() => void) | null;
  onClose: () => void;
  onSubmit: () => void;
  onTriggerRecord: () => void;
  onTriggerPickVideo: () => void;
  onTriggerPhoto: () => void;
}) {
  const isVideo = !!media && media.type.startsWith("video/");
  const title = mode === "reupload" ? `Re-capture for ${areaName}` : `Add evidence for ${areaName}`;
  const description =
    mode === "reupload"
      ? "This will replace the current capture and re-score the submission."
      : "Capture a walk-through video, pick a file, or take a photo. The submission is scored automatically.";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[92vh] overflow-y-auto p-5 sm:p-6 sm:max-w-md sm:left-1/2 sm:-translate-x-1/2 sm:rounded-2xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:border-t"
        data-testid="sheet-capture"
      >
        <SheetHeader className="text-left mb-2">
          <SheetTitle className="text-xl">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 my-2">
          {mode === "create" && draftSavedAt != null && media && (
            <div
              className="flex items-center gap-2 rounded-xl border border-dashed border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-200"
              data-testid="banner-resume-draft"
            >
              <RefreshCw className="w-3.5 h-3.5 shrink-0" />
              <span className="leading-snug flex-1">
                Resume draft — saved{" "}
                {formatDistanceToNowStrict(new Date(draftSavedAt), { addSuffix: true })}.
              </span>
              {onDiscardDraft && (
                <button
                  type="button"
                  onClick={onDiscardDraft}
                  className="text-[12px] font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 min-h-[28px] px-1"
                  data-testid="button-discard-draft"
                >
                  Discard
                </button>
              )}
            </div>
          )}

          <ProfileHint profile={profile} lastGood={lastGood} />

          {previewUrl ? (
            <div className="space-y-2">
              <p className="eyebrow">Preview</p>
              <div className="rounded-xl overflow-hidden bg-secondary/60">
                {isVideo ? (
                  <video src={previewUrl} controls className="w-full max-h-64" />
                ) : (
                  <img src={previewUrl} alt="Preview" className="w-full h-56 object-contain" />
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="eyebrow">Add evidence</p>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerRecord}
                  data-testid="button-capture-record"
                >
                  <Video className="w-5 h-5 mr-2" /> Record walk-through
                </Button>
                <Button
                  variant="outline"
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerPickVideo}
                  data-testid="button-capture-pick"
                >
                  <Upload className="w-5 h-5 mr-2" /> Choose video file
                </Button>
                <Button
                  variant="outline"
                  className="h-12 rounded-xl justify-start"
                  onClick={onTriggerPhoto}
                  data-testid="button-capture-photo"
                >
                  <Camera className="w-5 h-5 mr-2" /> Take photo
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="eyebrow inline-flex items-center gap-1.5">
              <Tag className="w-3 h-3" /> Machine / sub-area (optional)
            </label>
            <Input
              value={machineTag}
              onChange={(e) => setMachineTag(e.target.value)}
              placeholder="e.g. Mixer #2"
              className="h-11 rounded-xl bg-secondary/60 border-transparent focus-visible:bg-card focus-visible:border-ring"
              data-testid="input-machine-tag"
            />
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 rounded-xl h-11"
            onClick={onClose}
            data-testid="button-capture-cancel"
          >
            Cancel
          </Button>
          <Button
            className="flex-1 rounded-xl h-11"
            onClick={onSubmit}
            disabled={isMutating || !media}
            data-testid="button-capture-submit"
          >
            {isMutating ? "Scoring…" : mode === "reupload" ? "Re-submit" : "Submit"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ProfileHint({
  profile,
  lastGood,
}: {
  profile: AreaProfile | undefined;
  lastGood: { scorePercent: number; createdAt: string } | null;
}) {
  const lastGoodLine = lastGood ? (
    <p
      className="text-[11.5px] text-emerald-700 dark:text-emerald-300 leading-snug"
      data-testid="profile-last-good"
    >
      Last good: <span className="font-semibold">{lastGood.scorePercent}%</span>{" "}
      on {format(new Date(lastGood.createdAt), "MMM d")} (
      {formatDistanceToNowStrict(new Date(lastGood.createdAt), { addSuffix: true })})
    </p>
  ) : null;

  if (!profile) {
    return (
      <div className="rounded-xl bg-secondary/60 p-3 space-y-1">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> What good looks like
        </p>
        <p className="text-[12.5px] text-muted-foreground">Loading area profile…</p>
        {lastGoodLine}
      </div>
    );
  }

  const isLearning = profile.status === "LEARNING";
  const machines = profile.machines.slice(0, 4);
  const issues = profile.commonIssues.slice(0, 3);
  const items = profile.items.slice(0, 5);
  const hasContent =
    !!profile.summary || machines.length > 0 || issues.length > 0 || items.length > 0;

  if (isLearning && !hasContent) {
    return (
      <div className="rounded-xl bg-secondary/60 p-3 space-y-1">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> What good looks like
        </p>
        <p className="text-[12.5px] text-muted-foreground leading-snug">
          AI is still learning this area — submit a few clean walk-throughs to teach it.
        </p>
        {lastGoodLine}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-secondary/60 p-3 space-y-2">
      <p className="eyebrow inline-flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" /> What good looks like
      </p>
      {profile.summary && (
        <p className="text-[12.5px] text-foreground/85 leading-snug">{profile.summary}</p>
      )}
      {machines.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Capture: </span>
          <span className="text-foreground/85">{machines.join(" · ")}</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Expected items: </span>
          <span className="text-foreground/85">{items.join(", ")}</span>
        </div>
      )}
      {issues.length > 0 && (
        <div className="text-[12px] leading-snug">
          <span className="text-muted-foreground">Watch out for: </span>
          <span className="text-foreground/85">{issues.join("; ")}</span>
        </div>
      )}
      {lastGoodLine}
      {isLearning && (
        <p className="text-[11.5px] text-muted-foreground italic">
          Profile still learning — a few more walk-throughs will sharpen this.
        </p>
      )}
    </div>
  );
}
