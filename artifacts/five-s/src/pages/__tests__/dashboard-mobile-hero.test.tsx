/**
 * Mobile-layout regression for the manager dashboard's hero stat row.
 *
 * Task #148 broke the five-stat row into a 2-column mobile grid (with the
 * Open Escalations card spanning to a fifth column on `lg`+). Without a
 * guard, a refactor that drops the `grid-cols-2` mobile fallback re-spawns
 * the original bug where a single-column stack of 5 large cards pushed
 * everything below the fold on a 375px phone, or where a `grid-cols-3`
 * tweak produced an awkward last-row orphan.
 *
 * These tests render the Dashboard page (with all the heavy data hooks
 * mocked away) and assert:
 *   1. The hero-stats grid is rendered with `grid-cols-2` so phones get a
 *      tidy 2-up layout and never devolve to a full-width stack.
 *   2. The same grid escalates to `lg:grid-cols-5` so desktop keeps the
 *      single-row hero we shipped.
 *   3. All five hero cards render inside that grid so the assertion above
 *      reflects an actually-populated row, not just an empty container.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="recharts-container">{children}</div>
  ),
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceDot: () => null,
}));

vi.mock("@workspace/api-client-react", () => {
  const noopQuery = (data: unknown = undefined) => () => ({
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  const noopParamQuery = (data: unknown = undefined) =>
    function ParamQuery() {
      return {
        data,
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
    };
  return {
    useGetDashboardSummary: noopQuery({
      todayAvgScore: 18,
      todaySubmissions: 24,
      openEscalations: 2,
    }),
    useGetDashboardCompliance: noopQuery({
      compliancePercent: 82,
      submittedAreas: 5,
      totalAreas: 6,
      missingAreas: ["Bay 3"],
    }),
    useGetDashboardScores: noopQuery([]),
    useGetEscalationCount: noopQuery({ count: 2 }),
    useListAreas: noopQuery([]),
    useGetAreaProfile: noopParamQuery(undefined),
    useGetDashboardTrends: noopQuery([]),
    useGetDashboardOperatorDismisses: noopQuery([]),
    useGetDashboardOperatorDismissesDetail: noopQuery(undefined),
    useGetDashboardAiReliability: noopQuery({
      last24h: { totalCalls: 0, retriedCalls: 0, retryRate: 0 },
      last7d: { totalCalls: 0, retriedCalls: 0, retryRate: 0 },
    }),
    useGetDashboardAiCost: noopQuery(undefined),
    useGetAreaDetectionAgreement: noopQuery(undefined),
    useGetDashboardOperatorCoverage: noopQuery({
      totalOperators: 0,
      totalAreas: 0,
      operators: [],
    }),
    useGetBackfillReasoningStatus: noopQuery({ remaining: 0 }),
    useBackfillReasoning: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({ remaining: 0 })),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    }),
    useSendOperatorCoachingNudge: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    }),
    getGetBackfillReasoningStatusQueryKey: () => ["backfill-reasoning-status"],
    getGetDashboardOperatorDismissesDetailQueryKey: () => ["dismisses-detail"],
    getGetAreaProfileQueryKey: () => ["area-profile"],
  };
});

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => true,
}));

import Dashboard from "@/pages/dashboard";

function withQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("Dashboard hero stats — mobile vs desktop columns", () => {
  beforeEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
  });

  test("renders the hero-stats grid as 2-up on mobile and 5-up at the lg breakpoint", () => {
    render(withQuery(<Dashboard />));

    const grid = screen.getByTestId("hero-stats-grid");
    // The grid base class drives the phone layout — losing `grid-cols-2`
    // re-introduces the full-width-stack regression task #148 fixed.
    expect(grid.className).toMatch(/\bgrid-cols-2\b/);
    // The desktop expansion class drives the single-row layout at >= lg.
    expect(grid.className).toMatch(/\blg:grid-cols-5\b/);
  });

  test("hero-stats grid actually contains all five hero cards", () => {
    render(withQuery(<Dashboard />));

    const grid = screen.getByTestId("hero-stats-grid");
    // The five cards are recognisable by their stable label copy. We
    // intentionally search inside the grid so a future page-wide rename
    // can't satisfy this from elsewhere on the page.
    const labels = [
      "Today's Compliance",
      "Avg 5S Score",
      "Today's Photos",
      "Missing Areas",
      "Open Escalations",
    ];
    for (const label of labels) {
      expect(within(grid).getByText(label)).toBeInTheDocument();
    }
  });
});
