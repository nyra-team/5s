/**
 * Component-level coverage for the manager dashboard's per-panel error
 * states. Before this work, a 500 from `/dashboard/*` or `/escalations/count`
 * silently rendered an empty card or a "0" — managers couldn't tell a real
 * outage apart from a quiet shift. The dashboard now distinguishes loading,
 * error, and ready states for each panel and surfaces a Retry button.
 *
 * These tests mock `@workspace/api-client-react` so we can drive each hook
 * through specific `isLoading` / `isError` combinations and assert that the
 * affected panels render the correct state.
 */
import { describe, test, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Recharts pulls in ResizeObserver/SVG sizing that adds noise; stub the bits
// the dashboard uses so we can focus on the surrounding card chrome.
vi.mock("recharts", () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="recharts-container">{children}</div>
    ),
    LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Line: () => null,
    Bar: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    ReferenceDot: () => null,
  };
});

// wouter's Link renders an anchor; we render it as-is but the dashboard pulls
// it in for the "Open Escalations" hero card.
vi.mock("wouter", () => ({
  Link: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// React Query hook mocks. Each test seeds these with the loading/error/data
// combination it cares about. The factories return new objects each render so
// React doesn't dedupe between tests.
const refetchSummary = vi.fn();
const refetchCompliance = vi.fn();
const refetchScoresArea = vi.fn();
const refetchScoresShift = vi.fn();
const refetchEscalation = vi.fn();
const refetchTrends = vi.fn();
const refetchAi = vi.fn();
const refetchAreas = vi.fn();
const refetchProfile = vi.fn();
const refetchDismisses = vi.fn();
const refetchAgreement = vi.fn();

const mockState = {
  summary: { data: undefined as unknown, isLoading: false, isError: false },
  compliance: { data: undefined as unknown, isLoading: false, isError: false },
  scoresArea: { data: undefined as unknown, isLoading: false, isError: false },
  scoresShift: { data: undefined as unknown, isLoading: false, isError: false },
  escalation: { data: undefined as unknown, isLoading: false, isError: false },
  trends: { data: undefined as unknown, isLoading: false, isError: false },
  ai: { data: undefined as unknown, isLoading: false, isError: false },
  areas: { data: undefined as unknown, isLoading: false, isError: false },
  agreement: { data: undefined as unknown, isLoading: false, isError: false },
  dismisses: { data: undefined as unknown, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", () => {
  return {
    useGetDashboardSummary: () => ({ ...mockState.summary, refetch: refetchSummary }),
    useGetDashboardCompliance: () => ({ ...mockState.compliance, refetch: refetchCompliance }),
    useGetDashboardScores: ({ groupBy }: { groupBy: "area" | "shift" }) =>
      groupBy === "area"
        ? { ...mockState.scoresArea, refetch: refetchScoresArea }
        : { ...mockState.scoresShift, refetch: refetchScoresShift },
    useGetEscalationCount: () => ({ ...mockState.escalation, refetch: refetchEscalation }),
    useGetDashboardTrends: () => ({ ...mockState.trends, refetch: refetchTrends }),
    useGetDashboardAiReliability: () => ({ ...mockState.ai, refetch: refetchAi }),
    useGetDashboardAiCost: () => ({ data: undefined, isLoading: false, isError: false }),
    useListAreas: () => ({ ...mockState.areas, refetch: refetchAreas }),
    useGetAreaProfile: () => ({ data: undefined, isLoading: false, isError: false, refetch: refetchProfile }),
    useGetDashboardOperatorDismisses: () => ({ ...mockState.dismisses, refetch: refetchDismisses }),
    useGetDashboardOperatorDismissesDetail: () => ({ data: undefined, isLoading: false, isError: false }),
    getGetDashboardOperatorDismissesDetailQueryKey: () => ["dismisses-detail"],
    useGetAreaDetectionAgreement: () => ({ ...mockState.agreement, refetch: refetchAgreement }),
    useGetDashboardOperatorCoverage: () => ({ data: { operators: [] }, isLoading: false, isError: false }),
    useGetBackfillReasoningStatus: () => ({ data: undefined, isLoading: false, isError: false }),
    useBackfillReasoning: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, isSuccess: false, reset: vi.fn() }),
    getGetBackfillReasoningStatusQueryKey: () => ["backfill-reasoning-status"],
    useSendOperatorCoachingNudge: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, isSuccess: false, reset: vi.fn() }),
  };
});

import Dashboard from "@/pages/dashboard";

function resetMockState() {
  mockState.summary = { data: undefined, isLoading: false, isError: false };
  mockState.compliance = { data: undefined, isLoading: false, isError: false };
  mockState.scoresArea = { data: [], isLoading: false, isError: false };
  mockState.scoresShift = { data: [], isLoading: false, isError: false };
  mockState.escalation = { data: undefined, isLoading: false, isError: false };
  mockState.trends = { data: [], isLoading: false, isError: false };
  mockState.ai = { data: undefined, isLoading: false, isError: false };
  mockState.areas = { data: [], isLoading: false, isError: false };
  mockState.agreement = { data: undefined, isLoading: false, isError: false };
  mockState.dismisses = { data: [], isLoading: false, isError: false };
  refetchSummary.mockClear();
  refetchCompliance.mockClear();
  refetchScoresArea.mockClear();
  refetchScoresShift.mockClear();
  refetchEscalation.mockClear();
  refetchTrends.mockClear();
}

function renderDashboard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

describe("dashboard panel error states", () => {
  test("compliance failure shows error+retry on the compliance and missing-areas tiles, leaves other tiles intact", () => {
    cleanup();
    resetMockState();
    mockState.summary.data = { todayAvgScore: 4, todaySubmissions: 12, openEscalations: 0 };
    mockState.compliance.isError = true; // 500 from /dashboard/compliance
    mockState.escalation.data = { open: 0 };

    renderDashboard();

    // The compliance-driven tiles surface the error UI with a Retry button…
    expect(screen.getByTestId("hero-compliance-error")).toBeInTheDocument();
    expect(screen.getByTestId("hero-missing-areas-error")).toBeInTheDocument();
    expect(screen.getByTestId("hero-compliance-error-retry")).toBeInTheDocument();

    // …but other hero tiles (driven by the summary endpoint) still render data.
    expect(screen.queryByTestId("hero-avg-score-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hero-photos-error")).not.toBeInTheDocument();
    // "Today's Photos" headline number from summary is visible.
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  test("Retry button calls the failing query's refetch handler so managers can recover without a page reload", () => {
    cleanup();
    resetMockState();
    mockState.summary.data = { todayAvgScore: 4, todaySubmissions: 12, openEscalations: 0 };
    mockState.compliance.isError = true;
    mockState.escalation.data = { open: 0 };

    renderDashboard();

    fireEvent.click(screen.getByTestId("hero-compliance-error-retry"));
    expect(refetchCompliance).toHaveBeenCalledTimes(1);
    // The other panels' refetches stayed put — retry is targeted, not global.
    expect(refetchSummary).not.toHaveBeenCalled();
    expect(refetchScoresArea).not.toHaveBeenCalled();
  });

  test("scores-by-area chart shows a panel error with Retry when /dashboard/scores fails", () => {
    cleanup();
    resetMockState();
    mockState.summary.data = { todayAvgScore: 4, todaySubmissions: 5, openEscalations: 0 };
    mockState.compliance.data = { compliancePercent: 80, submittedAreas: 4, totalAreas: 5, missingAreas: ["Welding"] };
    mockState.scoresArea.isError = true;
    mockState.escalation.data = { open: 0 };

    renderDashboard();

    const errorPanel = screen.getByTestId("scores-by-area-error");
    expect(errorPanel).toBeInTheDocument();
    expect(errorPanel).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("scores-by-area-error-retry")).toBeInTheDocument();

    // The "By Shift" chart, fed by a separate query, is unaffected.
    expect(screen.queryByTestId("scores-by-shift-error")).not.toBeInTheDocument();
  });

  test("escalation count failure replaces the linked tile with a non-link error tile so we don't navigate on a 500", () => {
    cleanup();
    resetMockState();
    mockState.summary.data = { todayAvgScore: 4, todaySubmissions: 5, openEscalations: 0 };
    mockState.compliance.data = { compliancePercent: 80, submittedAreas: 4, totalAreas: 5, missingAreas: [] };
    mockState.escalation.isError = true; // /escalations/count returned 500

    renderDashboard();

    expect(screen.getByTestId("hero-escalations-error")).toBeInTheDocument();
    // The /escalations link wrapper is suppressed in the error state so a
    // confused click doesn't take the manager away from the dashboard before
    // they've tried Retry.
    const errorRegion = screen.getByTestId("hero-escalations-error");
    expect(errorRegion.closest("a")).toBeNull();
  });

  test("loading skeleton (not error) renders while the first fetch is in flight", () => {
    cleanup();
    resetMockState();
    // First-load state: no cached data yet AND a fetch in flight. Once data
    // is cached, react-query backgrounds the refetch and we keep showing it.
    mockState.summary = { data: undefined, isLoading: true, isError: false };
    mockState.compliance = { data: undefined, isLoading: true, isError: false };
    mockState.scoresArea = { data: undefined, isLoading: true, isError: false };
    mockState.scoresShift = { data: undefined, isLoading: true, isError: false };
    mockState.escalation = { data: undefined, isLoading: true, isError: false };

    renderDashboard();

    // No error UI while we're still loading.
    expect(screen.queryByTestId("hero-compliance-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hero-avg-score-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scores-by-area-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scores-by-shift-error")).not.toBeInTheDocument();
    // The loading skeletons inside the chart tiles announce themselves to AT.
    const areaLoading = screen.getByTestId("scores-by-area-loading");
    expect(areaLoading).toHaveAttribute("role", "status");
    expect(areaLoading).toHaveTextContent(/Loading average scores by area/);
    const shiftLoading = screen.getByTestId("scores-by-shift-loading");
    expect(shiftLoading).toHaveAttribute("role", "status");
    expect(shiftLoading).toHaveTextContent(/Loading average scores by shift/);
  });

  test("retry button is keyboard-focusable so managers using a keyboard can recover", () => {
    cleanup();
    resetMockState();
    mockState.summary.data = { todayAvgScore: 4, todaySubmissions: 5, openEscalations: 0 };
    mockState.compliance.isError = true;
    mockState.escalation.data = { open: 0 };

    renderDashboard();

    const retry = screen.getByTestId("hero-compliance-error-retry") as HTMLButtonElement;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.getAttribute("type")).toBe("button");
  });
});
