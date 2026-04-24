import {
  useListEscalations,
  useAcknowledgeEscalation,
  useResolveEscalation,
  Escalation,
  getListEscalationsQueryKey,
  getGetEscalationCountQueryKey,
} from "@workspace/api-client-react";
import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Eye, Inbox } from "lucide-react";

const STATUSES = [
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "ALL", label: "All" },
] as const;

export default function EscalationsPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]["value"]>("OPEN");
  const { data: escalations, isLoading } = useListEscalations({ status });

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5"><Inbox className="w-3 h-3" /> Inbox</p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Escalations</h1>
        <p className="text-muted-foreground text-[15px]">
          Failed audits below 60% are auto-escalated here for manager follow-up.
        </p>
      </header>

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

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
        </div>
      ) : escalations && escalations.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {escalations.map((e) => <EscalationCard key={e.id} escalation={e} />)}
        </div>
      ) : (
        <div className="text-center py-16 text-muted-foreground">
          <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-500" />
          <p className="text-[15px] font-medium">No escalations</p>
          <p className="text-[13px] mt-1 opacity-80">All recent audits are passing.</p>
        </div>
      )}
    </div>
  );
}

function EscalationCard({ escalation: e }: { escalation: Escalation }) {
  const ack = useAcknowledgeEscalation();
  const resolve = useResolveEscalation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListEscalationsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetEscalationCountQueryKey() });
  };

  const tone =
    e.scorePercent < 40
      ? "bg-rose-50 dark:bg-rose-500/12 text-rose-800 dark:text-rose-200"
      : "bg-amber-50 dark:bg-amber-500/12 text-amber-800 dark:text-amber-200";

  return (
    <div className="bg-card rounded-2xl shadow-soft hover:shadow-elevated transition-shadow p-5 sm:p-6 flex flex-col gap-4" data-testid={`card-escalation-${e.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="eyebrow inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-rose-500" /> Failed audit</p>
          <h3 className="text-[18px] font-semibold tracking-tight mt-1">{e.areaName}</h3>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            {format(new Date(e.createdAt), "MMM d, h:mm a")} · {e.operatorEmail}
          </p>
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
        <span className={`text-[11.5px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
          e.status === "OPEN" ? "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200" :
          e.status === "ACKNOWLEDGED" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" :
          "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
        }`}>{e.status}</span>
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
