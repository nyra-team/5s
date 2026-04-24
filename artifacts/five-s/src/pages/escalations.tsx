import {
  useListEscalations,
  useAcknowledgeEscalation,
  useResolveEscalation,
  Escalation,
  EscalationNotifyDeliveryStatus,
  getListEscalationsQueryKey,
  getGetEscalationCountQueryKey,
} from "@workspace/api-client-react";
import { useState, useMemo, useEffect, useRef } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, BellRing, CheckCircle2, Eye, Inbox } from "lucide-react";

const STATUSES = [
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "ALL", label: "All" },
] as const;

function readFocusId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("focus");
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default function EscalationsPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]["value"]>(() =>
    readFocusId() ? "ALL" : "OPEN",
  );
  const { data: escalations, isLoading } = useListEscalations({ status });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const ack = useAcknowledgeEscalation();
  const resolve = useResolveEscalation();
  const focusId = readFocusId();
  const focusedRef = useRef(false);

  // Reset selections when the visible list changes (e.g. switching tabs).
  useEffect(() => {
    setSelected(new Set());
  }, [status]);

  // Drop selections that are no longer in the list (e.g. after resolving).
  useEffect(() => {
    if (!escalations) return;
    setSelected((prev) => {
      const visibleIds = new Set(escalations.map((e) => e.id));
      const next = new Set<number>();
      prev.forEach((id) => { if (visibleIds.has(id)) next.add(id); });
      return next.size === prev.size ? prev : next;
    });
  }, [escalations]);

  const selectableCount = useMemo(
    () => (escalations ?? []).filter((e) => e.status !== "RESOLVED").length,
    [escalations],
  );
  const allSelected = selectableCount > 0 && selected.size === selectableCount;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      const next = new Set<number>();
      (escalations ?? []).forEach((e) => { if (e.status !== "RESOLVED") next.add(e.id); });
      setSelected(next);
    }
  };

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetEscalationCountQueryKey() });
  };

  const bulk = async (action: "acknowledge" | "resolve") => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    const all = escalations ?? [];
    const eligible =
      action === "acknowledge"
        ? ids.filter((id) => all.find((e) => e.id === id)?.status === "OPEN")
        : ids.filter((id) => all.find((e) => e.id === id)?.status !== "RESOLVED");

    if (eligible.length === 0) {
      setSelected(new Set());
      return;
    }

    const results = await Promise.allSettled(
      eligible.map((id) =>
        action === "acknowledge"
          ? ack.mutateAsync({ id })
          : resolve.mutateAsync({ id }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.length - ok;
    invalidate();
    setSelected(new Set());
    toast({
      title: action === "acknowledge" ? "Acknowledged" : "Resolved",
      description: fail === 0 ? `${ok} escalation${ok === 1 ? "" : "s"} updated.` : `${ok} updated, ${fail} failed.`,
      variant: fail > 0 ? "destructive" : undefined,
    });
  };

  const isBusy = ack.isPending || resolve.isPending;

  return (
    <div className="space-y-8 pb-32">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5"><Inbox className="w-3 h-3" /> Inbox</p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Escalations</h1>
        <p className="text-muted-foreground text-[15px]">
          Failed audits below 60% are auto-escalated here for manager follow-up.
        </p>
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex p-1 pill-track rounded-full">
          {STATUSES.map((s) => {
            const active = status === s.value;
            return (
              <button
                key={s.value}
                onClick={() => setStatus(s.value)}
                className={`px-4 py-2 rounded-full text-[13px] font-medium transition-colors ${
                  active ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-status-${s.value}`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {selectableCount > 0 && (
          <label className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4 accent-primary"
              data-testid="checkbox-select-all"
            />
            Select all ({selectableCount})
          </label>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
        </div>
      ) : escalations && escalations.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {escalations.map((e) => (
            <EscalationCard
              key={e.id}
              escalation={e}
              selected={selected.has(e.id)}
              onToggleSelect={() => toggleOne(e.id)}
              focused={focusId === e.id}
              onMounted={(node) => {
                if (focusId === e.id && node && !focusedRef.current) {
                  focusedRef.current = true;
                  node.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-500" />
          <p className="text-[15px] font-medium">No escalations</p>
          <p className="text-[13px] mt-1 opacity-80">All recent audits are passing.</p>
        </div>
      )}

      {selected.size > 0 && (
        <div className="fixed bottom-4 left-0 right-0 z-30 px-3 sm:px-8 pointer-events-none">
          {/* On phones the count + 3 buttons collide, so we stack the row and let
              the buttons wrap. Buttons keep their full labels because the action
              bar only ever shows when the manager has a selection. */}
          <div
            className="max-w-3xl mx-auto bg-card shadow-elevated rounded-2xl px-3 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 hairline pointer-events-auto"
            data-testid="bar-bulk-actions"
          >
            <span className="text-[13.5px] font-medium px-1 sm:px-0">
              {selected.size} selected
            </span>
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="rounded-full flex-1 sm:flex-none min-w-0"
                disabled={isBusy}
                onClick={() => bulk("acknowledge")}
                data-testid="button-bulk-ack"
              >
                <Eye className="w-3.5 h-3.5 mr-1 shrink-0" /> Acknowledge
              </Button>
              <Button
                size="sm"
                className="rounded-full flex-1 sm:flex-none min-w-0"
                disabled={isBusy}
                onClick={() => bulk("resolve")}
                data-testid="button-bulk-resolve"
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1 shrink-0" /> Resolve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full shrink-0"
                onClick={() => setSelected(new Set())}
                data-testid="button-bulk-clear"
              >
                Clear
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EscalationCard({
  escalation: e,
  selected,
  onToggleSelect,
  focused,
  onMounted,
}: {
  escalation: Escalation;
  selected: boolean;
  onToggleSelect: () => void;
  focused?: boolean;
  onMounted?: (node: HTMLDivElement | null) => void;
}) {
  const ack = useAcknowledgeEscalation();
  const resolve = useResolveEscalation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const selectable = e.status !== "RESOLVED";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetEscalationCountQueryKey() });
  };

  const tone =
    e.scorePercent < 40
      ? "bg-rose-50 dark:bg-rose-500/12 text-rose-800 dark:text-rose-200"
      : "bg-amber-50 dark:bg-amber-500/12 text-amber-800 dark:text-amber-200";

  return (
    <div
      ref={onMounted}
      className={`bg-card rounded-2xl shadow-soft hover:shadow-elevated transition-shadow p-5 sm:p-6 flex flex-col gap-4 ${
        selected ? "ring-2 ring-primary/60" : focused ? "ring-2 ring-amber-400 ring-offset-2 ring-offset-background" : ""
      }`}
      data-testid={`card-escalation-${e.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {selectable && (
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={selected}
              onChange={onToggleSelect}
              data-testid={`checkbox-select-${e.id}`}
              aria-label={`Select escalation ${e.id}`}
            />
          )}
          <div>
            <p className="eyebrow inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-rose-500" /> Failed audit</p>
            <h3 className="text-[18px] font-semibold tracking-tight mt-1">{e.areaName}</h3>
            <p className="text-[12.5px] text-muted-foreground mt-0.5">
              {format(new Date(e.createdAt), "MMM d, h:mm a")} · {e.operatorEmail}
            </p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-[13px] font-bold ${tone}`}>{e.scorePercent}%</span>
      </div>

      {e.failingPillars.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5">Failing pillars</p>
          <div className="flex flex-wrap gap-1.5">
            {e.failingPillars.map((p) => (
              <span key={p} className="px-2 py-0.5 rounded-full text-[11.5px] font-semibold capitalize bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">{p}</span>
            ))}
          </div>
        </div>
      )}

      {e.evidenceUrls.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {e.evidenceUrls.slice(0, 6).map((u, i) => (
            <a key={i} href={`/api${u}`} target="_blank" rel="noreferrer" className="block w-20 h-16 rounded-lg overflow-hidden bg-secondary shrink-0">
              <img src={`/api${u}`} alt={`Evidence ${i + 1}`} className="w-full h-full object-cover" />
            </a>
          ))}
        </div>
      )}

      {e.recommendedActions.length > 0 && (
        <div>
          <p className="eyebrow mb-1.5">Recommended actions</p>
          <ul className="space-y-1.5">
            {e.recommendedActions.slice(0, 4).map((a, i) => (
              <li key={i} className="text-[13px] bg-secondary/60 px-3 py-2 rounded-lg">{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
            e.status === "OPEN" ? "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200" :
            e.status === "ACKNOWLEDGED" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" :
            "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
          }`}>{e.status}</span>
          <RepingBadge count={e.repingCount} lastRepingAt={e.lastRepingAt} />
          <DeliverySkippedBadge status={e.notifyDeliveryStatus} />
          <NoChannelConfiguredBadge status={e.notifyDeliveryStatus} />
        </div>
        <div className="flex gap-2">
          {e.status === "OPEN" && (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={ack.isPending}
              onClick={() => ack.mutate({ id: e.id }, {
                onSuccess: () => { toast({ title: "Acknowledged" }); invalidate(); },
                onError: () => toast({ variant: "destructive", title: "Failed to acknowledge" }),
              })}
              data-testid={`button-ack-${e.id}`}
            >
              <Eye className="w-3.5 h-3.5 mr-1" /> Acknowledge
            </Button>
          )}
          {e.status !== "RESOLVED" && (
            <Button
              size="sm"
              className="rounded-full"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ id: e.id }, {
                onSuccess: () => { toast({ title: "Resolved" }); invalidate(); },
                onError: () => toast({ variant: "destructive", title: "Failed to resolve" }),
              })}
              data-testid={`button-resolve-${e.id}`}
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Resolve
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function DeliverySkippedBadge({
  status,
}: {
  status?: EscalationNotifyDeliveryStatus;
}) {
  if (status !== "SKIPPED_RECOVERY_WINDOW") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 dark:bg-slate-500/25 dark:text-slate-200 cursor-help"
          data-testid="badge-delivery-skipped"
        >
          <BellOff className="w-3 h-3" />
          Delivery skipped
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-center">
        This escalation was older than the notification recovery window when the API restarted, so no email or Slack message was actually sent. It still appears here for follow-up.
      </TooltipContent>
    </Tooltip>
  );
}

function NoChannelConfiguredBadge({
  status,
}: {
  status?: EscalationNotifyDeliveryStatus;
}) {
  if (status !== "NO_PROVIDER_CONFIGURED") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-100 cursor-help"
          data-testid="badge-no-channel-configured"
        >
          <BellOff className="w-3 h-3" />
          No channel configured
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-center">
        No notification channel is configured — escalation was not sent. Ask an admin to set up Slack or email so future alerts reach the team.
      </TooltipContent>
    </Tooltip>
  );
}

function RepingBadge({
  count,
  lastRepingAt,
}: {
  count: number;
  lastRepingAt?: string | null;
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
          className="inline-flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200 cursor-help"
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
