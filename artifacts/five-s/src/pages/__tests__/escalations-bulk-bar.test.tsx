/**
 * Mobile-layout regression for the escalations bulk-action bar.
 *
 * Task #148 made the bulk-action bar wrap-friendly so that, on a phone, the
 * "{n} selected" caption stacks above the row of three buttons (Acknowledge
 * / Resolve / Clear) instead of fighting them for horizontal room. Without
 * the wrap-friendly classes the buttons cropped right off the viewport when
 * a manager selected an escalation on their phone — and the Resolve button
 * (the most consequential of the three) was the one that disappeared first.
 *
 * These tests render the EscalationsPage, force a selection so the bar is
 * visible, and assert:
 *   1. All three bulk-action buttons are rendered together inside the bar.
 *   2. The bar is laid out as a column on phones (`flex-col`) and only
 *      flips to a row at the `sm` breakpoint (`sm:flex-row`), so there is
 *      no horizontal collision on a 375px viewport.
 *   3. The button row inside the bar uses `flex-wrap`, so even if the
 *      caller adds a fourth action later it cannot push the existing
 *      Resolve / Clear buttons off-screen.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@workspace/api-client-react", () => {
  const ListEscalationsSort = {
    recent: "recent",
    mostReminded: "mostReminded",
  } as const;
  const noopMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => undefined),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  });
  const noopQuery = (data: unknown = undefined) => () => ({
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return {
    ListEscalationsSort,
    useListEscalations: noopQuery([
      {
        id: 1,
        submissionId: 11,
        areaId: 1,
        areaName: "Bay 1",
        operatorEmail: "op@5s.test",
        shift: "A",
        status: "OPEN",
        scorePercent: 30,
        scoreTotal: 8,
        failingPillars: [],
        evidenceUrls: [],
        recommendedActions: [],
        createdAt: new Date().toISOString(),
        acknowledgedAt: null,
        resolvedAt: null,
        notifyDeliveryStatus: null,
        notifyAttempts: 0,
        repingCount: 0,
        lastRepingAt: null,
      },
    ]),
    useAcknowledgeEscalation: noopMutation,
    useResolveEscalation: noopMutation,
    getListEscalationsQueryKey: () => ["escalations"],
    getGetEscalationCountQueryKey: () => ["escalation-count"],
    // Sort enum used by the escalations page header. Mirrors the values in
    // the generated client so component code can reference them by key.
    ListEscalationsSort: { recent: "recent", mostReminded: "mostReminded" },
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

import EscalationsPage from "@/pages/escalations";

function withQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

async function openBulkBar() {
  // The bar only renders once at least one escalation is selected. The
  // top-of-list "select all" checkbox is the most stable trigger.
  const checkboxes = await screen.findAllByRole("checkbox");
  // The first checkbox is the per-card selector for our single fixture row.
  await userEvent.click(checkboxes[0]);
}

describe("Escalations bulk-action bar — mobile (320–375px) layout", () => {
  beforeEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
  });

  test("renders all three bulk-action buttons together inside the bar", async () => {
    render(withQuery(<EscalationsPage />));
    await openBulkBar();

    const bar = await screen.findByTestId("bar-bulk-actions");
    expect(within(bar).getByTestId("button-bulk-ack")).toBeInTheDocument();
    expect(within(bar).getByTestId("button-bulk-resolve")).toBeInTheDocument();
    expect(within(bar).getByTestId("button-bulk-clear")).toBeInTheDocument();
  });

  test("bar stacks vertically on phones and only flips to a row at the sm breakpoint", async () => {
    render(withQuery(<EscalationsPage />));
    await openBulkBar();

    const bar = await screen.findByTestId("bar-bulk-actions");
    // On phones the wrapper is a column…
    expect(bar.className).toMatch(/\bflex-col\b/);
    // …and only switches to a row at the sm breakpoint.
    expect(bar.className).toMatch(/\bsm:flex-row\b/);
  });

  test("the buttons row inside the bar wraps to avoid horizontal overflow", async () => {
    render(withQuery(<EscalationsPage />));
    await openBulkBar();

    const bar = await screen.findByTestId("bar-bulk-actions");
    const ackButton = within(bar).getByTestId("button-bulk-ack");
    // Walk up from a button to find the buttons row container — it's the
    // closest ancestor with `flex-wrap`. Using a className-based selector
    // is intentional: we are locking in the layout decision.
    const buttonsRow = ackButton.closest(".flex-wrap") as HTMLElement | null;
    expect(buttonsRow).not.toBeNull();
    expect(buttonsRow!.className).toMatch(/\bflex-wrap\b/);
    // All three buttons live inside the wrap-enabled row.
    expect(within(buttonsRow!).getByTestId("button-bulk-ack")).toBeInTheDocument();
    expect(within(buttonsRow!).getByTestId("button-bulk-resolve")).toBeInTheDocument();
    expect(within(buttonsRow!).getByTestId("button-bulk-clear")).toBeInTheDocument();
  });
});
