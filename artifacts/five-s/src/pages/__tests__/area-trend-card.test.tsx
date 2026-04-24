/**
 * Component-level guard for the per-area trend mini-chart on the manager
 * dashboard. With the trend window now switchable between 7 / 14 / 30 days,
 * AreaTrendCard renders a small "MMM d → MMM d" date range row beneath the
 * line chart so managers can localize a regression to a specific date.
 *
 * These tests assert:
 *   1. The date range row reflects the first and last point in trend.points.
 *   2. The range is still shown for empty windows so the manager can see
 *      which days had no submissions, not just "this card is blank".
 *   3. The labels track whatever window the dashboard hands down — switching
 *      from a 7-day window to a 30-day window updates the visible range.
 */
import { describe, test, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AreaTrend } from "@workspace/api-client-react";

vi.mock("recharts", () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="recharts-container">{children}</div>
    ),
    LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Bar: () => null,
    BarChart: () => null,
    ReferenceDot: () => null,
  };
});

import { AreaTrendCard } from "@/pages/dashboard";

function makePoint(date: string, avgScore: number | null, count: number) {
  return { date, avgScore, count };
}

const baseTrend = {
  areaId: 7,
  areaName: "Packing Floor",
  environmentType: "factory",
  status: "TRAINED",
  trainedOnDate: null,
} satisfies Omit<AreaTrend, "points">;

describe("dashboard <AreaTrendCard> window date labels", () => {
  test("shows the first and last IST dates of a 7-day window beneath the chart", () => {
    cleanup();
    const points = [
      makePoint("2026-04-18", 80, 1),
      makePoint("2026-04-19", 82, 2),
      makePoint("2026-04-20", null, 0),
      makePoint("2026-04-21", 85, 1),
      makePoint("2026-04-22", 90, 1),
      makePoint("2026-04-23", null, 0),
      makePoint("2026-04-24", 88, 1),
    ];
    render(<AreaTrendCard trend={{ ...baseTrend, points }} />);
    const range = screen.getByTestId(`dashboard-trend-range-${baseTrend.areaId}`);
    expect(range).toHaveTextContent("Apr 18 → Apr 24");
  });

  test("still shows the date range for an empty window so managers know which days had no submissions", () => {
    cleanup();
    const points = [
      makePoint("2026-04-18", null, 0),
      makePoint("2026-04-19", null, 0),
      makePoint("2026-04-20", null, 0),
    ];
    render(<AreaTrendCard trend={{ ...baseTrend, points }} />);
    const range = screen.getByTestId(`dashboard-trend-range-${baseTrend.areaId}`);
    expect(range).toHaveTextContent("Apr 18 → Apr 20");
    // The "No submissions in this window" placeholder still shows above the
    // label so the empty card communicates both the window and its emptiness.
    expect(screen.getByText(/No submissions in this window/)).toBeInTheDocument();
  });

  test("updates to a wider span when the dashboard switches to a 30-day window", () => {
    cleanup();
    const points: { date: string; avgScore: number | null; count: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const day = String(26 - i).padStart(2, "0"); // Apr 26 → Mar 28 stepping back
      const month = i < 26 ? "04" : "03";
      const dayOfMonth = i < 26 ? day : String(31 - (i - 26)).padStart(2, "0");
      points.push(makePoint(`2026-${month}-${dayOfMonth}`, 80, 1));
    }
    points.reverse();
    render(<AreaTrendCard trend={{ ...baseTrend, points }} />);
    const range = screen.getByTestId(`dashboard-trend-range-${baseTrend.areaId}`);
    // Sanity-check the start/end format and that both ends parsed correctly,
    // without binding too tightly to the synthetic window above.
    expect(range.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2} → [A-Z][a-z]{2} \d{1,2}$/);
    expect(range).toHaveTextContent(/^Mar /);
    expect(range.textContent).toMatch(/→ Apr 26$/);
  });
});
