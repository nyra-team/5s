import { useGetDashboardCompliance, useGetDashboardScores, useGetDashboardSummary } from "@workspace/api-client-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { ClipboardCheck, Target, AlertTriangle, Activity } from "lucide-react";
import { format } from "date-fns";

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
    <div className="bg-card rounded-2xl shadow-soft p-6 flex flex-col gap-4 transition-shadow hover:shadow-elevated">
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

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
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
      </section>

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
