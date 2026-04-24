import {
  useGetDashboardCompliance,
  useGetDashboardScores,
  useGetDashboardSummary,
  useListAreas,
  useGetAreaProfile,
  useGetDashboardTrends,
  useGetDashboardOperatorDismisses,
  useGetDashboardOperatorDismissesDetail,
  getGetDashboardOperatorDismissesDetailQueryKey,
  useGetDashboardAiReliability,
  useGetDashboardAiCost,
  useGetAreaDetectionAgreement,
  useSendOperatorCoachingNudge,
  useGetBackfillReasoningStatus,
  useBackfillReasoning,
  getGetBackfillReasoningStatusQueryKey,
  type AreaTrend,
  type GetDashboardTrendsShift,
  type OperatorDismissSummary,
  type OperatorCoachingNudgeResult,
  type OperatorCoachingNudgeThrottled,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer, ReferenceDot } from "recharts";
import { ClipboardCheck, Target, AlertTriangle, Activity, Inbox, Sparkles, BookOpen, TrendingUp, ChevronRight, ChevronDown, XCircle, Repeat, Search, Send, FileQuestion, Loader2 } from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { EnvironmentBadge, normalizeEnvironment } from "@/lib/environment";
import { useIsMobile } from "@/hooks/use-mobile";

function HeroStat({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "warn" | "good";
}) {
  const iconColor =
    tone === "warn" ? "text-amber-600 dark:text-amber-400" :
    tone === "good" ? "text-emerald-600 dark:text-emerald-400" :
    "text-primary";
  const iconBg =
    tone === "warn" ? "bg-amber-50 dark:bg-amber-500/15" :
    tone === "good" ? "bg-emerald-50 dark:bg-emerald-500/15" :
    "bg-primary/10";

  return (
    <div className="bg-card rounded-2xl shadow-soft p-4 sm:p-6 flex flex-col gap-3 sm:gap-4 transition-all duration-150 hover:shadow-elevated active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none">
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow truncate">{label}</p>
        <div className={`w-8 h-8 rounded-full ${iconBg} flex items-center justify-center shrink-0`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
      </div>
      <div className="text-[28px] sm:text-[40px] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <p className="text-[12px] sm:text-[13px] text-muted-foreground">{hint}</p>
    </div>
  );
}

const tooltipStyle = {
  borderRadius: "12px",
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  fontSize: "12px",
  fontWeight: 500,
  boxShadow: "var(--shadow-elevated)",
  padding: "8px 12px",
};

export default function Dashboard() {
  const today = format(new Date(), "yyyy-MM-dd");

  const { data: summary, isLoading: sumLoading } = useGetDashboardSummary();
  const { data: compliance, isLoading: compLoading } = useGetDashboardCompliance({ date: today });
  const { data: scoresByArea, isLoading: scoresLoading } = useGetDashboardScores({ date: today, groupBy: "area" });
  const { data: scoresByShift, isLoading: shiftLoading } = useGetDashboardScores({ date: today, groupBy: "shift" });
  const isMobile = useIsMobile();

  if (sumLoading || compLoading || scoresLoading || shiftLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const compliancePercent = Math.round(compliance?.compliancePercent || 0);
  const isCompliant = compliancePercent >= 80;
  const missingCount = compliance?.missingAreas?.length || 0;

  return (
    <div className="space-y-10 pb-12">
      <header className="space-y-2">
        <p className="eyebrow">{format(new Date(), "EEEE, MMMM d")}</p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Factory overview</h1>
        <p className="text-muted-foreground text-[15px]">Live compliance metrics across all shifts</p>
      </header>

      <section
        className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-5"
        data-testid="hero-stats-grid"
      >
        <HeroStat
          label="Today's Compliance"
          value={`${compliancePercent}%`}
          hint={`${compliance?.submittedAreas} of ${compliance?.totalAreas} areas evaluated`}
          icon={Target}
          tone={isCompliant ? "good" : "warn"}
        />
        <HeroStat
          label="Avg 5S Score"
          value={`${summary?.todayAvgScore ? Math.round(summary.todayAvgScore * 4) : 0}%`}
          hint="Out of 100%"
          icon={Activity}
        />
        <HeroStat
          label="Today's Photos"
          value={summary?.todaySubmissions || 0}
          hint="Across all active shifts"
          icon={ClipboardCheck}
        />
        <HeroStat
          label="Missing Areas"
          value={missingCount}
          hint={
            <span className="truncate block" title={compliance?.missingAreas?.join(", ")}>
              {missingCount ? compliance!.missingAreas!.join(", ") : "All clear"}
            </span>
          }
          icon={AlertTriangle}
          tone={missingCount > 0 ? "warn" : "good"}
        />
        <Link href="/escalations" className="block">
          <HeroStat
            label="Open Escalations"
            value={summary?.openEscalations ?? 0}
            hint={(summary?.openEscalations ?? 0) > 0 ? "Click to review failing audits" : "All escalations resolved"}
            icon={Inbox}
            tone={(summary?.openEscalations ?? 0) > 0 ? "warn" : "good"}
          />
        </Link>
      </section>

      <AiReliabilityPanel />

      <AiCostPanel />

      <BackfillReasoningPanel />

      <LearningStatusPanel />

      <OperatorDismissPanel />

      <LearningTrendPanel />

      <DetectionAgreementPanel />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card rounded-2xl shadow-soft p-6">
          <div className="mb-5">
            <p className="eyebrow">By Area</p>
            <h2 className="text-lg font-semibold tracking-tight mt-1">Average scores</h2>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              {isMobile ? (
                // On phones, area-name labels along the bottom collide and clip. Flip
                // the chart to a vertical layout so each area gets its own row with a
                // readable left-side label, mirroring the "By Shift" chart.
                <BarChart
                  data={scoresByArea?.map((s) => ({ ...s, avgScore: Math.round(s.avgScore * 4) }))}
                  margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
                  layout="vertical"
                >
                  <CartesianGrid strokeDasharray="2 4" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <YAxis
                    dataKey="label"
                    type="category"
                    axisLine={false}
                    tickLine={false}
                    width={92}
                    tick={{ fontSize: 12, fontWeight: 500, fill: "hsl(var(--foreground))" }}
                  />
                  <ChartTooltip
                    cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                    contentStyle={tooltipStyle}
                    formatter={(value: number) => [`${value}%`, "Avg Score"]}
                  />
                  <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[0, 8, 8, 0]} barSize={20} />
                </BarChart>
              ) : (
                <BarChart data={scoresByArea?.map((s) => ({ ...s, avgScore: Math.round(s.avgScore * 4) }))} margin={{ top: 10, right: 10, left: -20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    angle={-30}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    domain={[0, 100]}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <ChartTooltip
                    cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                    contentStyle={tooltipStyle}
                    formatter={(value: number) => [`${value}%`, "Avg Score"]}
                  />
                  <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} maxBarSize={42} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card rounded-2xl shadow-soft p-6">
          <div className="mb-5">
            <p className="eyebrow">By Shift</p>
            <h2 className="text-lg font-semibold tracking-tight mt-1">Average scores</h2>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scoresByShift?.map((s) => ({ ...s, avgScore: Math.round(s.avgScore * 4) }))} margin={{ top: 10, right: 10, left: -10, bottom: 0 }} layout="vertical">
                <CartesianGrid strokeDasharray="2 4" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis
                  type="number"
                  domain={[0, 100]}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 13, fontWeight: 500, fill: "hsl(var(--foreground))" }}
                />
                <ChartTooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={tooltipStyle}
                  formatter={(value: number) => [`${value}%`, "Avg Score"]}
                />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[0, 8, 8, 0]} barSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}

// Surfaces how often the AI scoring model's first response failed our JSON
// shape check and we had to spend a second API call retrying it. A clean
// model rarely retries (<5%); a misbehaving model spikes into double digits
// and silently doubles per-audit cost.
function formatRetryRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0%";
  const pct = rate * 100;
  // Sub-1% is meaningful (we don't want to round 0.4% down to "0%" and miss
  // the signal entirely), but anything above that we render as a whole %.
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function AiReliabilityPanel() {
  const { data, isLoading } = useGetDashboardAiReliability();

  if (isLoading || !data) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="ai-reliability">
        <div className="h-20 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }

  const last24h = data.last24h;
  const last7d = data.last7d;

  // Severity tone for the headline pill: green when healthy, amber if 5%+ of
  // calls retried in the last day, red if 15%+ — a model returning bad JSON
  // 15% of the time means the rubric or the model itself needs attention.
  const rate24 = last24h.retryRate;
  const tone: "good" | "warn" | "bad" =
    rate24 >= 0.15 ? "bad" : rate24 >= 0.05 ? "warn" : "good";
  const pillClass =
    tone === "bad"
      ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
      : tone === "warn"
      ? "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300";
  const iconClass =
    tone === "bad"
      ? "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
      : tone === "warn"
      ? "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
      : "bg-primary/10 text-primary";

  const status =
    tone === "bad"
      ? "Model misbehaving"
      : tone === "warn"
      ? "Slightly elevated"
      : "Healthy";

  const noDataYet = last24h.totalCalls === 0 && last7d.totalCalls === 0;

  return (
    <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="ai-reliability">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-5">
        <div>
          <p className="eyebrow">AI scoring</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">
            First-try retry rate
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-xl">
            How often the AI's first answer didn't match the expected shape and
            had to be retried (every retry doubles the API cost for that audit).
          </p>
        </div>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${iconClass}`}>
          <Repeat className="w-4 h-4" />
        </div>
      </div>
      {noDataYet ? (
        <p className="text-[13px] text-muted-foreground" data-testid="ai-reliability-empty">
          No AI scoring activity yet — submit an audit to start tracking.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl bg-secondary/40 px-4 py-3" data-testid="ai-reliability-24h">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
                Last 24h
              </p>
              <span className={`text-[10.5px] font-medium px-2 py-0.5 rounded-full ${pillClass}`}>
                {status}
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-[26px] leading-none font-semibold tabular-nums">
                {formatRetryRate(last24h.retryRate)}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {last24h.retriedCalls} of {last24h.totalCalls} call{last24h.totalCalls === 1 ? "" : "s"} retried
              </span>
            </div>
          </div>
          <div className="rounded-xl bg-secondary/40 px-4 py-3" data-testid="ai-reliability-7d">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
                Last 7 days
              </p>
              <span className="text-[10.5px] font-medium text-muted-foreground">
                Baseline
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-[26px] leading-none font-semibold tabular-nums">
                {formatRetryRate(last7d.retryRate)}
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {last7d.retriedCalls} of {last7d.totalCalls} call{last7d.totalCalls === 1 ? "" : "s"} retried
              </span>
            </div>
          </div>
        </div>
      )}
      {!noDataYet && (
        <AiReliabilityErrorBreakdown
          last24h={last24h.topErrors}
          last7d={last7d.topErrors}
        />
      )}
    </section>
  );
}

// Renders the most-frequent validation messages that drove retries inside
// each window so engineers can see which specific failures
// ("missing pillar_scores object") to target instead of guessing from the
// headline percentage. We default to the 24h breakdown — what's misbehaving
// today — and let the manager flip to the 7d baseline.
const RETRY_MESSAGE_DISPLAY_LIMIT = 80;

function AiReliabilityErrorBreakdown({
  last24h,
  last7d,
}: {
  last24h: { message: string; count: number }[];
  last7d: { message: string; count: number }[];
}) {
  const [windowKey, setWindowKey] = useState<"24h" | "7d">("24h");
  const errors = windowKey === "24h" ? last24h : last7d;
  const total = errors.reduce((acc, e) => acc + e.count, 0);

  return (
    <div className="mt-5 pt-5 border-t border-border" data-testid="ai-reliability-breakdown">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
            Top validation errors
          </p>
          <p className="text-[11.5px] text-muted-foreground mt-0.5">
            What the AI's first answer is failing on, sorted by frequency.
          </p>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={windowKey}
          onValueChange={(v) => {
            if (v === "24h" || v === "7d") setWindowKey(v);
          }}
          className="bg-secondary/60 rounded-md p-0.5"
        >
          <ToggleGroupItem
            value="24h"
            className="text-[11px] px-2 h-7 data-[state=on]:bg-card"
            data-testid="ai-reliability-breakdown-window-24h"
          >
            24h
          </ToggleGroupItem>
          <ToggleGroupItem
            value="7d"
            className="text-[11px] px-2 h-7 data-[state=on]:bg-card"
            data-testid="ai-reliability-breakdown-window-7d"
          >
            7d
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {errors.length === 0 ? (
        <p
          className="text-[12.5px] text-muted-foreground"
          data-testid="ai-reliability-breakdown-empty"
        >
          No validation errors in this window — every retry, if any, came back clean on the second try without a recorded reason.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="ai-reliability-breakdown-list">
          {errors.map((e, idx) => {
            const truncated = e.message.length > RETRY_MESSAGE_DISPLAY_LIMIT;
            const display = truncated
              ? `${e.message.slice(0, RETRY_MESSAGE_DISPLAY_LIMIT - 1)}…`
              : e.message;
            const sharePct = total > 0 ? Math.round((e.count / total) * 100) : 0;
            // Wrap in a tooltip only when truncation occurred — Radix's
            // TooltipTrigger needs to render a focusable child, so we use
            // a plain span when the full text is already visible.
            const messageNode = truncated ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="text-[12.5px] text-foreground/90 underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 cursor-help"
                    data-testid={`ai-reliability-breakdown-message-${idx}`}
                  >
                    {display}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="start"
                  className="max-w-sm break-words whitespace-pre-wrap text-left"
                >
                  {e.message}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className="text-[12.5px] text-foreground/90"
                data-testid={`ai-reliability-breakdown-message-${idx}`}
              >
                {display}
              </span>
            );
            return (
              <li
                key={`${windowKey}-${idx}-${e.message}`}
                className="flex items-start justify-between gap-3 rounded-lg bg-secondary/30 px-3 py-2"
                data-testid={`ai-reliability-breakdown-row-${idx}`}
              >
                <div className="min-w-0 flex-1">{messageNode}</div>
                <span className="text-[11.5px] tabular-nums text-muted-foreground flex-shrink-0">
                  <span
                    className="font-medium text-foreground"
                    data-testid={`ai-reliability-breakdown-count-${idx}`}
                  >
                    {e.count}
                  </span>
                  {" "}({sharePct}%)
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Render a USD figure with a precision that matches its magnitude. Audit
// runs are typically pennies, so `<$0.01` collapses to a fixed string and
// dollars-and-up rounds to two decimals for clean alignment.
function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatLatencyMs(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function formatTokenCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Strip the trailing "-v1" / "-v3" version suffix when the row's modelVersion
// has one — managers care about the family ("gpt-5-factory" vs "gpt-5-mini-
// factory") more than the schema version, but we still keep the raw string
// available as a tooltip in case engineers need the exact tag.
function shortenModelVersion(v: string): string {
  return v.replace(/-v\d+$/, "");
}

function AiCostPanel() {
  const { data, isLoading } = useGetDashboardAiCost();

  if (isLoading || !data) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="ai-cost">
        <div className="h-32 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }

  const last7d = data.last7d;
  const last30d = data.last30d;
  const noDataYet = last7d.length === 0 && last30d.length === 0;

  return (
    <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="ai-cost">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-5">
        <div>
          <p className="eyebrow">AI scoring</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">
            Per-model latency &amp; cost
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-xl">
            What each underlying model is costing in time and money. Old
            gpt-5-mini rows and the new gpt-5 rows render side-by-side so
            you can sanity-check whether the upgrade is worth the spend.
          </p>
        </div>
      </div>
      {noDataYet ? (
        <p className="text-[13px] text-muted-foreground" data-testid="ai-cost-empty">
          No AI scoring activity yet — submit an audit to start tracking.
        </p>
      ) : (
        <div className="space-y-6">
          <AiCostWindowTable label="Last 7 days" rows={last7d} testId="ai-cost-7d" />
          <AiCostWindowTable label="Last 30 days" rows={last30d} testId="ai-cost-30d" />
        </div>
      )}
    </section>
  );
}

// How many legacy submissions we re-score per click. Small enough to keep one
// click cheap (each row triggers a fresh VLM call), big enough to actually
// chip away at a real backlog over a handful of presses.
const BACKFILL_BATCH_SIZE = 25;

// Surfaces the "AI explanations" backfill progress so a manager can see how
// many older audits still say "No reasoning recorded." in their detail dialog
// and trigger a batch fill from the dashboard instead of curl-ing the admin
// endpoint by hand.
function BackfillReasoningPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError: statusError } = useGetBackfillReasoningStatus();
  const mutation = useBackfillReasoning();

  // While the mutation is in flight we want both the button disabled AND the
  // count to read as in-flight, so a manager can't double-tap and queue up
  // ten parallel batches by accident. React Query's `isPending` already
  // serialises clicks for us — we just have to honour it visually.
  const isRunning = mutation.isPending;
  const remaining = data?.remaining ?? 0;
  // Critically: we must NOT treat "GET failed" as "0 remaining" — that would
  // misleadingly flip the panel into the green "all caught up" state and
  // disable the button when the backend was just briefly unreachable. We
  // only consider ourselves caught up when the GET actually succeeded with
  // a 0 count.
  const hasStatus = !isLoading && !statusError && data !== undefined;
  const isCaughtUp = hasStatus && remaining === 0;

  const handleClick = () => {
    if (isRunning) return;
    mutation.mutate(
      { params: { limit: BACKFILL_BATCH_SIZE } },
      {
        onSettled: () => {
          // Always refresh the headline count, win or lose. Even on a partial
          // failure (some rows missing media, some scoring_failed) the
          // outstanding count may have shifted, so we refetch instead of
          // trusting the response payload's `remaining` so a concurrent
          // run/upload can't leave us with a stale number.
          queryClient.invalidateQueries({
            queryKey: getGetBackfillReasoningStatusQueryKey(),
          });
        },
      },
    );
  };

  const lastResult = mutation.data;

  return (
    <section
      className="bg-card rounded-2xl shadow-soft p-6"
      data-testid="backfill-reasoning-panel"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-5">
        <div className="min-w-0">
          <p className="eyebrow">AI explanations</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">
            Backfill missing reasoning
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-xl">
            Older audits don't have the per-pillar "why" the AI now records.
            Run a batch to re-score them in the background so their detail
            dialogs stop saying "No reasoning recorded."
          </p>
        </div>
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
            isCaughtUp
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          }`}
        >
          <FileQuestion className="w-4 h-4" />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4 sm:items-end">
        <div className="rounded-xl bg-secondary/40 px-4 py-3">
          <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
            Audits still missing reasoning
          </p>
          <div className="flex items-baseline gap-2 mt-2">
            <span
              className="text-[26px] leading-none font-semibold tabular-nums"
              data-testid="backfill-reasoning-remaining"
            >
              {isLoading || statusError ? "—" : remaining.toLocaleString()}
            </span>
            <span className="text-[11.5px] text-muted-foreground">
              {statusError
                ? "couldn't load count"
                : isCaughtUp
                ? "all caught up"
                : `processing ${BACKFILL_BATCH_SIZE} per batch`}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleClick}
          disabled={isRunning || isLoading || statusError || isCaughtUp}
          data-testid="backfill-reasoning-run"
          className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-primary text-primary-foreground text-[13px] font-medium shadow-soft hover:shadow-elevated transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-soft active:scale-[0.99] motion-reduce:active:scale-100"
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Running…
            </>
          ) : statusError ? (
            "Status unavailable"
          ) : isCaughtUp ? (
            "Nothing to backfill"
          ) : (
            `Run batch of ${BACKFILL_BATCH_SIZE}`
          )}
        </button>
      </div>

      {statusError ? (
        <p
          className="text-[12.5px] text-rose-600 dark:text-rose-400 mt-3"
          data-testid="backfill-reasoning-status-error"
        >
          Couldn't load the outstanding count. Reload the dashboard to retry.
        </p>
      ) : null}

      {mutation.isError ? (
        <p
          className="text-[12.5px] text-rose-600 dark:text-rose-400 mt-3"
          data-testid="backfill-reasoning-error"
        >
          Couldn't run the backfill. Try again in a moment.
        </p>
      ) : lastResult ? (
        <p
          className="text-[12.5px] text-muted-foreground mt-3"
          data-testid="backfill-reasoning-last-result"
        >
          Last batch: scanned {lastResult.scanned}, filled in {lastResult.updated}
          {lastResult.missingMedia > 0
            ? `, ${lastResult.missingMedia} missing media`
            : ""}
          {lastResult.scoringFailed > 0
            ? `, ${lastResult.scoringFailed} couldn't be re-scored`
            : ""}
          .
        </p>
      ) : null}
    </section>
  );
}

function AiCostWindowTable({
  label,
  rows,
  testId,
}: {
  label: string;
  rows: Array<{
    modelVersion: string;
    callKind: string;
    requestCount: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
    estimatedCostPerCallUsd: number | null;
    estimatedTokensPerCall: number | null;
  }>;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>
        <span className="text-[11.5px] text-muted-foreground" data-testid={`${testId}-row-count`}>
          {rows.length} model{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground rounded-xl bg-secondary/40 px-4 py-3">
          No calls in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium text-right">Requests</th>
                <th className="px-3 py-2 font-medium text-right">Avg latency</th>
                <th className="px-3 py-2 font-medium text-right">p95 latency</th>
                <th className="px-3 py-2 font-medium text-right">Tokens</th>
                <th className="px-3 py-2 font-medium text-right">Tokens/call</th>
                <th className="px-3 py-2 font-medium text-right">Est. cost</th>
                <th className="px-3 py-2 font-medium text-right">Per call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.modelVersion}-${row.callKind}`}
                  className="border-t border-border/60"
                  data-testid={`${testId}-row`}
                >
                  <td className="px-3 py-2 font-medium tabular-nums" title={row.modelVersion}>
                    {shortenModelVersion(row.modelVersion)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground capitalize">{row.callKind}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.requestCount.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatLatencyMs(row.avgLatencyMs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatLatencyMs(row.p95LatencyMs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatTokenCount(row.totalTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {formatTokenCount(row.estimatedTokensPerCall)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(row.estimatedCostUsd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {formatUsd(row.estimatedCostPerCallUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TRAINING_TARGET = 5;

function LearningStatusPanel() {
  const { data: areas, isLoading } = useListAreas();
  if (isLoading) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-20 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }
  if (!areas || areas.length === 0) return null;
  return (
    <section className="bg-card rounded-2xl shadow-soft p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="eyebrow">AI learning</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">Per-area model status</h2>
        </div>
        <Link
          href="/areas"
          className="text-[12.5px] text-primary hover:underline inline-flex items-center gap-1"
        >
          <BookOpen className="w-3.5 h-3.5" /> Manage profiles
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {areas.map((a) => (
          <LearningChip
            key={a.id}
            areaId={a.id}
            areaName={a.name}
            environmentType={normalizeEnvironment(a.environmentType)}
          />
        ))}
      </div>
    </section>
  );
}

function LearningChip({ areaId, areaName, environmentType }: { areaId: number; areaName: string; environmentType: ReturnType<typeof normalizeEnvironment> }) {
  const { data: profile } = useGetAreaProfile(areaId);
  const submissions = profile?.submissionsCount ?? 0;
  const isTrained = profile?.status === "TRAINED";
  const pct = Math.min(100, Math.round((submissions / TRAINING_TARGET) * 100));
  return (
    <div
      className="rounded-xl bg-secondary/40 px-4 py-3 flex items-center gap-3"
      data-testid={`dashboard-learning-${areaId}`}
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center ${
          isTrained
            ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
        }`}
      >
        <Sparkles className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-[13px] font-medium truncate">{areaName}</p>
          <EnvironmentBadge type={environmentType} size="xs" testId={`badge-environment-${areaId}`} />
        </div>
        {isTrained ? (
          <p className="text-[11.5px] text-muted-foreground">Trained · {submissions} walk-throughs</p>
        ) : (
          <>
            <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden mt-1">
              <div className="h-full bg-amber-500 rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11.5px] text-muted-foreground mt-0.5">
              Learning {submissions}/{TRAINING_TARGET}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

type TrendDays = 7 | 14 | 30;
type TrendShiftFilter = "ALL" | GetDashboardTrendsShift;

const DAYS_OPTIONS: TrendDays[] = [7, 14, 30];
const SHIFT_OPTIONS: { value: TrendShiftFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
];

// Remember the manager's last-used trend window/shift between visits so the
// chart restores their preference instead of resetting to the default each time.
const TREND_DAYS_KEY = "fivesh.dashboard.trendDays";
const TREND_SHIFT_KEY = "fivesh.dashboard.trendShift";

function readPersistedTrendDays(): TrendDays {
  if (typeof window === "undefined") return 14;
  try {
    const raw = window.localStorage.getItem(TREND_DAYS_KEY);
    if (!raw) return 14;
    const n = Number(raw) as TrendDays;
    return DAYS_OPTIONS.includes(n) ? n : 14;
  } catch { return 14; }
}

function readPersistedTrendShift(): TrendShiftFilter {
  if (typeof window === "undefined") return "ALL";
  try {
    const raw = window.localStorage.getItem(TREND_SHIFT_KEY);
    if (!raw) return "ALL";
    return SHIFT_OPTIONS.some((o) => o.value === raw)
      ? (raw as TrendShiftFilter)
      : "ALL";
  } catch { return "ALL"; }
}

export function LearningTrendPanel() {
  const [days, setDays] = useState<TrendDays>(readPersistedTrendDays);
  const [shiftFilter, setShiftFilter] = useState<TrendShiftFilter>(readPersistedTrendShift);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(TREND_DAYS_KEY, String(days)); } catch { /* quota / private mode */ }
  }, [days]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(TREND_SHIFT_KEY, shiftFilter); } catch { /* quota / private mode */ }
  }, [shiftFilter]);

  const { data: trends, isLoading } = useGetDashboardTrends({
    days,
    ...(shiftFilter === "ALL" ? {} : { shift: shiftFilter }),
  });

  if (isLoading && !trends) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-40 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }

  if (!trends || trends.length === 0) return null;

  const shiftSuffix = shiftFilter === "ALL" ? "" : ` · Shift ${shiftFilter}`;

  return (
    <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="dashboard-trends">
      <div className="flex flex-col gap-4 mb-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="eyebrow">AI learning</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">
            Score trends ({days} days{shiftSuffix})
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1">
            Daily average score per area. The dot marks the day the AI graduated to <span className="font-medium text-foreground">Trained</span>.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 lg:flex-shrink-0">
          <div className="flex items-center gap-2" data-testid="trend-days-toggle">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Window
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              value={String(days)}
              onValueChange={(v) => {
                if (!v) return;
                const next = Number(v) as TrendDays;
                if (DAYS_OPTIONS.includes(next)) setDays(next);
              }}
              className="gap-0 rounded-lg border border-border bg-secondary/40 p-0.5"
            >
              {DAYS_OPTIONS.map((d) => (
                <ToggleGroupItem
                  key={d}
                  value={String(d)}
                  aria-label={`${d} days`}
                  data-testid={`trend-days-${d}`}
                  className="h-10 px-3.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
                >
                  {d}d
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2" data-testid="trend-shift-toggle">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Shift
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              value={shiftFilter}
              onValueChange={(v) => {
                if (!v) return;
                if (SHIFT_OPTIONS.some((o) => o.value === v)) {
                  setShiftFilter(v as TrendShiftFilter);
                }
              }}
              className="gap-0 rounded-lg border border-border bg-secondary/40 p-0.5"
            >
              {SHIFT_OPTIONS.map((o) => (
                <ToggleGroupItem
                  key={o.value}
                  value={o.value}
                  aria-label={o.value === "ALL" ? "All shifts" : `Shift ${o.value}`}
                  data-testid={`trend-shift-${o.value}`}
                  className="h-10 px-3.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
                >
                  {o.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="hidden lg:flex w-8 h-8 rounded-full bg-primary/10 items-center justify-center">
            <TrendingUp className="w-4 h-4 text-primary" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {trends.map((t) => (
          <AreaTrendCard key={t.areaId} trend={t} />
        ))}
      </div>
    </section>
  );
}

export function AreaTrendCard({ trend }: { trend: AreaTrend }) {
  const totalPoints = trend.points.reduce((acc, p) => acc + p.count, 0);
  const isTrained = trend.status === "TRAINED";

  // Find the trained-on point inside the visible window so we can place a dot.
  // Only place the dot if that day actually has a numeric score to anchor it to.
  const trainedPoint = trend.trainedOnDate
    ? trend.points.find((p) => p.date === trend.trainedOnDate && p.avgScore !== null)
    : undefined;

  // The points are already keyed by IST day, so the first and last entries
  // describe the visible window's start and end dates.
  const firstPoint = trend.points[0];
  const lastPoint = trend.points[trend.points.length - 1];
  const windowLabel =
    firstPoint && lastPoint
      ? `${format(parseISO(firstPoint.date), "MMM d")} → ${format(parseISO(lastPoint.date), "MMM d")}`
      : null;

  // Average across days that actually have submissions, so empty days don't drag the headline.
  const daysWithData = trend.points.filter(
    (p): p is typeof p & { avgScore: number } => p.avgScore !== null && p.count > 0
  );
  const headline =
    daysWithData.length > 0
      ? Math.round(
          daysWithData.reduce((acc, p) => acc + p.avgScore, 0) / daysWithData.length
        )
      : null;

  return (
    <div
      className="rounded-xl bg-secondary/30 p-4 flex flex-col gap-2"
      data-testid={`dashboard-trend-${trend.areaId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="text-[13px] font-medium truncate">{trend.areaName}</p>
          <EnvironmentBadge type={normalizeEnvironment(trend.environmentType)} size="xs" />
        </div>
        <span
          className={`text-[10.5px] font-medium px-2 py-0.5 rounded-full ${
            isTrained
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          }`}
        >
          {isTrained ? "Trained" : "Learning"}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[22px] leading-none font-semibold tabular-nums">
          {headline !== null ? `${headline}%` : "—"}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {totalPoints > 0 ? `${totalPoints} walk-throughs` : "No data yet"}
        </span>
      </div>
      <div className="h-20">
        {totalPoints === 0 ? (
          <div className="h-full flex items-center justify-center text-[11.5px] text-muted-foreground">
            No submissions in this window
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend.points} margin={{ top: 4, right: 6, left: 6, bottom: 0 }}>
              <YAxis hide domain={[0, 100]} />
              <XAxis dataKey="date" hide />
              <ChartTooltip
                cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }}
                contentStyle={tooltipStyle}
                labelFormatter={(label: string) => format(parseISO(label), "MMM d")}
                formatter={(value: number | null, _name, payload) => {
                  const count = (payload?.payload as { count?: number } | undefined)?.count ?? 0;
                  if (value === null || count === 0) return ["No data", "Avg"];
                  return [`${value}% · ${count} sub${count === 1 ? "" : "s"}`, "Avg"];
                }}
              />
              <Line
                type="monotone"
                dataKey="avgScore"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
              {trainedPoint && (
                <ReferenceDot
                  x={trainedPoint.date}
                  y={trainedPoint.avgScore}
                  r={5}
                  fill="hsl(var(--primary))"
                  stroke="hsl(var(--background))"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {windowLabel && (
        <p
          className="text-[10.5px] text-muted-foreground tabular-nums tracking-tight -mt-1"
          data-testid={`dashboard-trend-range-${trend.areaId}`}
        >
          {windowLabel}
        </p>
      )}
      {trend.trainedOnDate && (
        <p className="text-[11px] text-muted-foreground">
          Trained on {format(parseISO(trend.trainedOnDate), "MMM d")}
          {!trainedPoint && " (before this window)"}
        </p>
      )}
    </div>
  );
}

type DismissDays = 7 | 14 | 30;
const DISMISS_DAYS_OPTIONS: DismissDays[] = [7, 14, 30];

// Remember the manager's chosen dismiss-history window between visits.
const DISMISS_DAYS_KEY = "fivesh.dashboard.dismissDays";

function readPersistedDismissDays(): DismissDays {
  if (typeof window === "undefined") return 7;
  try {
    const raw = window.localStorage.getItem(DISMISS_DAYS_KEY);
    if (!raw) return 7;
    const n = Number(raw) as DismissDays;
    return DISMISS_DAYS_OPTIONS.includes(n) ? n : 7;
  } catch { return 7; }
}

// Per-operator history of nudges they cleared without re-capturing evidence.
// Surfaces repeat "swipe-away" patterns so managers can coach the right people
// instead of guessing from the live shift snapshot. Each row is expandable
// into the underlying nudges (area, machine, when).
function OperatorDismissPanel() {
  const [days, setDays] = useState<DismissDays>(readPersistedDismissDays);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(DISMISS_DAYS_KEY, String(days)); } catch { /* quota / private mode */ }
  }, [days]);

  // Collapse any open drill-down when the window changes — the previously
  // selected operator may no longer be in the new list.
  useEffect(() => { setExpandedId(null); }, [days]);

  const { data: rows, isLoading } = useGetDashboardOperatorDismisses({ days });

  return (
    <section
      className="bg-card rounded-2xl shadow-soft p-6"
      data-testid="dashboard-operator-dismisses"
    >
      <div className="flex flex-col gap-4 mb-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="eyebrow">Operator behaviour</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">
            Dismissed without re-capturing ({days} days)
          </h2>
          <p className="text-[13px] text-muted-foreground mt-1">
            Operators ranked by how many nudges they swiped away without submitting fresh evidence. Tap a row to see what was silenced.
          </p>
        </div>
        <div className="flex items-center gap-2 lg:flex-shrink-0" data-testid="dismiss-days-toggle">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            Window
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            value={String(days)}
            onValueChange={(v) => {
              if (!v) return;
              const next = Number(v) as DismissDays;
              if (DISMISS_DAYS_OPTIONS.includes(next)) setDays(next);
            }}
            className="gap-0 rounded-lg border border-border bg-secondary/40 p-0.5"
          >
            {DISMISS_DAYS_OPTIONS.map((d) => (
              <ToggleGroupItem
                key={d}
                value={String(d)}
                aria-label={`${d} days`}
                data-testid={`dismiss-days-${d}`}
                className="h-10 px-3.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
              >
                {d}d
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="hidden lg:flex w-8 h-8 rounded-full bg-amber-50 dark:bg-amber-500/15 items-center justify-center">
            <XCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="h-20 bg-secondary rounded-xl animate-pulse" />
      ) : !rows || rows.length === 0 ? (
        <div
          className="rounded-xl bg-secondary/30 px-4 py-6 text-center text-[13px] text-muted-foreground"
          data-testid="dashboard-operator-dismisses-empty"
        >
          No dismissals without re-capture in the last {days} days. Operators are following up on every nudge.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-xl bg-secondary/20 overflow-hidden">
          {rows.map((row) => (
            <OperatorDismissRow
              key={row.operatorId}
              row={row}
              days={days}
              expanded={expandedId === row.operatorId}
              onToggle={() =>
                setExpandedId(expandedId === row.operatorId ? null : row.operatorId)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// Drift between intent (the area the operator tapped) and the area their
// submission actually landed on. Surfaces an overall agreement rate plus
// the worst-offender areas and operators so we can spot when auto-detect
// is silently routing submissions to the wrong place.
const AGREEMENT_WINDOW_DAYS = 30;
const AGREEMENT_DRIFT_THRESHOLD = 90;

function agreementTone(percent: number | null) {
  if (percent === null) {
    return {
      text: "text-muted-foreground",
      bg: "bg-secondary/60",
      label: "No data",
    };
  }
  if (percent >= 90)
    return {
      text: "text-emerald-700 dark:text-emerald-300",
      bg: "bg-emerald-50 dark:bg-emerald-500/15",
      label: `${percent}%`,
    };
  if (percent >= 70)
    return {
      text: "text-amber-700 dark:text-amber-300",
      bg: "bg-amber-50 dark:bg-amber-500/15",
      label: `${percent}%`,
    };
  return {
    text: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-500/15",
    label: `${percent}%`,
  };
}

function DetectionAgreementPanel() {
  const { data, isLoading } = useGetAreaDetectionAgreement({
    days: AGREEMENT_WINDOW_DAYS,
  });

  if (isLoading) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-20 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }
  if (!data) return null;

  const overall = data.overall;
  const overallTone = agreementTone(overall.agreementPercent);

  // Surface only rows with at least one disagreement so the panel is
  // actionable. Cap the visible list so the dashboard doesn't grow without
  // bound for facilities with a lot of areas/operators; the full breakdown
  // can move into a dedicated page later if needed.
  const driftAreas = data.perArea
    .filter((row) => row.total - row.agreed > 0)
    .slice(0, 6);
  const driftOperators = data.perOperator
    .filter((row) => row.total - row.agreed > 0)
    .slice(0, 6);

  const hasAnyData = overall.total > 0;

  return (
    <section
      className="bg-card rounded-2xl shadow-soft p-6"
      data-testid="detection-agreement-panel"
    >
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <div>
          <p className="eyebrow">Auto-detect quality</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1 flex items-center gap-2">
            <Search className="w-4 h-4 text-primary" />
            Area auto-detect agreement
          </h2>
          <p className="text-[12.5px] text-muted-foreground mt-1">
            Last {data.windowDays} days · how often the chosen area matched the
            area the operator originally tapped.
          </p>
        </div>
        <div
          className={`px-4 py-2 rounded-2xl ${overallTone.bg} ${overallTone.text} flex flex-col items-end`}
          data-testid="detection-agreement-overall"
        >
          <span className="text-[11px] font-medium uppercase tracking-wide opacity-80">
            Overall
          </span>
          <span className="text-[24px] font-semibold leading-none tabular-nums">
            {overallTone.label}
          </span>
          {hasAnyData && (
            <span className="text-[11px] opacity-80 mt-0.5">
              {overall.agreed} of {overall.total} matched
            </span>
          )}
        </div>
      </div>

      {!hasAnyData ? (
        <p className="text-[13px] text-muted-foreground bg-secondary/40 rounded-xl px-4 py-3">
          No submissions in this window have recorded an originally-tapped area
          yet — once new submissions come in, drift will show up here.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <AgreementBreakdownTable
            title="Areas with the most drift"
            emptyMessage="Every area is at full agreement in this window."
            rows={driftAreas.map((row) => ({
              key: `area-${row.areaId}`,
              label: row.areaName,
              total: row.total,
              agreed: row.agreed,
              agreementPercent: row.agreementPercent,
              testId: `detection-agreement-area-${row.areaId}`,
            }))}
          />
          <AgreementBreakdownTable
            title="Operators with the most drift"
            emptyMessage="Every operator is at full agreement in this window."
            rows={driftOperators.map((row) => ({
              key: `op-${row.userId}`,
              label: row.userEmail,
              total: row.total,
              agreed: row.agreed,
              agreementPercent: row.agreementPercent,
              testId: `detection-agreement-operator-${row.userId}`,
            }))}
          />
        </div>
      )}

      {hasAnyData &&
        overall.agreementPercent !== null &&
        overall.agreementPercent < AGREEMENT_DRIFT_THRESHOLD && (
          <p className="mt-4 text-[12px] text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 rounded-xl px-3 py-2">
            Agreement is below {AGREEMENT_DRIFT_THRESHOLD}% — consider rebuilding
            the per-area profiles for the areas above so auto-detect has a
            better signal to discriminate against.
          </p>
        )}
    </section>
  );
}

function OperatorDismissRow({
  row,
  days,
  expanded,
  onToggle,
}: {
  row: OperatorDismissSummary;
  days: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Only fetch the drill-down once the row is opened. React Query caches it,
  // so subsequent expansions of the same row are instant.
  const detailParams = { operatorId: row.operatorId, days };
  const { data: detail, isLoading } = useGetDashboardOperatorDismissesDetail(
    detailParams,
    {
      query: {
        enabled: expanded,
        queryKey: getGetDashboardOperatorDismissesDetailQueryKey(detailParams),
      },
    },
  );

  const lastDismissed = new Date(row.lastDismissedAt);
  const { toast } = useToast();
  const [composerOpen, setComposerOpen] = useState(false);
  const [message, setMessage] = useState("");
  // Cached coaching outcome for this row (success or throttled). Lets us show
  // "Reminder sent / reminded N min ago" inline without re-firing a request
  // every render and without depending on a list re-fetch.
  const [outcome, setOutcome] = useState<
    | { kind: "sent"; at: Date; areaName: string }
    | { kind: "throttled"; lastSentAt: Date; areaName: string }
    | null
  >(null);

  const sendCoachingNudge = useSendOperatorCoachingNudge({
    mutation: {
      onSuccess: (result: OperatorCoachingNudgeResult) => {
        setOutcome({
          kind: "sent",
          at: new Date(result.sentAt),
          areaName: result.targetAreaName,
        });
        setComposerOpen(false);
        setMessage("");
        toast({
          title: "Reminder sent",
          description: `Coaching nudge dispatched for ${result.targetAreaName} (shift ${result.targetShift}).`,
        });
      },
      onError: (err: unknown) => {
        const e = err as { status?: number; data?: unknown } | null;
        // 429: server rejected the send because we're inside the throttle
        // window. Surface the prior send time so the manager understands
        // why nothing went out, instead of the generic "failed" toast.
        if (e && e.status === 429 && e.data && typeof e.data === "object") {
          const data = e.data as Partial<OperatorCoachingNudgeThrottled>;
          if (data.lastSentAt && data.targetAreaName) {
            const lastSentAt = new Date(data.lastSentAt);
            setOutcome({
              kind: "throttled",
              lastSentAt,
              areaName: data.targetAreaName,
            });
            setComposerOpen(false);
            toast({
              title: "Already reminded recently",
              description: `A coaching nudge for ${data.targetAreaName} was sent ${formatDistanceToNow(lastSentAt, { addSuffix: true })}.`,
            });
            return;
          }
        }
        const apiMessage =
          e && e.data && typeof e.data === "object" && "error" in e.data
            ? String((e.data as { error?: string }).error ?? "")
            : "";
        toast({
          variant: "destructive",
          title: "Couldn't send reminder",
          description: apiMessage || "Please try again in a moment.",
        });
      },
    },
  });

  const handleSend = () => {
    sendCoachingNudge.mutate({
      data: {
        operatorId: row.operatorId,
        days,
        message: message.trim() === "" ? null : message.trim(),
      },
    });
  };

  return (
    <li data-testid={`operator-dismiss-row-${row.operatorId}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40 transition-colors"
      >
        <span className="w-6 flex justify-center text-muted-foreground">
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium truncate">{row.operatorEmail}</p>
          <p className="text-[11.5px] text-muted-foreground">
            Last dismissal {formatDistanceToNow(lastDismissed, { addSuffix: true })}
          </p>
        </div>
        <span
          className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300 tabular-nums"
          data-testid={`operator-dismiss-count-${row.operatorId}`}
        >
          {row.dismissCount} dismiss{row.dismissCount === 1 ? "" : "es"}
        </span>
      </button>
      {expanded && (
        <div
          className="px-4 pb-4 pl-13 space-y-3"
          data-testid={`operator-dismiss-detail-${row.operatorId}`}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="text-[11.5px] text-muted-foreground">
              Drop a coaching nudge on this operator's most-dismissed area in
              the last {days} day{days === 1 ? "" : "s"}.
            </div>
            <div className="flex items-center gap-2">
              {outcome?.kind === "sent" && (
                <span
                  className="text-[11px] font-medium px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                  data-testid={`operator-dismiss-sent-${row.operatorId}`}
                >
                  Reminder sent {formatDistanceToNow(outcome.at, { addSuffix: true })}
                </span>
              )}
              {outcome?.kind === "throttled" && (
                <span
                  className="text-[11px] font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground"
                  data-testid={`operator-dismiss-throttled-${row.operatorId}`}
                >
                  Reminded {formatDistanceToNow(outcome.lastSentAt, { addSuffix: true })}
                </span>
              )}
              {!composerOpen && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setComposerOpen(true)}
                  data-testid={`operator-dismiss-send-reminder-${row.operatorId}`}
                >
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                  Send reminder
                </Button>
              )}
            </div>
          </div>
          {composerOpen && (
            <div
              className="rounded-lg border border-border bg-card p-3 space-y-2"
              data-testid={`operator-dismiss-composer-${row.operatorId}`}
            >
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional message — leave blank to use the default coaching nudge."
                className="text-[12.5px] min-h-[72px]"
                data-testid={`operator-dismiss-composer-textarea-${row.operatorId}`}
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setComposerOpen(false);
                    setMessage("");
                  }}
                  disabled={sendCoachingNudge.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSend}
                  disabled={sendCoachingNudge.isPending}
                  data-testid={`operator-dismiss-composer-submit-${row.operatorId}`}
                >
                  {sendCoachingNudge.isPending ? "Sending…" : "Send nudge"}
                </Button>
              </div>
            </div>
          )}
          {isLoading ? (
            <div className="h-12 bg-secondary rounded-lg animate-pulse" />
          ) : !detail || detail.length === 0 ? (
            <p className="text-[12px] text-muted-foreground italic">
              Nothing to drill into in this window.
            </p>
          ) : (
            <ul className="space-y-2">
              {detail.map((n) => {
                const dismissedAt = new Date(n.dismissedAt);
                return (
                  <li
                    key={n.nudgeId}
                    className="rounded-lg bg-card border border-border px-3 py-2 flex items-start justify-between gap-3"
                    data-testid={`operator-dismiss-nudge-${n.nudgeId}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium truncate">
                        {n.areaName}
                        {n.machine ? ` · ${n.machine}` : ""}
                        <span className="ml-2 text-[10.5px] font-normal text-muted-foreground">
                          Shift {n.shift}
                        </span>
                      </p>
                      {n.message && (
                        <p className="text-[11.5px] text-muted-foreground truncate mt-0.5">
                          “{n.message}”
                        </p>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
                      {format(dismissedAt, "MMM d, HH:mm")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function AgreementBreakdownTable({
  title,
  emptyMessage,
  rows,
}: {
  title: string;
  emptyMessage: string;
  rows: Array<{
    key: string;
    label: string;
    total: number;
    agreed: number;
    agreementPercent: number | null;
    testId: string;
  }>;
}) {
  return (
    <div className="rounded-xl bg-secondary/30 p-4">
      <p className="eyebrow mb-3">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground italic">
          {emptyMessage}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => {
            const tone = agreementTone(row.agreementPercent);
            const disagreed = row.total - row.agreed;
            return (
              <li
                key={row.key}
                className="flex items-center justify-between gap-3 text-[13px]"
                data-testid={row.testId}
              >
                <span className="truncate min-w-0" title={row.label}>
                  {row.label}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">
                    {disagreed} of {row.total} drifted
                  </span>
                  <span
                    className={`text-[11.5px] font-semibold px-2 py-0.5 rounded-full tabular-nums ${tone.bg} ${tone.text}`}
                  >
                    {tone.label}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
