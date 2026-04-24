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
import { Activity, AlertTriangle, Bell, BellOff, CheckCircle2, Clock, Eye, Inbox, MapPin, Sparkles } from "lucide-react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { useShiftConfig } from "@/lib/shift-config";

function timeAgo(d: Date | string | null | undefined) {
  if (!d) return null;
  return formatDistanceToNowStrict(new Date(d), { addSuffix: true });
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
      className="rounded-full h-8 text-[12px]"
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
}: {
  at: Date | string;
  byEmail?: string | null;
}) {
  const shortName = byEmail ? byEmail.split("@")[0] : null;
  const label = shortName ? `Dismissed by ${shortName}@…` : "Operator dismissed";
  const title = byEmail
    ? `${byEmail} dismissed the nudge without submitting fresh evidence`
    : "Operator dismissed the nudge without submitting fresh evidence";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15 rounded-full px-2 py-0.5 mt-1.5"
      title={title}
      data-testid="indicator-operator-dismissed"
    >
      <BellOff className="w-3 h-3" />
      {label} {timeAgo(at)}
    </span>
  );
}

function PendingAreaCard({ item, shift }: { item: LiveShiftPendingArea; shift: CreateNudgeBodyShift }) {
  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 flex items-center justify-between gap-3" data-testid={`card-pending-${item.areaId}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <p className="font-medium text-[14px] truncate">{item.areaName}</p>
        </div>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          No submission yet this shift
          {item.lastNudgeAt && ` · last nudged ${timeAgo(item.lastNudgeAt)}`}
        </p>
        {item.lastOperatorDismissedNudgeAt && (
          <DismissedWithoutSubmitChip
            at={item.lastOperatorDismissedNudgeAt}
            byEmail={item.lastOperatorDismissedNudgeByEmail}
          />
        )}
      </div>
      <NudgeButton areaId={item.areaId} shift={shift} lastNudgeAt={item.lastNudgeAt} />
    </div>
  );
}

function OverdueCard({ item, shift }: { item: LiveShiftOverdueCheck; shift: CreateNudgeBodyShift }) {
  const hours = Math.floor(item.overdueSinceMinutes / 60);
  const minutes = item.overdueSinceMinutes % 60;
  const overdueText = hours > 0 ? `${hours}h ${minutes}m overdue` : `${minutes}m overdue`;

  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 flex items-center justify-between gap-3" data-testid={`card-overdue-${item.areaId}-${item.machine ?? "area"}`}>
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
          {item.lastNudgeAt && ` · last nudged ${timeAgo(item.lastNudgeAt)}`}
        </p>
        {item.lastOperatorDismissedNudgeAt && (
          <DismissedWithoutSubmitChip
            at={item.lastOperatorDismissedNudgeAt}
            byEmail={item.lastOperatorDismissedNudgeByEmail}
          />
        )}
      </div>
      <NudgeButton areaId={item.areaId} machine={item.machine ?? undefined} shift={shift} lastNudgeAt={item.lastNudgeAt} />
    </div>
  );
}

function LowScoringRow({ item }: { item: LiveShiftLowScoring }) {
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
        <img src={`/api${item.thumbnailUrl}`} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-[14px] truncate">{item.areaName}</p>
        <p className="text-[12px] text-muted-foreground truncate">
          {item.operatorEmail} · {format(new Date(item.createdAt), "h:mm a")}
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
    <div className="bg-card rounded-2xl shadow-soft p-4 flex items-center justify-between gap-3" data-testid={`card-live-escalation-${item.id}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <p className="font-medium text-[14px] truncate">{item.areaName}</p>
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
            {item.scorePercent}%
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          {item.operatorEmail} · {timeAgo(item.createdAt)}
          {item.failingPillars.length > 0 && ` · failing ${item.failingPillars.join(", ")}`}
        </p>
      </div>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="rounded-full h-8"
          disabled={ack.isPending}
          onClick={() => ack.mutate({ id: item.id }, { onSuccess: () => { toast({ title: "Acknowledged" }); invalidate(); } })}
          data-testid={`button-live-ack-${item.id}`}
        >
          <Eye className="w-3.5 h-3.5 mr-1" /> Ack
        </Button>
        <Button
          size="sm"
          className="rounded-full h-8"
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

export default function LiveShiftPage() {
  const { data, isLoading } = useGetLiveShift({
    query: { refetchInterval: 30_000, queryKey: getGetLiveShiftQueryKey() },
  });
  const { tzLabel, formatClockTime, formatDayTime } = useShiftConfig();

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const shift = data.shift as CreateNudgeBodyShift;
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);
  const totalThings =
    data.pendingAreas.length + data.overdueChecks.length + data.lowScoring.length + data.openEscalations.length;

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Activity className="w-3 h-3" /> Now
        </p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Live shift {shift}</h1>
        <p className="text-muted-foreground text-[15px]">
          {formatDayTime(startsAt)} – {formatClockTime(endsAt)} {tzLabel} · {totalThings === 0 ? "all clear" : `${totalThings} thing${totalThings === 1 ? "" : "s"} need attention`}
        </p>
      </header>

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
