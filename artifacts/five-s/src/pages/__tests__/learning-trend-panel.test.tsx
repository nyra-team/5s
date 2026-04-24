/**
 * Component-level guard for the manager dashboard's score-trend filter
 * persistence. The window (7 / 14 / 30 days) and shift (ALL / A / B / C)
 * toggles each round-trip through localStorage so a manager who lives on
 * "30d / Shift B" doesn't have to re-pick them on every reload.
 *
 * A future refactor of LearningTrendPanel — or a rename of the storage keys
 * fivesh.dashboard.trendDays / fivesh.dashboard.trendShift — could silently
 * regress this without anyone noticing, so these tests pin down:
 *
 *   1. Seeded localStorage values restore the toggles to that state on mount.
 *   2. Toggling new values writes them back to localStorage under the keys.
 *   3. Defaults (14 / "ALL") apply when nothing is stored OR the stored value
 *      is invalid.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Recharts is heavyweight inside jsdom and we don't need to assert on the
// chart itself here — just on the toggle state and what gets written to
// localStorage when it changes.
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

// Stub useGetDashboardTrends so the panel actually renders its toggles. The
// real hook would fire a network request and the panel returns null when the
// trend list is empty, which would hide the very controls under test.
const trendsHookSpy = vi.fn();
vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@workspace/api-client-react",
  );
  return {
    ...actual,
    useGetDashboardTrends: (params: unknown) => {
      trendsHookSpy(params);
      return {
        data: [
          {
            areaId: 1,
            areaName: "Packing Floor",
            environmentType: "factory",
            status: "TRAINED",
            trainedOnDate: null,
            points: [
              { date: "2026-04-23", avgScore: 80, count: 1 },
              { date: "2026-04-24", avgScore: 82, count: 1 },
            ],
          },
        ],
        isLoading: false,
      };
    },
  };
});

import { LearningTrendPanel } from "@/pages/dashboard";

// Mirror the keys defined inside dashboard.tsx; if they ever drift, that's
// exactly the silent regression these tests are designed to catch — the test
// would seed a key the component no longer reads.
const TREND_DAYS_KEY = "fivesh.dashboard.trendDays";
const TREND_SHIFT_KEY = "fivesh.dashboard.trendShift";

function withQueryClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function expectToggleOn(testId: string) {
  const item = screen.getByTestId(testId);
  expect(item).toHaveAttribute("data-state", "on");
}

function expectToggleOff(testId: string) {
  const item = screen.getByTestId(testId);
  expect(item).toHaveAttribute("data-state", "off");
}

describe("dashboard <LearningTrendPanel> remembers the trend filter", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    trendsHookSpy.mockClear();
  });

  test("restores the previously chosen window + shift from localStorage on mount", () => {
    window.localStorage.setItem(TREND_DAYS_KEY, "30");
    window.localStorage.setItem(TREND_SHIFT_KEY, "B");

    render(withQueryClient(<LearningTrendPanel />));

    expectToggleOn("trend-days-30");
    expectToggleOff("trend-days-7");
    expectToggleOff("trend-days-14");

    expectToggleOn("trend-shift-B");
    expectToggleOff("trend-shift-ALL");
    expectToggleOff("trend-shift-A");
    expectToggleOff("trend-shift-C");

    // The trends query should also be invoked with the restored filter so a
    // future refactor can't satisfy the toggle UI while still requesting the
    // default window from the API.
    expect(trendsHookSpy).toHaveBeenCalledWith(
      expect.objectContaining({ days: 30, shift: "B" }),
    );
  });

  test("toggling new values writes them back to localStorage under the documented keys", () => {
    render(withQueryClient(<LearningTrendPanel />));

    // Defaults first: 14 days / ALL shifts.
    expectToggleOn("trend-days-14");
    expectToggleOn("trend-shift-ALL");

    fireEvent.click(screen.getByTestId("trend-days-7"));
    expect(window.localStorage.getItem(TREND_DAYS_KEY)).toBe("7");
    expectToggleOn("trend-days-7");

    fireEvent.click(screen.getByTestId("trend-shift-C"));
    expect(window.localStorage.getItem(TREND_SHIFT_KEY)).toBe("C");
    expectToggleOn("trend-shift-C");

    // The trends query should reflect the latest selection — guards against a
    // future change that persists the value but forgets to feed it into the
    // hook (or vice versa).
    expect(trendsHookSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ days: 7, shift: "C" }),
    );
  });

  test("falls back to the 14d / ALL defaults when nothing is stored or the stored value is invalid", () => {
    // Case A: nothing stored at all.
    render(withQueryClient(<LearningTrendPanel />));
    expectToggleOn("trend-days-14");
    expectToggleOn("trend-shift-ALL");
    cleanup();

    // Case B: garbage values that the panel must reject rather than honor.
    window.localStorage.setItem(TREND_DAYS_KEY, "999");
    window.localStorage.setItem(TREND_SHIFT_KEY, "Z");
    render(withQueryClient(<LearningTrendPanel />));
    expectToggleOn("trend-days-14");
    expectToggleOn("trend-shift-ALL");

    // The trends hook should still be called with the safe defaults — and
    // crucially without a `shift` key, since "ALL" is expressed by omitting
    // the filter from the request.
    const lastCall = trendsHookSpy.mock.calls.at(-1)?.[0] as
      | { days: number; shift?: string }
      | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall!.days).toBe(14);
    expect(lastCall!.shift).toBeUndefined();
  });
});
