import { useGetDashboardCompliance, useGetDashboardScores, useGetDashboardSummary, useListAreas, useGetAreaProfile, useGetDashboardTrends, useGetDashboardOperatorDismisses, useGetDashboardOperatorDismissesDetail, getGetDashboardOperatorDismissesDetailQueryKey, type AreaTrend, type GetDashboardTrendsShift, type OperatorDismissSummary } from "@workspace/api-client-react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot } from "recharts";
import { ClipboardCheck, Target, AlertTriangle, Activity, Inbox, Sparkles, BookOpen, TrendingUp, ChevronRight, ChevronDown, XCircle } from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EnvironmentBadge, normalizeEnvironment } from "@/lib/environment";

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
    <div className="bg-card rounded-2xl shadow-soft p-6 flex flex-col gap-4 transition-all duration-150 hover:shadow-elevated active:scale-[0.99] motion-reduce:active:scale-100 motion-reduce:transition-none">
      <div className="flex items-center justify-between">
        <p className="eyebrow">{label}</p>
        <div className={`w-8 h-8 rounded-full ${iconBg} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
      </div>
      <div className="text-[40px] leading-none font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      <p className="text-[13px] text-muted-foreground">{hint}</p>
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

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
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

      <LearningStatusPanel />

      <OperatorDismissPanel />

      <LearningTrendPanel />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card rounded-2xl shadow-soft p-6">
          <div className="mb-5">
            <p className="eyebrow">By Area</p>
            <h2 className="text-lg font-semibold tracking-tight mt-1">Average scores</h2>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
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
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={tooltipStyle}
                  formatter={(value: number) => [`${value}%`, "Avg Score"]}
                />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[8, 8, 0, 0]} maxBarSize={42} />
              </BarChart>
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
                <Tooltip
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

function LearningTrendPanel() {
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
                  className="h-7 px-2.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
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
                  className="h-7 px-2.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
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
              <Tooltip
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
                className="h-7 px-2.5 text-[12px] data-[state=on]:bg-card data-[state=on]:shadow-soft"
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
          className="px-4 pb-4 pl-13"
          data-testid={`operator-dismiss-detail-${row.operatorId}`}
        >
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
