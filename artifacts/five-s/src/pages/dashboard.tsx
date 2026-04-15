import { useGetDashboardCompliance, useGetDashboardScores, useGetDashboardSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, Legend } from "recharts";
import { ClipboardCheck, Target, AlertTriangle, Activity } from "lucide-react";
import { format } from "date-fns";

export default function Dashboard() {
  const today = format(new Date(), "yyyy-MM-dd");
  
  const { data: summary, isLoading: sumLoading } = useGetDashboardSummary();
  const { data: compliance, isLoading: compLoading } = useGetDashboardCompliance({ date: today });
  const { data: scoresByArea, isLoading: scoresLoading } = useGetDashboardScores({ date: today, groupBy: "area" });
  const { data: scoresByShift, isLoading: shiftLoading } = useGetDashboardScores({ date: today, groupBy: "shift" });

  if (sumLoading || compLoading || scoresLoading || shiftLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const isCompliant = (compliance?.compliancePercent || 0) >= 80;

  return (
    <div className="space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Factory Overview</h1>
        <p className="text-muted-foreground mt-1">Live metrics and compliance data for {format(new Date(), "MMMM d, yyyy")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-bold text-muted-foreground uppercase">Today's Compliance</CardTitle>
            <Target className={`w-5 h-5 ${isCompliant ? "text-green-500" : "text-orange-500"}`} />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{Math.round(compliance?.compliancePercent || 0)}%</div>
            <p className="text-xs text-muted-foreground mt-1 font-medium">
              {compliance?.submittedAreas} of {compliance?.totalAreas} areas evaluated
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-bold text-muted-foreground uppercase">Avg 5S Score</CardTitle>
            <Activity className="w-5 h-5 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{summary?.todayAvgScore?.toFixed(1) || "0.0"}</div>
            <p className="text-xs text-muted-foreground mt-1 font-medium">
              Out of 25 possible points
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-bold text-muted-foreground uppercase">Today's Photos</CardTitle>
            <ClipboardCheck className="w-5 h-5 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{summary?.todaySubmissions || 0}</div>
            <p className="text-xs text-muted-foreground mt-1 font-medium">
              Across all active shifts
            </p>
          </CardContent>
        </Card>

        <Card className={`${(compliance?.missingAreas?.length || 0) > 0 ? 'border-orange-200 bg-orange-50' : ''}`}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-bold text-muted-foreground uppercase">Missing Areas</CardTitle>
            <AlertTriangle className={`w-5 h-5 ${(compliance?.missingAreas?.length || 0) > 0 ? "text-orange-500" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{compliance?.missingAreas?.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1 font-medium truncate" title={compliance?.missingAreas?.join(", ")}>
              {compliance?.missingAreas?.length ? compliance.missingAreas.join(", ") : "All clear"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Average Scores by Area</CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scoresByArea} margin={{ top: 10, right: 10, left: -20, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis 
                  dataKey="label" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis 
                  domain={[0, 25]} 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                />
                <Tooltip 
                  cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                  contentStyle={{ borderRadius: "8px", border: "1px solid hsl(var(--border))", fontWeight: "bold" }}
                />
                <Bar dataKey="avgScore" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={50} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardHeader>
            <CardTitle>Average Scores by Shift</CardTitle>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={scoresByShift} margin={{ top: 10, right: 10, left: -20, bottom: 0 }} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis 
                  type="number" 
                  domain={[0, 25]} 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                />
                <YAxis 
                  dataKey="label" 
                  type="category" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 14, fontWeight: "bold", fill: "hsl(var(--foreground))" }}
                />
                <Tooltip 
                  cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                  contentStyle={{ borderRadius: "8px", border: "1px solid hsl(var(--border))", fontWeight: "bold" }}
                />
                <Bar dataKey="avgScore" fill="hsl(var(--secondary))" radius={[0, 4, 4, 0]} barSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
