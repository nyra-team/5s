/**
 * Component-level guard for the persistent manager-nudge UX on the operator's
 * area cards. The pill + banner are produced inside <AreaCard>, and the
 * "implicit clear on submit" UX relies on operator.tsx invalidating the
 * /nudges/active-by-area query — which simply re-renders <AreaCard> with an
 * empty activeNudges prop. So this test asserts:
 *
 *   1. Non-empty activeNudges  → both the pill and the banner render.
 *   2. Empty activeNudges      → neither renders.
 *
 * Together those two cases cover the after-submission invalidation flow:
 * the parent will re-render the same card with [] once the query is refetched.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock the heavy dependencies so the card renders standalone, without spinning
// up real React Query mutations, IndexedDB drafts, an auth provider, or toasts.
vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@workspace/api-client-react",
  );
  const idle = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(async () => undefined),
    isPending: false,
  });
  const noopQuery = () => ({ data: undefined, isLoading: false });
  return {
    ...actual,
    useCreateSubmission: idle,
    useReuploadSubmission: idle,
    // AreaCard now also calls useIdentifySubmissionArea() and useDismissNudge()
    // — provide both so the component can render in isolation here. The
    // identify mock returns a real-shape payload (added in task #83) since
    // the capture sheet awaits it before showing candidates.
    useIdentifySubmissionArea: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({
        candidates: [],
        hasTrainedAreas: false,
        rationale: null,
      })),
      isPending: false,
    }),
    useDismissNudge: idle,
    useUndismissNudge: idle,
    useGetAreaProfile: noopQuery,
    useGetSubmission: noopQuery,
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 99, email: "op@5s.test", role: "OPERATOR" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

// IndexedDB doesn't exist in jsdom; stub the draft helpers to no-op. Every
// helper that operator.tsx (where AreaCard lives) imports has to be present
// here, otherwise vitest throws an unhandled rejection from inside an effect
// which fails the whole run even when assertions pass.
vi.mock("@/lib/capture-drafts", () => ({
  loadCaptureDraft: vi.fn(async () => null),
  peekCaptureDraftMeta: vi.fn(async () => null),
  saveCaptureDraft: vi.fn(async () => undefined),
  deleteCaptureDraft: vi.fn(async () => undefined),
  peekCaptureDraftMeta: vi.fn(async () => null),
  purgeStaleCaptureDrafts: vi.fn(async () => undefined),
  peekCaptureDraftMeta: vi.fn(async () => null),
}));

import { AreaCard } from "@/pages/operator";
import type { AreaStatus, Nudge } from "@workspace/api-client-react";

function withQueryClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const baseStatus: AreaStatus = {
  areaId: 42,
  areaName: "Packing Floor",
  environmentType: "factory",
  submitted: false,
};

function makeNudge(overrides: Partial<Nudge> = {}): Nudge {
  return {
    id: 1,
    areaId: 42,
    areaName: "Packing Floor",
    machine: null,
    shift: "A",
    message: "Please re-check this area",
    createdByEmail: "manager@5s.test",
    createdAt: new Date().toISOString(),
    dismissedAt: null,
    ...overrides,
  };
}

describe("operator <AreaCard> manager-nudge surfaces", () => {
  beforeEach(() => {
    cleanup();
  });

  test("renders the nudge pill AND banner when activeNudges is non-empty", () => {
    render(
      withQueryClient(
        <AreaCard
          status={baseStatus}
          selectedShift="A"
          assignedAreas={[baseStatus]}
          dueState="ok"
          dueInfo={undefined}
          recentForSubmission={undefined}
          lastGood={null}
          activeNudges={[makeNudge()]}
          encouragementMinPercent={80}
        />,
      ),
    );

    expect(screen.getByTestId(`pill-nudge-${baseStatus.areaId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`nudge-banner-${baseStatus.areaId}`)).toBeInTheDocument();
    // The banner's body should expose the manager's message and identity so a
    // future copy/style refactor that drops them is caught here.
    expect(screen.getByText(/Please re-check this area/)).toBeInTheDocument();
    expect(screen.getByText(/manager@5s\.test/)).toBeInTheDocument();
  });

  test("does NOT render the pill or banner when activeNudges is empty (post-submit invalidation state)", () => {
    render(
      withQueryClient(
        <AreaCard
          status={baseStatus}
          selectedShift="A"
          assignedAreas={[baseStatus]}
          dueState="ok"
          dueInfo={undefined}
          recentForSubmission={undefined}
          lastGood={null}
          activeNudges={[]}
          encouragementMinPercent={80}
        />,
      ),
    );

    expect(screen.queryByTestId(`pill-nudge-${baseStatus.areaId}`)).toBeNull();
    expect(screen.queryByTestId(`nudge-banner-${baseStatus.areaId}`)).toBeNull();
  });

  test("exposes the absolute timestamp via title on the overdue 'Last checked' line", () => {
    // Ten minutes ago — far enough back that the relative label reads ">5 min".
    const lastCheck = new Date(Date.now() - 10 * 60_000);
    const dueAt = new Date(Date.now() - 60_000); // already past
    render(
      withQueryClient(
        <AreaCard
          status={baseStatus}
          selectedShift="A"
          assignedAreas={[baseStatus]}
          dueState="overdue"
          dueInfo={{
            areaId: baseStatus.areaId,
            lastCheckAt: lastCheck.toISOString(),
            nextDueAt: dueAt.toISOString(),
            cadenceMinutes: 60,
          }}
          recentForSubmission={undefined}
          lastGood={null}
          activeNudges={[]}
          encouragementMinPercent={80}
        />,
      ),
    );

    // The relative label should render and carry a `title` containing the
    // formatted absolute timestamp (e.g. "Last checked Apr 24, 2026 11:00 AM").
    const line = screen.getByText(/Last checked .* ago\./);
    expect(line).toBeInTheDocument();
    const title = line.getAttribute("title");
    expect(title).toMatch(/^Last checked /);
    // Year is part of the absolute format — guards against a future swap to a
    // relative-only string that would re-introduce the staleness bug.
    expect(title).toMatch(/\d{4}/);
  });

  test("shows a count badge on the pill when multiple nudges are open for the area", () => {
    render(
      withQueryClient(
        <AreaCard
          status={baseStatus}
          selectedShift="A"
          assignedAreas={[baseStatus]}
          dueState="ok"
          dueInfo={undefined}
          recentForSubmission={undefined}
          lastGood={null}
          activeNudges={[
            makeNudge({ id: 1, machine: "Mixer-1" }),
            makeNudge({ id: 2, machine: "Mixer-2" }),
          ]}
          encouragementMinPercent={80}
        />,
      ),
    );

    const pill = screen.getByTestId(`pill-nudge-${baseStatus.areaId}`);
    expect(pill).toBeInTheDocument();
    // The count is rendered as "×N" inside the pill.
    expect(pill).toHaveTextContent(/×2/);
  });
});
