import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  type AnyProps = Record<string, unknown> & { children?: React.ReactNode };
  const stripMotionProps = (props: AnyProps) => {
    const {
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      layout: _l,
      layoutId: _lid,
      whileHover: _wh,
      whileTap: _wt,
      whileFocus: _wf,
      whileInView: _wi,
      variants: _v,
      drag: _d,
      ...rest
    } = props;
    return rest;
  };
  const make = (tag: string) =>
    React.forwardRef<HTMLElement, AnyProps>(function MotionTag(props, ref) {
      const cleaned = stripMotionProps(props);
      return React.createElement(
        tag,
        { ...cleaned, ref },
        (cleaned as { children?: React.ReactNode }).children,
      );
    });
  const motionProxy = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => make(prop),
  });
  const AnimatePresence = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return { motion: motionProxy, AnimatePresence };
});

const dismissMutateMock = vi.fn();
const undismissMutateMock = vi.fn();

const mockState = {
  recent: [] as unknown[],
  statuses: [] as unknown[],
  nextChecks: [] as unknown[],
  shift: { shift: "A" } as { shift: "A" | "B" | "C" } | undefined,
  profile: undefined as unknown,
  nudges: [] as unknown[],
  nudgesByArea: [] as unknown[],
  submission: undefined as unknown,
  shiftConfig: {
    timeZone: "Asia/Kolkata",
    startHours: { A: 6, B: 14, C: 22 },
  } as
    | { timeZone: string; startHours: { A: number; B: number; C: number } }
    | undefined,
};

vi.mock("@workspace/api-client-react", () => {
  const stub = (key: keyof typeof mockState) => () => ({
    data: mockState[key],
    isLoading: false,
  });
  return {
    useGetCurrentShift: () => ({
      data: mockState.shift,
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useGetOperatorStatus: stub("statuses"),
    useGetNextChecks: stub("nextChecks"),
    useGetOperatorRecent: stub("recent"),
    useGetActiveNudges: stub("nudges"),
    useGetActiveNudgesByArea: stub("nudgesByArea"),
    useGetAreaProfile: stub("profile"),
    useGetSubmission: stub("submission"),
    useGetOperatorThresholds: () => ({ data: undefined, isLoading: false }),
    getGetOperatorThresholdsQueryKey: () => ["operator-thresholds"],
    useGetShiftConfig: () => ({
      data: mockState.shiftConfig,
      isLoading: false,
    }),
    getGetShiftConfigQueryKey: () => ["shift-config"],
    // OperatorHome calls useFacilitySettingsChangeListener which polls
    // useGetFacilitySettings; stub it so the operator page mounts.
    useGetFacilitySettings: () => ({ data: undefined, isLoading: false }),
    getGetFacilitySettingsQueryKey: () => ["facility-settings"],
    useCreateSubmission: () => ({ mutate: vi.fn(), isPending: false }),
    useReuploadSubmission: () => ({ mutate: vi.fn(), isPending: false }),
    useIdentifySubmissionArea: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({
        candidates: [],
        hasTrainedAreas: false,
        rationale: null,
      })),
      isPending: false,
      reset: vi.fn(),
    }),
    useDismissNudge: () => ({
      mutate: dismissMutateMock,
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    useUndismissNudge: () => ({
      mutate: undismissMutateMock,
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    getGetCurrentShiftQueryKey: () => ["shift"],
    getGetOperatorStatusQueryKey: () => ["status"],
    getGetNextChecksQueryKey: () => ["next-checks"],
    getGetOperatorRecentQueryKey: () => ["recent"],
    getGetActiveNudgesQueryKey: () => ["nudges"],
    getGetActiveNudgesByAreaQueryKey: () => ["nudges-by-area"],
    getGetSubmissionQueryKey: () => ["submission"],
    getGetAreaProfileQueryKey: () => ["profile"],
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "operator@test.local", role: "OPERATOR" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OperatorHome from "../operator";
import { Toaster } from "@/components/ui/toaster";
import type { AreaStatus, Nudge } from "@workspace/api-client-react";

function makeStatus(overrides: Partial<AreaStatus>): AreaStatus {
  return {
    areaId: 1,
    areaName: "Mixing Floor",
    environmentType: "factory",
    submitted: false,
    ...overrides,
  };
}

function makeNudge(overrides: Partial<Nudge> = {}): Nudge {
  return {
    id: 42,
    areaId: 1,
    areaName: "Mixing Floor",
    shift: "A",
    machine: null,
    message: "Please rerun this area",
    createdByEmail: "manager@test.local",
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    dismissedAt: null,
    ...overrides,
  };
}

function renderOperatorWithToaster() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OperatorHome />
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.recent = [];
  mockState.statuses = [makeStatus({ areaId: 1, areaName: "Mixing Floor" })];
  mockState.nextChecks = [];
  mockState.shift = { shift: "A" };
  mockState.profile = undefined;
  mockState.nudges = [];
  mockState.nudgesByArea = [];
  mockState.submission = undefined;
  mockState.shiftConfig = {
    timeZone: "Asia/Kolkata",
    startHours: { A: 6, B: 14, C: 22 },
  };
  dismissMutateMock.mockReset();
  undismissMutateMock.mockReset();
  // useDismissNudge.mutate must invoke onSuccess so the Undo toast appears.
  dismissMutateMock.mockImplementation(
    (_vars: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    },
  );
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NudgeBanner — dismiss & undo flow", () => {
  it("clicking the X opens the Undo toast and tapping Undo undismisses the right nudge", async () => {
    const nudge = makeNudge({ id: 42, areaId: 1 });
    mockState.nudgesByArea = [nudge];

    const user = userEvent.setup();
    renderOperatorWithToaster();

    // Sanity: banner is visible for this area.
    expect(await screen.findByTestId("nudge-banner-1")).toBeInTheDocument();

    // Tap the X — server dismiss runs, onSuccess fires the toast.
    await user.click(screen.getByTestId("button-dismiss-nudge-42"));

    expect(dismissMutateMock).toHaveBeenCalledTimes(1);
    expect(dismissMutateMock).toHaveBeenCalledWith(
      { id: 42 },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    // The Undo toast must surface with the action button — wired with the
    // *exact* nudge id from the moment of dismissal so a later Undo tap can't
    // be misrouted to a different nudge.
    const undoBtn = await screen.findByTestId(
      "button-undo-dismiss-nudge-42",
    );
    expect(undoBtn).toHaveTextContent(/Undo/);

    await user.click(undoBtn);

    expect(undismissMutateMock).toHaveBeenCalledTimes(1);
    expect(undismissMutateMock).toHaveBeenCalledWith(
      { id: 42 },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("auto-dismisses the toast after ~6s and does NOT call undismiss", async () => {
    const nudge = makeNudge({ id: 7, areaId: 1 });
    mockState.nudgesByArea = [nudge];

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });

    renderOperatorWithToaster();

    await user.click(await screen.findByTestId("button-dismiss-nudge-7"));

    // Toast appears with the Undo action.
    const undoBtn = await screen.findByTestId(
      "button-undo-dismiss-nudge-7",
    );
    expect(undoBtn).toBeInTheDocument();

    // Advance past the 6s window the NudgeBanner uses for the auto-close
    // setTimeout. Wrap in act so the resulting state update flushes.
    await act(async () => {
      vi.advanceTimersByTime(6_001);
    });

    // The toast's open state must have flipped to closed (Radix renders
    // closed toasts with data-state="closed" before unmounting). We assert
    // the action is no longer reachable as an actionable button.
    const stillThere = screen.queryByTestId(
      "button-undo-dismiss-nudge-7",
    );
    if (stillThere) {
      // If Radix kept it mounted during the close animation, its closest
      // toast root must report data-state="closed".
      const root = stillThere.closest("[data-state]");
      expect(root?.getAttribute("data-state")).toBe("closed");
    }

    // The critical invariant: a silent timeout must NEVER look like an Undo.
    expect(undismissMutateMock).not.toHaveBeenCalled();
  });
});
