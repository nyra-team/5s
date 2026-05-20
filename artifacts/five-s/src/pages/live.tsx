import {
  useGetLiveShift,
  useCreateNudge,
  useAcknowledgeEscalation,
  useResolveEscalation,
  getGetLiveShiftQueryKey,
  getGetEscalationCountQueryKey,
  getListEscalationsQueryKey,
  type LiveShiftPendingArea,
  type LiveShiftOverdueCheck,
  type LiveShiftLowScoring,
  type Escalation,
  type CreateNudgeBodyShift,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Bell, BellOff, BellRing, CheckCircle2, ChevronRight, Clock, Eye, Inbox, MapPin, Sparkles, type LucideIcon } from "lucide-react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "wouter";
import { useShiftConfig } from "@/lib/shift-config";
import { useMinuteTick } from "@/hooks/use-minute-tick";
import { MaskedImage, extractRegions } from "@/components/masked-image";

// Renders a relative "x ago" label that ticks every minute via the shared
// minute-tick subscription, and exposes the absolute timestamp on hover via a
// `title` attribute. Returning null for missing dates lets callers treat it as
// optional inline content.
function Ago({ d }: { d: Date | string | null | undefined }) {
  useMinuteTick();
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={format(date, "MMM d, yyyy h:mm a")}
    >
      {formatDistanceToNowStrict(date, { addSuffix: true })}
    </time>
  );
}

function NudgeButton({
  areaId,
  machine,
  shift,
  lastNudgeAt,
}: {
  areaId: number;
  machine?: string | null;
  shift: CreateNudgeBodyShift;
  lastNudgeAt?: Date | string | null;
}) {
  const createNudge = useCreateNudge();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const onClick = () => {
    createNudge.mutate(
      { data: { areaId, machine: machine ?? undefined, shift } },
      {
        onSuccess: () => {
          toast({
            title: "Nudge sent",
            description: machine ? `Operator will see it on ${machine}` : "Operator will see it on next page load",
          });
          queryClient.invalidateQueries({ queryKey: getGetLiveShiftQueryKey() });
        },
        onError: () => toast({ variant: "destructive", title: "Failed to send nudge" }),
      },
    );
  };

  const recent = lastNudgeAt && Date.now() - new Date(lastNudgeAt).getTime() < 30 * 60 * 1000;

  return (
    <Button
      size="sm"
      variant={recent ? "outline" : "secondary"}
      className="rounded-full h-10 text-[12px] px-4"
      onClick={onClick}
      disabled={createNudge.isPending}
      data-testid={`button-nudge-area-${areaId}${machine ? `-${machine}` : ""}`}
    >
      <Bell className="w-3.5 h-3.5 mr-1.5" />
      {recent ? "Nudge sent" : "Nudge operator"}
    </Button>
  );
}

function DismissedWithoutSubmitChip({
  at,
  byEmail,
  byDisplayName,
}: {
  at: Date | string;
  byEmail?: string | null;
  byDisplayName?: string | null;
}) {
  // Prefer the human-readable name when the operator has one set; otherwise
  // fall back to the email's local-part (with a trailing "@…" so it's clear
  // we've truncated). Only when both are missing do we use the generic copy.
  const trimmedDisplayName = byDisplayName?.trim() || null;
  const shortName = byEmail ? byEmail.split("@")[0] : null;
  const label = trimmedDisplayName
    ? `Dismissed by ${trimmedDisplayName}`
    : shortName
      ? `Dismissed by ${shortName}@…`
      : "Operator dismissed";
  const title = trimmedDisplayName
    ? `${trimmedDisplayName}${byEmail ? ` (${byEmail})` : ""} dismissed the nudge without submitting fresh evidence`
    : byEmail
      ? `${byEmail} dismissed the nudge without submitting fresh evidence`
      : "Operator dismissed the nudge without submitting fresh evidence";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 rounded-full px-2 py-0.5 mt-1.5"
      title={title}
      data-testid="indicator-operator-dismissed"
    >
      <BellOff className="w-3 h-3" />
      {label} <Ago d={at} />
    </span>
  );
}

function PendingAreaCard({ item, shift }: { item: LiveShiftPendingArea; shift: CreateNudgeBodyShift }) {
  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" data-testid={`card-pending-${item.areaId}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <p className="font-medium text-[14px] truncate">{item.areaName}</p>
        </div>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          No submission yet this shift
          {item.lastNudgeAt && (
            <>
              {" · last nudged "}
              <Ago d={item.lastNudgeAt} />
            </>
          )}
        </p>
        {item.lastOperatorDismissedNudgeAt && (
          <DismissedWithoutSubmitChip
            at={item.lastOperatorDismissedNudgeAt}
            byEmail={item.lastOperatorDismissedNudgeByEmail}
            byDisplayName={item.lastOperatorDismissedNudgeByDisplayName}
          />
        )}
      </div>
      <div className="sm:shrink-0 self-start sm:self-auto">
        <NudgeButton areaId={item.areaId} shift={shift} lastNudgeAt={item.lastNudgeAt} />
      </div>
    </div>
  );
}

function OverdueCard({ item, shift }: { item: LiveShiftOverdueCheck; shift: CreateNudgeBodyShift }) {
  const hours = Math.floor(item.overdueSinceMinutes / 60);
  const minutes = item.overdueSinceMinutes % 60;
  const overdueText = hours > 0 ? `${hours}h ${minutes}m overdue` : `${minutes}m overdue`;

  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" data-testid={`card-overdue-${item.areaId}-${item.machine ?? "area"}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="font-medium text-[14px] truncate">
            {item.areaName}
            {item.machine && <span className="text-muted-foreground font-normal"> · {item.machine}</span>}
          </p>
        </div>
        <p className="text-[12px] text-amber-700 dark:text-amber-300 mt-0.5">
          {overdueText}
          {item.lastNudgeAt && (
            <>
              {" · last nudged "}
              <Ago d={item.lastNudgeAt} />
            </>
          )}
        </p>
        {item.lastOperatorDismissedNudgeAt && (
          <DismissedWithoutSubmitChip
            at={item.lastOperatorDismissedNudgeAt}
            byEmail={item.lastOperatorDismissedNudgeByEmail}
            byDisplayName={item.lastOperatorDismissedNudgeByDisplayName}
          />
        )}
      </div>
      <div className="sm:shrink-0 self-start sm:self-auto">
        <NudgeButton areaId={item.areaId} machine={item.machine ?? undefined} shift={shift} lastNudgeAt={item.lastNudgeAt} />
      </div>
    </div>
  );
}

function LowScoringRow({ item }: { item: LiveShiftLowScoring }) {
  const { formatClockTime } = useShiftConfig();
  const tone =
    item.scorePercent < 40
      ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
      : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300";
  return (
    <Link
      href={`/submissions?focus=${item.submissionId}`}
      className="bg-card rounded-2xl shadow-soft p-3 flex items-center gap-3 transition-shadow hover:shadow-elevated"
      data-testid={`card-low-${item.submissionId}`}
    >
      <div className="w-14 h-14 rounded-xl overflow-hidden bg-secondary shrink-0">
        <MaskedImage
          src={`/api${item.thumbnailUrl}`}
          alt=""
          regions={extractRegions((item as any).aiIssuesJson)}
          frameIndex={0}
          className="w-full h-full"
          imgClassName="w-full h-full object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[14px] truncate">{item.areaName}</p>
        <p className="text-[12px] text-muted-foreground truncate">
          {item.operatorEmail} · {formatClockTime(new Date(item.createdAt))}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className={`px-2.5 py-0.5 rounded-full text-[12px] font-bold ${tone}`}>{item.scorePercent}%</span>
        {item.hasOpenEscalation && (
          <span className="text-[10px] uppercase tracking-wide font-semibold text-rose-600 dark:text-rose-300 inline-flex items-center gap-1">
            <Inbox className="w-3 h-3" /> Escalated
          </span>
        )}
      </div>
    </Link>
  );
}

function RepingBadge({
  count,
  lastRepingAt,
}: {
  count: number;
  lastRepingAt?: string | Date | null;
}) {
  if (!count || count <= 0) return null;
  const last = lastRepingAt ? new Date(lastRepingAt) : null;
  const ago =
    last && !Number.isNaN(last.getTime())
      ? formatDistanceToNowStrict(last, { addSuffix: true })
      : null;
  const label = `Reminded ${count}x${ago ? ` · ${ago}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200 cursor-help"
          data-testid={`badge-reping-${count}`}
        >
          <BellRing className="w-3 h-3" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-center">
        Managers are auto-reminded a limited number of times per escalation, then pings stop so the inbox doesn't get spammy.
      </TooltipContent>
    </Tooltip>
  );
}

function OpenEscalationRow({ item }: { item: Escalation }) {
  const ack = useAcknowledgeEscalation();
  const resolve = useResolveEscalation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetLiveShiftQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetEscalationCountQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey() });
  };

  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" data-testid={`card-live-escalation-${item.id}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <p className="font-medium text-[14px] truncate min-w-0">{item.areaName}</p>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300 shrink-0">
            {item.scorePercent}%
          </span>
          <RepingBadge count={item.repingCount} lastRepingAt={item.lastRepingAt} />
        </div>
        <p className="text-[12px] text-muted-foreground mt-0.5 break-words">
          {item.operatorEmail} · <Ago d={item.createdAt} />
          {item.failingPillars.length > 0 && ` · failing ${item.failingPillars.join(", ")}`}
        </p>
      </div>
      <div className="flex gap-1.5 sm:shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="rounded-full h-10 px-4 flex-1 sm:flex-none"
          disabled={ack.isPending}
          onClick={() => ack.mutate({ id: item.id }, { onSuccess: () => { toast({ title: "Acknowledged" }); invalidate(); } })}
          data-testid={`button-live-ack-${item.id}`}
        >
          <Eye className="w-3.5 h-3.5 mr-1" /> Ack
        </Button>
        <Button
          size="sm"
          className="rounded-full h-10 px-4 flex-1 sm:flex-none"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ id: item.id }, { onSuccess: () => { toast({ title: "Resolved" }); invalidate(); } })}
          data-testid={`button-live-resolve-${item.id}`}
        >
          <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Resolve
        </Button>
      </div>
    </div>
  );
}

/**
 * Live Shift body — the 4 sections (pending areas, overdue checks, low
 * scoring, open escalations). Renders in two modes:
 *
 *   `compact={true}`  → 4 summary tiles on the Manager Dashboard. One
 *                       tile per category, count + a 1-line "worst
 *                       offender" preview + a click-through to /live.
 *                       Optimised for executive scan; no laundry list.
 *   `compact={false}` → the standalone /live page. Full detailed cards
 *                       per row so a manager triaging the shift can
 *                       nudge individual operators inline.
 */
export function LiveShiftBlock({ compact = false }: { compact?: boolean } = {}) {
  const { data, isLoading } = useGetLiveShift({
    query: { refetchInterval: 30_000, queryKey: getGetLiveShiftQueryKey() },
  });
  const { tzLabel, formatClockTime, formatDayTime } = useShiftConfig();

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const shift = data.shift as CreateNudgeBodyShift;
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  const totalThings =
    data.pendingAreas.length + data.overdueChecks.length + data.lowScoring.length + data.openEscalations.length;
  const summaryLine = `${formatDayTime(startsAt)} – ${formatClockTime(endsAt)} ${tzLabel} · ${
    totalThings === 0 ? "all clear" : `${totalThings} thing${totalThings === 1 ? "" : "s"} need attention`
  }`;

  // ───── Compact mode (dashboard): tiles + click-to-expand inline ─────
  if (compact) {
    return <CompactLiveShift data={data} shift={shift} summaryLine={summaryLine} />;
  }

  // ───── Full mode (/live page): the detailed card grids ─────
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" /> Pending areas
          <span className="text-muted-foreground font-normal">({data.pendingAreas.length})</span>
        </h2>
        {data.pendingAreas.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Every area has at least one submission this shift.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.pendingAreas.map((p) => (
              <PendingAreaCard key={p.areaId} item={p} shift={shift} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold inline-flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-600 dark:text-amber-400" /> Overdue checks
          <span className="text-muted-foreground font-normal">({data.overdueChecks.length})</span>
        </h2>
        {data.overdueChecks.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Cadence is on track.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.overdueChecks.map((o) => (
              <OverdueCard key={`${o.areaId}-${o.machine ?? "area"}`} item={o} shift={shift} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold inline-flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500" /> Low scoring this shift
          <span className="text-muted-foreground font-normal">({data.lowScoring.length})</span>
        </h2>
        {data.lowScoring.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No submissions below 60% so far.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {data.lowScoring.map((l) => (
              <LowScoringRow key={l.submissionId} item={l} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold inline-flex items-center gap-2">
          <Inbox className="w-4 h-4 text-rose-500" /> Open escalations
          <span className="text-muted-foreground font-normal">({data.openEscalations.length})</span>
        </h2>
        {data.openEscalations.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No open escalations.</p>
        ) : (
          <div className="space-y-3">
            {data.openEscalations.map((e) => (
              <OpenEscalationRow key={e.id} item={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Click-to-expand compact view used on the manager dashboard. Each tile
 * is a button; clicking it pins the inline detail panel for that
 * category below the tile row. Click again (or click another tile) to
 * swap. Keeps the dashboard scannable while making the data one click
 * away — no page navigation to /live for the common case.
 */
type LiveShiftCategory = "pending" | "overdue" | "low" | "esc";

function CompactLiveShift({
  data,
  shift,
  summaryLine,
}: {
  data: ReturnType<typeof useGetLiveShift>["data"] & object;
  shift: CreateNudgeBodyShift;
  summaryLine: string;
}) {
  const [openTile, setOpenTile] = useState<LiveShiftCategory | null>(null);

  if (!data) return null;

  const tileFor = (cat: LiveShiftCategory) => () =>
    setOpenTile((current) => (current === cat ? null : cat));

  // Worst-offender previews. Each is computed defensively because the
  // upstream lists can be empty.
  const firstPending = data.pendingAreas[0]?.areaName ?? null;
  // overdueChecks ships sorted by overdueSinceMinutes desc (api side),
  // so [0] is already the worst offender.
  const worstOverdueMinutes = data.overdueChecks[0]?.overdueSinceMinutes ?? 0;
  const worstOverdueLine = data.overdueChecks.length > 0
    ? `${formatOverdueDuration(worstOverdueMinutes)} overdue · top: ${data.overdueChecks[0]?.areaName ?? ""}`
    : null;
  const worstLow = data.lowScoring.reduce<typeof data.lowScoring[number] | null>(
    (acc, l) => (acc === null || l.scorePercent < acc.scorePercent ? l : acc),
    null,
  );
  const worstLowLine = worstLow ? `${worstLow.scorePercent}% · ${worstLow.areaName}` : null;
  const oldestEsc = data.openEscalations[0];
  const escLine = oldestEsc ? `oldest: ${oldestEsc.areaName ?? "—"}` : null;

  const totalThings =
    data.pendingAreas.length + data.overdueChecks.length + data.lowScoring.length + data.openEscalations.length;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div className="space-y-1">
          <p className="eyebrow inline-flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Live shift {shift}
          </p>
          <p className="text-muted-foreground text-[13px]">{summaryLine}</p>
        </div>
        {totalThings > 0 && (
          <Link
            href="/live"
            className="text-[12.5px] text-primary hover:underline inline-flex items-center gap-1"
            data-testid="live-shift-view-all"
          >
            Open full triage <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        )}
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="live-shift-summary-tiles">
        <SummaryTile
          icon={Sparkles}
          tone="neutral"
          label="Pending areas"
          count={data.pendingAreas.length}
          preview={firstPending}
          onClick={tileFor("pending")}
          active={openTile === "pending"}
          testId="tile-pending"
        />
        <SummaryTile
          icon={Clock}
          tone="warn"
          label="Overdue checks"
          count={data.overdueChecks.length}
          preview={worstOverdueLine}
          onClick={tileFor("overdue")}
          active={openTile === "overdue"}
          testId="tile-overdue"
        />
        <SummaryTile
          icon={AlertTriangle}
          tone="bad"
          label="Low scoring"
          count={data.lowScoring.length}
          preview={worstLowLine}
          onClick={tileFor("low")}
          active={openTile === "low"}
          testId="tile-low-scoring"
        />
        <SummaryTile
          icon={Inbox}
          tone="bad"
          label="Open escalations"
          count={data.openEscalations.length}
          preview={escLine}
          onClick={tileFor("esc")}
          active={openTile === "esc"}
          testId="tile-escalations"
        />
      </div>

      {/* Inline detail panel for the currently-open tile. We mount only
          one at a time and keep the markup tight (cards reuse the same
          components as /live so the nudge / acknowledge / resolve actions
          work identically). Empty-state messages match the full-mode
          surface so a manager who knows /live recognises them. */}
      {openTile && (
        <ExpandedPanel
          title={
            openTile === "pending" ? "Pending areas" :
            openTile === "overdue" ? "Overdue checks" :
            openTile === "low" ? "Low scoring this shift" :
            "Open escalations"
          }
          onClose={() => setOpenTile(null)}
          testId={`expanded-panel-${openTile}`}
        >
          {openTile === "pending" && (
            data.pendingAreas.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Every area has at least one submission this shift.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.pendingAreas.map((p) => (
                  <PendingAreaCard key={p.areaId} item={p} shift={shift} />
                ))}
              </div>
            )
          )}
          {openTile === "overdue" && (
            data.overdueChecks.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Cadence is on track.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.overdueChecks.map((o) => (
                  <OverdueCard key={`${o.areaId}-${o.machine ?? "area"}`} item={o} shift={shift} />
                ))}
              </div>
            )
          )}
          {openTile === "low" && (
            data.lowScoring.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No submissions below 60% so far.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.lowScoring.map((l) => (
                  <LowScoringRow key={l.submissionId} item={l} />
                ))}
              </div>
            )
          )}
          {openTile === "esc" && (
            data.openEscalations.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No open escalations.</p>
            ) : (
              <div className="space-y-3">
                {data.openEscalations.map((e) => (
                  <OpenEscalationRow key={e.id} item={e} />
                ))}
              </div>
            )
          )}
        </ExpandedPanel>
      )}
    </div>
  );
}

function ExpandedPanel({
  title,
  onClose,
  testId,
  children,
}: {
  title: string;
  onClose: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="bg-card rounded-2xl shadow-soft border border-slate-200/70 dark:border-border p-5 sm:p-6 space-y-3"
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[12.5px] text-muted-foreground hover:text-foreground transition-colors"
          aria-label={`Close ${title}`}
        >
          Hide
        </button>
      </div>
      {children}
    </section>
  );
}


/**
 * Format a minutes count into the densest unit that still reads cleanly:
 * < 60m → "Nm", < 48h → "Nh", otherwise "Nd". Anything past 2 days is
 * almost always an area that was never set up — bucketing to days makes
 * that visible at a glance instead of buried inside a 4-digit minute count.
 */
function formatOverdueDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalMinutes < 48 * 60) return `${Math.round(totalMinutes / 60)}h`;
  return `${Math.round(totalMinutes / (60 * 24))}d`;
}

/**
 * One summary tile for the compact LiveShiftBlock. Click-through links to
 * the relevant detail surface (/live, /submissions, /escalations). Tone
 * controls only the count's color — the card itself stays white so a
 * dashboard full of tiles doesn't look like a Christmas tree.
 */
function SummaryTile({
  icon: Icon,
  tone,
  label,
  count,
  preview,
  onClick,
  active,
  testId,
}: {
  icon: LucideIcon;
  tone: "neutral" | "warn" | "bad";
  label: string;
  count: number;
  preview: string | null;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  const countTone =
    tone === "bad" && count > 0
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn" && count > 0
      ? "text-amber-600 dark:text-amber-400"
      : "text-foreground";
  const iconTone =
    tone === "bad"
      ? "text-rose-500"
      : tone === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : "text-primary";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      // The `active` ring gives clear feedback for which tile's detail
      // panel is currently expanded below. Hover lifts subtly so a
      // manager scanning the dashboard sees the tiles are clickable.
      className={`text-left bg-card rounded-2xl shadow-soft p-4 flex flex-col gap-2 transition-all hover:shadow-elevated cursor-pointer ${
        active
          ? "ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
          : ""
      }`}
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted-foreground inline-flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${iconTone}`} /> {label}
        </span>
        <ChevronRight
          className={`w-3.5 h-3.5 text-muted-foreground/60 transition-transform ${active ? "rotate-90" : ""}`}
        />
      </div>
      <div className={`text-[28px] font-semibold tabular-nums leading-none ${countTone}`}>
        {count}
      </div>
      <p className="text-[12px] text-muted-foreground truncate min-h-[1em]">
        {count === 0 ? "All clear" : preview ?? ""}
      </p>
    </button>
  );
}

export default function LiveShiftPage() {
  const { data } = useGetLiveShift({
    query: { refetchInterval: 30_000, queryKey: getGetLiveShiftQueryKey() },
  });
  const { tzLabel, formatClockTime, formatDayTime } = useShiftConfig();

  const shift = (data?.shift as CreateNudgeBodyShift | undefined) ?? "A";
  const startsAt = data ? new Date(data.startsAt) : null;
  const endsAt = data ? new Date(data.endsAt) : null;
  const totalThings = data
    ? data.pendingAreas.length + data.overdueChecks.length + data.lowScoring.length + data.openEscalations.length
    : 0;

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Activity className="w-3 h-3" /> Now
        </p>
        <h1 className="text-[26px] sm:text-[34px] font-semibold tracking-tight leading-tight">
          Live shift {shift}
        </h1>
        {startsAt && endsAt && (
          <p className="text-muted-foreground text-[14px] sm:text-[15px] break-words">
            {formatDayTime(startsAt)} – {formatClockTime(endsAt)} {tzLabel} ·{" "}
            {totalThings === 0 ? "all clear" : `${totalThings} thing${totalThings === 1 ? "" : "s"} need attention`}
          </p>
        )}
      </header>
      <LiveShiftBlock />
    </div>
  );
}
