import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock framer-motion so layout/AnimatePresence don't fight jsdom: render plain
// elements and forward all props/refs (operator.tsx uses motion.div, motion.span,
// AnimatePresence, and motion.${string}).
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

// Define mock hook factories before importing the component (vi.mock is hoisted).
const mockState = {
  recent: [] as unknown[],
  statuses: [] as unknown[],
  nextChecks: [] as unknown[],
  shift: { shift: "A" } as { shift: "A" | "B" | "C" } | undefined,
  shiftLoading: false,
  shiftError: false,
  profile: undefined as unknown,
  nudges: [] as unknown[],
  nudgesByArea: [] as unknown[],
  submission: undefined as unknown,
};

const refetchCurrentShiftMock = vi.fn();

vi.mock("@workspace/api-client-react", () => {
  const stub = (key: keyof typeof mockState) => () => ({
    data: mockState[key],
    isLoading: false,
  });
  return {
    // useGetCurrentShift needs the richer shape (isError / isRefetching /
    // refetch) so the operator page can render a loading skeleton or an
    // explicit error state instead of silently defaulting to Shift A.
    useGetCurrentShift: () => ({
      data: mockState.shiftLoading || mockState.shiftError ? undefined : mockState.shift,
      isLoading: mockState.shiftLoading,
      isError: mockState.shiftError,
      isRefetching: false,
      refetch: refetchCurrentShiftMock,
    }),
    useGetOperatorStatus: stub("statuses"),
    useGetNextChecks: stub("nextChecks"),
    useGetOperatorRecent: stub("recent"),
    useGetActiveNudges: stub("nudges"),
    useGetActiveNudgesByArea: stub("nudgesByArea"),
    useGetAreaProfile: stub("profile"),
    useGetSubmission: stub("submission"),
    // useEffectiveOperatorThresholds() reads this. Returning `undefined` data
    // exercises the fallback-to-defaults path, which is the safest default
    // for the existing tests (they were written against the constants).
    useGetOperatorThresholds: () => ({ data: undefined, isLoading: false }),
    getGetOperatorThresholdsQueryKey: () => ["operator-thresholds"],
    useCreateSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useReuploadSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // Auto-detect area runs when the operator picks media in the capture sheet.
    // The tests don't exercise the real network call, so a no-op mutation is
    // enough — but the hook must exist on the mock or AreaCard crashes during
    // render with "useIdentifySubmissionArea is not defined".
    useIdentifySubmissionArea: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => ({
        candidates: [],
        hasTrainedAreas: false,
        rationale: null,
      })),
      isPending: false,
    }),
    useDismissNudge: () => ({
      mutate: vi.fn(),
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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "operator@test.local", role: "OPERATOR" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// QueryClientProvider is needed because operator.tsx calls useQueryClient.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OperatorHome from "../operator";
import { OPERATOR_THRESHOLDS } from "@/lib/operator-thresholds";
import type {
  AreaStatus,
  NextCheck,
  RecentSubmission,
  Submission,
} from "@workspace/api-client-react";

const RECENT_STRIP_PREF_KEY = "operator.recentStrip.collapsed";

// Derive boundary scoreTotal values from the shared threshold so the tests
// stay correct if the threshold is tuned. scoreTotal is 0..25 and percent is
// scoreTotal * 4, so any scoreTotal >= ceil(MIN_PCT/4) is "good".
const MIN_GOOD_SCORE_TOTAL = Math.ceil(
  OPERATOR_THRESHOLDS.ENCOURAGEMENT_MIN_PERCENT / 4,
);
const SCORE_TOTAL_ABOVE_THRESHOLD = Math.min(25, MIN_GOOD_SCORE_TOTAL + 2);
const SCORE_TOTAL_BELOW_THRESHOLD = Math.max(0, MIN_GOOD_SCORE_TOTAL - 1);

function renderOperator() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OperatorHome />
    </QueryClientProvider>,
  );
}

function makeRecent(overrides: Partial<RecentSubmission>): RecentSubmission {
  return {
    id: 1,
    areaId: 1,
    areaName: "Mixing Floor",
    shift: "A",
    scoreTotal: 20,
    mediaType: "image",
    machineTag: null,
    createdAt: new Date().toISOString(),
    prevScoreTotal: null,
    bestScoreInLastWeek: null,
    ...overrides,
  };
}

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 100,
    areaId: 1,
    areaName: "Mixing Floor",
    userId: 1,
    userEmail: "op@test",
    shift: "A",
    scoreTotal: 20,
    scoreJson: { sort: 4, set: 4, shine: 4, standardize: 4, sustain: 4 },
    suggestionsJson: ["Keep it tidy"],
    imageUrl: "/uploads/x.jpg",
    mediaType: "image",
    keyframesJson: null,
    machineTag: null,
    failingPillarsJson: [],
    createdAt: new Date().toISOString(),
    ...(overrides as object),
  } as Submission;
}

function makeStatus(overrides: Partial<AreaStatus>): AreaStatus {
  return {
    areaId: 1,
    areaName: "Mixing Floor",
    environmentType: "factory",
    submitted: false,
    ...overrides,
  };
}

function makeNextCheck(overrides: Partial<NextCheck>): NextCheck {
  return {
    areaId: 1,
    areaName: "Mixing Floor",
    machine: null,
    lastCheckAt: null,
    nextDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    cadenceSeconds: 3600,
    overdue: false,
    reason: "scheduled",
    ...overrides,
  };
}

beforeEach(() => {
  mockState.recent = [];
  mockState.statuses = [];
  mockState.nextChecks = [];
  mockState.shift = { shift: "A" };
  mockState.shiftLoading = false;
  mockState.shiftError = false;
  mockState.profile = undefined;
  mockState.nudges = [];
  mockState.submission = undefined;
  refetchCurrentShiftMock.mockReset();
  window.localStorage.clear();
});

describe("OperatorHome — recent audits strip", () => {
  it("persists collapse / expand state across re-renders via localStorage", async () => {
    mockState.recent = [makeRecent({ id: 1, scoreTotal: 18 })];
    mockState.statuses = [makeStatus({ areaId: 1 })];

    const { unmount } = renderOperator();

    // Default = expanded; toggle button reads "Hide" and is aria-expanded=true.
    const toggle = await screen.findByTestId("button-toggle-recent-audits");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent(/Hide/i);

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent(/Show/i);
    expect(window.localStorage.getItem(RECENT_STRIP_PREF_KEY)).toBe("1");

    // Unmount and remount — preference must be honoured on subsequent loads.
    unmount();
    renderOperator();
    const toggle2 = await screen.findByTestId("button-toggle-recent-audits");
    expect(toggle2).toHaveAttribute("aria-expanded", "false");
    expect(toggle2).toHaveTextContent(/Show/i);
  });

  it("hides the strip entirely when there are no recent audits", () => {
    mockState.recent = [];
    mockState.statuses = [makeStatus({ areaId: 1 })];
    renderOperator();
    expect(
      screen.queryByTestId("button-toggle-recent-audits"),
    ).not.toBeInTheDocument();
  });
});

describe("OperatorHome — area sort order", () => {
  it("orders pending areas: overdue → due-soon → ok, with submitted areas last", () => {
    // Four areas: 1 = ok pending, 2 = due-soon pending, 3 = overdue pending,
    // 4 = already submitted. Expected DOM order: 3, 2, 1, 4.
    mockState.statuses = [
      makeStatus({ areaId: 1, areaName: "AA Ok Pending" }),
      makeStatus({ areaId: 2, areaName: "BB Due Soon" }),
      makeStatus({ areaId: 3, areaName: "CC Overdue" }),
      makeStatus({
        areaId: 4,
        areaName: "DD Submitted",
        submitted: true,
        submission: makeSubmission({ id: 400, areaId: 4, areaName: "DD Submitted" }),
      }),
    ];
    mockState.nextChecks = [
      makeNextCheck({
        areaId: 1,
        nextDueAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      }),
      makeNextCheck({
        areaId: 2,
        nextDueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
      makeNextCheck({
        areaId: 3,
        overdue: true,
        nextDueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        lastCheckAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      }),
    ];

    renderOperator();

    const headings = screen.getAllByRole("heading", { level: 3 });
    const headingTexts = headings.map((h) => h.textContent?.trim());
    expect(headingTexts).toEqual([
      "CC Overdue",
      "BB Due Soon",
      "AA Ok Pending",
      "DD Submitted",
    ]);

    expect(screen.getByTestId("pill-overdue-3")).toBeInTheDocument();
    expect(screen.getByTestId("pill-duesoon-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pill-overdue-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pill-duesoon-1")).not.toBeInTheDocument();
  });
});

describe("OperatorHome — encouragement chip", () => {
  it("renders 'New best this week' when score is at/above the threshold AND beats prior week best", () => {
    const goodScore = SCORE_TOTAL_ABOVE_THRESHOLD;
    const priorBest = Math.max(0, goodScore - 4);
    const submission = makeSubmission({ id: 555, areaId: 7, scoreTotal: goodScore });
    mockState.statuses = [
      makeStatus({
        areaId: 7,
        areaName: "Bay 7",
        submitted: true,
        submission,
      }),
    ];
    mockState.recent = [
      makeRecent({
        id: submission.id,
        areaId: 7,
        scoreTotal: goodScore,
        prevScoreTotal: priorBest,
        bestScoreInLastWeek: priorBest,
      }),
    ];

    renderOperator();
    const chip = screen.getByTestId(`chip-encouragement-${submission.id}`);
    expect(chip).toHaveTextContent(/New best this week/);
  });

  it("does NOT render the chip when score is below the threshold even if it beats the prior best", () => {
    const lowScore = SCORE_TOTAL_BELOW_THRESHOLD;
    const submission = makeSubmission({ id: 556, areaId: 8, scoreTotal: lowScore });
    mockState.statuses = [
      makeStatus({
        areaId: 8,
        areaName: "Bay 8",
        submitted: true,
        submission,
      }),
    ];
    mockState.recent = [
      makeRecent({
        id: submission.id,
        areaId: 8,
        scoreTotal: lowScore,
        prevScoreTotal: Math.max(0, lowScore - 5),
        bestScoreInLastWeek: Math.max(0, lowScore - 5),
      }),
    ];

    renderOperator();
    expect(
      screen.queryByTestId(`chip-encouragement-${submission.id}`),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the chip when the score does not beat prior week best", () => {
    const goodScore = SCORE_TOTAL_ABOVE_THRESHOLD;
    // Cap prior best at 25 (scoreTotal max) — when the boundary is already at
    // the ceiling we tie rather than exceed, which still suppresses the chip.
    const priorBest = Math.min(25, goodScore + 1);
    const submission = makeSubmission({ id: 557, areaId: 9, scoreTotal: goodScore });
    mockState.statuses = [
      makeStatus({
        areaId: 9,
        areaName: "Bay 9",
        submitted: true,
        submission,
      }),
    ];
    mockState.recent = [
      makeRecent({
        id: submission.id,
        areaId: 9,
        scoreTotal: goodScore,
        prevScoreTotal: goodScore,
        bestScoreInLastWeek: priorBest,
      }),
    ];

    renderOperator();
    expect(
      screen.queryByTestId(`chip-encouragement-${submission.id}`),
    ).not.toBeInTheDocument();
  });
});

describe("OperatorHome — capture sheet", () => {
  it("exposes a single 'Add evidence' button per pending area", () => {
    mockState.statuses = [
      makeStatus({ areaId: 1, areaName: "Bay 1" }),
      makeStatus({ areaId: 2, areaName: "Bay 2" }),
    ];
    renderOperator();

    // One Add evidence per pending area; no other "Add evidence" entry points.
    expect(screen.getByTestId("button-add-evidence-1")).toBeInTheDocument();
    expect(screen.getByTestId("button-add-evidence-2")).toBeInTheDocument();
    const allAddButtons = screen.getAllByRole("button", {
      name: /add evidence/i,
    });
    expect(allAddButtons).toHaveLength(2);
  });

  it("opens the capture sheet with the Submit button disabled until media is attached", async () => {
    mockState.statuses = [makeStatus({ areaId: 1, areaName: "Bay 1" })];
    renderOperator();

    await userEvent.click(screen.getByTestId("button-add-evidence-1"));

    // The sheet now shows the three capture entry points and a disabled Submit.
    const sheet = await screen.findByTestId("sheet-capture");
    expect(within(sheet).getByTestId("button-capture-record")).toBeInTheDocument();
    expect(within(sheet).getByTestId("button-capture-pick")).toBeInTheDocument();
    expect(within(sheet).getByTestId("button-capture-photo")).toBeInTheDocument();

    const submit = within(sheet).getByTestId("button-capture-submit");
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/^Submit$/);
  });

  // Regression: the operator capture sheet must show an environment-specific
  // "what to include in your walk-through" hint list before the operator
  // records, so the resulting video is grounded enough for the AI rubric to
  // score well — especially in the new Corporate Office environment, where
  // what to capture is least obvious.
  it.each([
    [
      "corporate_office",
      "Corporate Office",
      [
        "Walk past every desk in the workspace",
        "Open meeting room doors and pan inside",
        "Capture the shared kitchen and sink",
        "Show storage cupboards and supply closets",
        "Include the printer and copy zones",
      ],
    ],
    [
      "factory",
      "Factory",
      [
        "Walk past every machine and workstation",
        "Pan over PPE racks and emergency exits",
      ],
    ],
    [
      "warehouse",
      "Warehouse",
      [
        "Walk each aisle end-to-end",
        "Capture the loading dock and outbound staging",
      ],
    ],
    [
      "home",
      "Home",
      [
        "Walk through every room you're auditing",
        "Open the pantry and main cupboards",
      ],
    ],
  ] as const)(
    "shows the %s walk-through checklist when the area's environmentType is %s",
    async (environmentType, _label, expectedItems) => {
      mockState.statuses = [
        makeStatus({
          areaId: 1,
          areaName: "Bay 1",
          environmentType: environmentType as
            | "factory"
            | "warehouse"
            | "home"
            | "corporate_office",
        }),
      ];
      renderOperator();

      await userEvent.click(screen.getByTestId("button-add-evidence-1"));
      const sheet = await screen.findByTestId("sheet-capture");

      const checklist = within(sheet).getByTestId("environment-checklist");
      expect(checklist).toBeInTheDocument();
      expect(checklist).toHaveAttribute("data-environment", environmentType);
      // Verify the bullets are environment-specific, not the generic copy.
      for (const text of expectedItems) {
        expect(within(checklist).getByText(text)).toBeInTheDocument();
      }
    },
  );

  // Defensive default: an area whose environmentType is missing from the
  // payload (older API, partial response) must still render *some* checklist
  // rather than crashing or showing a blank slot. We fall back to the
  // factory hints — that's what normalizeEnvironment() does today and what
  // the rest of the operator UI assumes.
  it("falls back to the factory checklist when an area has no environmentType", async () => {
    mockState.statuses = [
      makeStatus({
        areaId: 1,
        areaName: "Bay 1",
        // Cast away the required field so we can simulate the upgrade-window
        // case where a server build hasn't shipped environmentType yet.
        environmentType: undefined as unknown as "factory",
      }),
    ];
    renderOperator();

    await userEvent.click(screen.getByTestId("button-add-evidence-1"));
    const sheet = await screen.findByTestId("sheet-capture");

    const checklist = within(sheet).getByTestId("environment-checklist");
    expect(checklist).toHaveAttribute("data-environment", "factory");
    expect(
      within(checklist).getByText("Walk past every machine and workstation"),
    ).toBeInTheDocument();
  });
});

describe("OperatorHome — current shift state", () => {
  // Regression: the page used to do `selectedShift ?? currentShift?.shift ?? "A"`
  // which silently labelled the screen as Shift A whenever the API was loading,
  // errored, or briefly unreachable — even when IST was clearly outside 6 AM
  // – 2 PM. These tests lock in that no shift is ever pre-selected unless the
  // server actually returned one (or the operator picked one manually).

  it("shows a loading state and does not pre-select Shift A while the current-shift query is in flight", () => {
    mockState.shiftLoading = true;
    mockState.shift = undefined;
    // Even if the statuses endpoint somehow resolved with rows, they should
    // not be rendered yet — we don't know which shift to filter to.
    mockState.statuses = [makeStatus({ areaId: 1, areaName: "Bay 1" })];

    renderOperator();

    expect(screen.getByTestId("text-shift-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("text-shift-error")).not.toBeInTheDocument();

    // Pills exist but none is selected, and the assigned-areas section is
    // not rendered (so we cannot mis-show shift A's areas).
    for (const s of ["A", "B", "C"] as const) {
      const pill = screen.getByTestId(`button-shift-${s}`);
      expect(pill).toHaveAttribute("aria-selected", "false");
      expect(pill).toBeDisabled();
    }
    expect(
      screen.queryByRole("heading", { name: /assigned areas/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-add-evidence-1")).not.toBeInTheDocument();
  });

  it.each([["B"], ["C"]] as const)(
    "selects shift %s when the current-shift API returns it",
    (shift) => {
      mockState.shift = { shift };
      mockState.statuses = [
        makeStatus({ areaId: 1, areaName: "Bay 1" }),
      ];

      renderOperator();

      // The loading / error scaffolding from the unknown view must not appear.
      expect(screen.queryByTestId("text-shift-loading")).not.toBeInTheDocument();
      expect(screen.queryByTestId("text-shift-error")).not.toBeInTheDocument();

      // The pill for the returned shift is the active tab; the others are not.
      const tabs = screen.getAllByRole("tab");
      const active = tabs.filter(
        (t) => t.getAttribute("aria-selected") === "true",
      );
      expect(active).toHaveLength(1);
      expect(active[0]).toHaveTextContent(new RegExp(`Shift ${shift}`, "i"));

      // Sanity: the assigned-areas section renders (so we did NOT bail out
      // through the unknown-shift view).
      expect(
        screen.getByRole("heading", { name: /assigned areas/i }),
      ).toBeInTheDocument();
    },
  );

  it("shows an error state with a Retry button (and does NOT silently pick A) when the current-shift query errors", async () => {
    mockState.shiftError = true;
    mockState.shift = undefined;
    mockState.statuses = [makeStatus({ areaId: 1, areaName: "Bay 1" })];

    renderOperator();

    expect(screen.getByTestId("text-shift-error")).toHaveTextContent(
      /couldn['’]t determine current shift/i,
    );

    // No pill is auto-selected.
    for (const s of ["A", "B", "C"] as const) {
      expect(screen.getByTestId(`button-shift-${s}`)).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }

    // Assigned-areas section is suppressed — no chance of showing shift A's
    // submissions while we don't actually know which shift the operator is on.
    expect(
      screen.queryByRole("heading", { name: /assigned areas/i }),
    ).not.toBeInTheDocument();

    // Retry button calls refetch on the current-shift query.
    const retry = screen.getByTestId("button-retry-current-shift");
    await userEvent.click(retry);
    expect(refetchCurrentShiftMock).toHaveBeenCalledTimes(1);
  });

  it("treats 'query settled with no data' the same as an error so the UI never sits on 'Checking…' forever", () => {
    // Simulates the case where the API call resolved cleanly but produced no
    // usable shift (e.g. an empty/invalid response body): isLoading=false,
    // isError=false, data=undefined.
    mockState.shiftLoading = false;
    mockState.shiftError = false;
    mockState.shift = undefined;
    mockState.statuses = [makeStatus({ areaId: 1, areaName: "Bay 1" })];

    renderOperator();

    expect(screen.getByTestId("text-shift-error")).toBeInTheDocument();
    expect(screen.queryByTestId("text-shift-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-retry-current-shift")).toBeInTheDocument();
    // No assigned-areas fallback to shift A here either.
    expect(
      screen.queryByRole("heading", { name: /assigned areas/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the normal page once the operator manually picks a shift even if the API is errored", async () => {
    mockState.shiftError = true;
    mockState.shift = undefined;
    mockState.statuses = [makeStatus({ areaId: 1, areaName: "Bay 1" })];

    renderOperator();

    // Manually select shift B via the unknown-view pill.
    await userEvent.click(screen.getByTestId("button-shift-B"));

    // Now the normal page is rendered — the assigned-areas section appears
    // and shift B's tab is active.
    expect(
      await screen.findByRole("heading", { name: /assigned areas/i }),
    ).toBeInTheDocument();
    const activeTabs = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(activeTabs).toHaveLength(1);
    expect(activeTabs[0]).toHaveTextContent(/Shift B/i);
  });
});
