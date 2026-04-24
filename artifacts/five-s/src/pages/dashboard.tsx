import { useGetDashboardCompliance, useGetDashboardScores, useGetDashboardSummary, useListAreas, useGetAreaProfile, useGetDashboardTrends, type AreaTrend } from "@workspace/api-client-react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceDot } from "recharts";
import { ClipboardCheck, Target, AlertTriangle, Activity, Inbox, Sparkles, BookOpen, TrendingUp } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Link } from "wouter";

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
          <LearningChip key={a.id} areaId={a.id} areaName={a.name} />
        ))}
      </div>
    </section>
  );
}

function LearningChip({ areaId, areaName }: { areaId: number; areaName: string }) {
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
        <p className="text-[13px] font-medium truncate">{areaName}</p>
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

function LearningTrendPanel() {
  const { data: trends, isLoading } = useGetDashboardTrends({ days: 14 });

  if (isLoading) {
    return (
      <section className="bg-card rounded-2xl shadow-soft p-6">
        <div className="h-40 bg-secondary rounded-xl animate-pulse" />
      </section>
    );
  }

  if (!trends || trends.length === 0) return null;

  return (
    <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="dashboard-trends">
      <div className="flex items-start justify-between mb-5">
        <div>
          <p className="eyebrow">AI learning</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">Score trends (14 days)</h2>
          <p className="text-[13px] text-muted-foreground mt-1">
            Daily average score per area. The dot marks the day the AI graduated to <span className="font-medium text-foreground">Trained</span>.
          </p>
        </div>
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <TrendingUp className="w-4 h-4 text-primary" />
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

function AreaTrendCard({ trend }: { trend: AreaTrend }) {
  const totalPoints = trend.points.reduce((acc, p) => acc + p.count, 0);
  const isTrained = trend.status === "TRAINED";

  // Find the trained-on point inside the visible window so we can place a dot.
  // Only place the dot if that day actually has a numeric score to anchor it to.
  const trainedPoint = trend.trainedOnDate
    ? trend.points.find((p) => p.date === trend.trainedOnDate && p.avgScore !== null)
    : undefined;

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
        <p className="text-[13px] font-medium truncate">{trend.areaName}</p>
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
      {trend.trainedOnDate && (
        <p className="text-[11px] text-muted-foreground">
          Trained on {format(parseISO(trend.trainedOnDate), "MMM d")}
          {!trainedPoint && " (before this window)"}
        </p>
      )}
    </div>
  );
}
