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
  // useGetOperatorThresholds() drives the resolved thresholds hook. Default
  // is `undefined` so the hook falls back to the static defaults — matching
  // the rest of the suite, which was written against the constants. Tests
  // that need per-area "due soon" overrides set this to a partial payload
  // (e.g. `{ areaOverrides: [{ areaId: 2, dueSoonThresholdMinutes: 30, ... }] }`).
  operatorThresholds: undefined as unknown,
  // Default to the legacy IST 6/14/22 hours so existing tests that assert
  // "6 AM – 2 PM" labels keep passing without explicit setup. Individual
  // tests override this to verify the operator pills follow whatever
  // SHIFT_*_START_HOUR the backend reports.
  shiftConfig: {
    timeZone: "Asia/Kolkata",
    startHours: { A: 6, B: 14, C: 22 },
  } as { timeZone: string; startHours: { A: number; B: number; C: number } } | undefined,
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
    useGetOperatorThresholds: () => ({
      data: mockState.operatorThresholds,
      isLoading: false,
    }),
    getGetOperatorThresholdsQueryKey: () => ["operator-thresholds"],
    // useShiftConfig() drives the shift pill labels (e.g. "6 AM – 2 PM").
    // Tests can override `mockState.shiftConfig` to assert that a non-IST
    // backend timezone/start-hours combination flows through to the UI.
    useGetShiftConfig: () => ({
      data: mockState.shiftConfig,
      isLoading: false,
    }),
    getGetShiftConfigQueryKey: () => ["shift-config"],
    // useFacilitySettingsChangeListener() polls /facility-settings to detect
    // mid-day shift-hour edits by a manager. Returning `undefined` exercises
    // the no-data-yet branch (no listener fire), which is the right baseline
    // for these tests — they don't simulate a settings edit.
    useGetFacilitySettings: () => ({ data: undefined, isLoading: false }),
    getGetFacilitySettingsQueryKey: () => ["facility-settings"],
    useCreateSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useReuploadSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // Auto-detect area runs when the operator picks media in the capture sheet
    // (added in task #83). The tests don't exercise the real network call, so
    // a real-shape resolved value is enough — but the hook must exist on the
    // mock or AreaCard crashes during render with "useIdentifySubmissionArea
    // is not defined".
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
      mutate: vi.fn(),
      mutateAsync: vi.fn(async () => undefined),
      isPending: false,
    }),
    useUndismissNudge: () => ({
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
import OperatorHome, { SuggestionRow, inferSuggestionSeverity } from "../operator";
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
  mockState.operatorThresholds = undefined;
  mockState.shiftConfig = {
    timeZone: "Asia/Kolkata",
    startHours: { A: 6, B: 14, C: 22 },
  };
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

  it("opens a fallback explanation + re-upload button when an operator taps a FALLBACK card", async () => {
    // The card is the breadcrumb; the dialog is where the operator gets the
    // "why did this happen + what now" answer. Without this, they'd be left
    // with only the badge and nowhere to actually fix the row from the strip.
    mockState.recent = [
      makeRecent({
        id: 77,
        areaId: 1,
        scoreTotal: 0,
        scoringMode: "FALLBACK",
      } as Partial<RecentSubmission>),
    ];
    mockState.statuses = [makeStatus({ areaId: 1 })];
    // useGetSubmission is invoked by RecentDetailDialog when it opens. Hand
    // it a submission stamped FALLBACK so the dialog renders its explanation
    // banner + re-upload action instead of pillar reasoning.
    mockState.submission = makeSubmission({
      id: 77,
      areaId: 1,
      scoreTotal: 0,
      scoringMode: "FALLBACK",
      suggestionsJson: ["Manual inspection required — AI scoring unavailable"],
      aiReasoningJson: null,
    } as Partial<Submission>);

    renderOperator();

    await userEvent.click(screen.getByTestId("recent-card-77"));

    expect(await screen.findByTestId("recent-detail-fallback-banner")).toBeInTheDocument();
    expect(screen.getByTestId("recent-detail-reupload-77")).toHaveTextContent(/Re-upload/i);
    // Pillar reasoning + the misleading 0% pill are suppressed in fallback
    // mode since neither is real data the operator should act on.
    expect(screen.queryByTestId("recent-pillar-reasoning")).not.toBeInTheDocument();
  });

  it("renders a 'Couldn't be scored' badge instead of '0%' for FALLBACK rows", () => {
    // The submit-time toast already calls FALLBACK out, but it's the only
    // signal — once the operator navigates away, the recent-strip card needs
    // to surface the same warning so they don't try to fix the area thinking
    // it really scored 0. The card replaces the percent pill with a
    // dedicated badge and suppresses the misleading trend line / inline
    // actions, both of which are derived from the meaningless score.
    mockState.recent = [
      makeRecent({
        id: 99,
        areaId: 1,
        scoreTotal: 0,
        scoringMode: "FALLBACK",
        prevScoreTotal: 18,
        // A real action would normally render inline; suppressed for FALLBACK
        // because it was generated from the no-op fallback recommendation set.
        topActions: ["Tidy bench"],
      } as Partial<RecentSubmission>),
    ];
    mockState.statuses = [makeStatus({ areaId: 1 })];

    renderOperator();

    const card = screen.getByTestId("recent-card-99");
    expect(within(card).getByTestId("recent-card-fallback-badge-99")).toHaveTextContent(/Couldn't be scored/i);
    // The misleading "0%" pill must NOT also render alongside the fallback
    // badge — the whole point of the badge is to replace the percent.
    expect(within(card).queryByText(/^0%$/)).not.toBeInTheDocument();
    // The trend line ("+/- pts vs last") is meaningless against a score the
    // AI never produced, so it's replaced with a re-upload nudge instead.
    expect(within(card).getByText(/Tap to re-upload/i)).toBeInTheDocument();
    expect(within(card).queryByText(/pts vs last/i)).not.toBeInTheDocument();
    // Inline action chips derived from the no-op fallback recommendation
    // shouldn't compete with the badge for the operator's attention.
    expect(
      within(card).queryByTestId("recent-card-actions-99"),
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

  it("uses each area's per-area dueSoon override when flagging 'due soon'", () => {
    // Two areas, both due in 90 minutes. Area 1 keeps the global 60-minute
    // lead → not flagged. Area 2 has a 120-minute per-area override →
    // should flag as "due soon" and sort ahead of area 1.
    mockState.statuses = [
      makeStatus({ areaId: 1, areaName: "AA Global Lead" }),
      makeStatus({ areaId: 2, areaName: "BB Tight Lead" }),
    ];
    const ninetyMinFromNow = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    mockState.nextChecks = [
      makeNextCheck({ areaId: 1, nextDueAt: ninetyMinFromNow }),
      makeNextCheck({ areaId: 2, nextDueAt: ninetyMinFromNow }),
    ];
    mockState.operatorThresholds = {
      encouragementMinPercent: 80,
      priorBestWindowDays: 7,
      dueSoonThresholdMinutes: 60,
      defaults: {
        encouragementMinPercent: 80,
        priorBestWindowDays: 7,
        dueSoonThresholdMinutes: 60,
      },
      envOverrides: {
        encouragementMinPercent: null,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      dbOverrides: {
        encouragementMinPercent: null,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      updatedAt: null,
      updatedByUserId: null,
      updatedByUserEmail: null,
      auditHistory: [],
      areaOverrides: [
        {
          areaId: 2,
          areaName: "BB Tight Lead",
          encouragementMinPercent: null,
          priorBestWindowDays: null,
          dueSoonThresholdMinutes: 120,
          updatedAt: null,
          updatedByUserId: null,
        },
      ],
    };

    renderOperator();

    // Area 2's tighter lead should flag it; area 1 stays out of the
    // due-soon bucket.
    expect(screen.getByTestId("pill-duesoon-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pill-duesoon-1")).not.toBeInTheDocument();

    // Sort order: due-soon (area 2) should come before the still-OK area 1.
    const headings = screen.getAllByRole("heading", { level: 3 });
    const headingTexts = headings.map((h) => h.textContent?.trim());
    expect(headingTexts).toEqual(["BB Tight Lead", "AA Global Lead"]);
  });

  it("falls back to the global dueSoon lead when the area has no override", () => {
    // One area, due in 30 minutes, with a per-area override only on a
    // *different* area. The global 60-minute lead should still flag this
    // area as "due soon".
    mockState.statuses = [makeStatus({ areaId: 5, areaName: "Bay 5" })];
    mockState.nextChecks = [
      makeNextCheck({
        areaId: 5,
        nextDueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    ];
    mockState.operatorThresholds = {
      encouragementMinPercent: 80,
      priorBestWindowDays: 7,
      dueSoonThresholdMinutes: 60,
      defaults: {
        encouragementMinPercent: 80,
        priorBestWindowDays: 7,
        dueSoonThresholdMinutes: 60,
      },
      envOverrides: {
        encouragementMinPercent: null,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      dbOverrides: {
        encouragementMinPercent: null,
        priorBestWindowDays: null,
        dueSoonThresholdMinutes: null,
      },
      updatedAt: null,
      updatedByUserId: null,
      updatedByUserEmail: null,
      auditHistory: [],
      areaOverrides: [
        {
          areaId: 99,
          areaName: "Other",
          encouragementMinPercent: null,
          priorBestWindowDays: null,
          dueSoonThresholdMinutes: 5,
          updatedAt: null,
          updatedByUserId: null,
        },
      ],
    };

    renderOperator();

    expect(screen.getByTestId("pill-duesoon-5")).toBeInTheDocument();
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

  it("renders shift pill hours from the backend /shift/config (not Vite build-time IST defaults)", () => {
    // Simulate a US East facility: backend reports America/New_York with
    // shifts starting at 7 AM / 3 PM / 11 PM. The pills should show those
    // hours, NOT the legacy 6/14/22 IST hardcodes. We deliberately leave
    // `statuses` empty so the test only exercises the pill row — the
    // assigned-areas section and AreaCard subtree have their own deps that
    // are out of scope for a shift-config regression check.
    mockState.shiftConfig = {
      timeZone: "America/New_York",
      startHours: { A: 7, B: 15, C: 23 },
    };
    mockState.statuses = [];

    renderOperator();

    // The active-shift view renders its three pills as <button role="tab">.
    // We resolve them by visible "Shift X" label so the assertion matches
    // the operator's mental model: each pill should display the backend
    // hours next to its letter.
    const tabs = screen.getAllByRole("tab");
    const tabA = tabs.find((t) => /Shift A/i.test(t.textContent ?? ""))!;
    const tabB = tabs.find((t) => /Shift B/i.test(t.textContent ?? ""))!;
    const tabC = tabs.find((t) => /Shift C/i.test(t.textContent ?? ""))!;
    expect(tabA).toHaveTextContent(/7\s*AM\s*[–-]\s*3\s*PM/i);
    expect(tabB).toHaveTextContent(/3\s*PM\s*[–-]\s*11\s*PM/i);
    expect(tabC).toHaveTextContent(/11\s*PM\s*[–-]\s*7\s*AM/i);

    // None of the legacy IST defaults should leak through.
    for (const tab of [tabA, tabB, tabC]) {
      expect(tab).not.toHaveTextContent(/6\s*AM/i);
      expect(tab).not.toHaveTextContent(/2\s*PM/i);
      expect(tab).not.toHaveTextContent(/10\s*PM/i);
    }
  });

  it("renders shift pill hours from the backend even on the unknown-shift fallback view", () => {
    // The unknown-shift view (used while the current-shift query is errored
    // or returned no data) renders its own pill row. It must also follow the
    // backend hours, not the legacy IST defaults.
    mockState.shiftError = true;
    mockState.shift = undefined;
    mockState.shiftConfig = {
      timeZone: "America/New_York",
      startHours: { A: 7, B: 15, C: 23 },
    };

    renderOperator();

    expect(screen.getByTestId("text-shift-error")).toBeInTheDocument();
    expect(screen.getByTestId("button-shift-A")).toHaveTextContent(
      /7\s*AM\s*[–-]\s*3\s*PM/i,
    );
    expect(screen.getByTestId("button-shift-B")).toHaveTextContent(
      /3\s*PM\s*[–-]\s*11\s*PM/i,
    );
    expect(screen.getByTestId("button-shift-C")).toHaveTextContent(
      /11\s*PM\s*[–-]\s*7\s*AM/i,
    );
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

describe("SuggestionRow — AI severity colour mapping", () => {
  // SuggestionRow is rendered as an <li>, so wrap it in a <ul> to keep React's
  // DOM nesting validator quiet.
  function renderRow(props: React.ComponentProps<typeof SuggestionRow>) {
    return render(
      <ul>
        <SuggestionRow {...props} />
      </ul>,
    );
  }

  it.each([
    ["high", "High"],
    ["medium", "Medium"],
    ["low", "Low"],
  ] as const)(
    "uses the AI-provided severity %s and labels the tooltip as 'AI severity: %s'",
    (sev, label) => {
      renderRow({ text: "Some action item text", index: 0, aiSeverity: sev });
      const row = screen.getByTestId("suggestion-row-0");
      expect(row).toHaveAttribute("data-severity", sev);
      expect(row).toHaveAttribute("data-severity-source", "ai");
      const pill = within(row).getByLabelText(`Severity: ${label}`);
      expect(pill).toHaveAttribute("title", `AI severity: ${label}`);
      expect(pill).toHaveTextContent(label);
    },
  );

  it("falls back to keyword inference for high-severity language when aiSeverity is missing", () => {
    renderRow({
      text: "Chemical spill on the line — clean up immediately",
      index: 2,
      aiSeverity: null,
    });
    const row = screen.getByTestId("suggestion-row-2");
    expect(row).toHaveAttribute("data-severity", "high");
    expect(row).toHaveAttribute("data-severity-source", "inferred");
    const pill = within(row).getByLabelText("Severity: High");
    expect(pill).toHaveAttribute("title", "Inferred severity: High");
  });

  it("falls back to keyword inference for medium-severity language when aiSeverity is undefined", () => {
    renderRow({
      text: "Missing label on the storage bin",
      index: 3,
      // Mirrors the production call site, which passes `?? null` when the
      // AI didn't attach a severity to this recommendation.
      aiSeverity: undefined,
    });
    const row = screen.getByTestId("suggestion-row-3");
    expect(row).toHaveAttribute("data-severity", "medium");
    expect(row).toHaveAttribute("data-severity-source", "inferred");
    const pill = within(row).getByLabelText("Severity: Medium");
    expect(pill).toHaveAttribute("title", "Inferred severity: Medium");
  });

  it("falls back to low severity for benign text when aiSeverity is missing", () => {
    renderRow({
      text: "Wipe down the workbench at end of shift",
      index: 4,
      aiSeverity: null,
    });
    const row = screen.getByTestId("suggestion-row-4");
    expect(row).toHaveAttribute("data-severity", "low");
    expect(row).toHaveAttribute("data-severity-source", "inferred");
    const pill = within(row).getByLabelText("Severity: Low");
    expect(pill).toHaveAttribute("title", "Inferred severity: Low");
  });

  it("prefers the AI-provided severity over what the inference would have returned", () => {
    // Text that would otherwise trip the high-severity keyword rule, but the
    // AI explicitly classified it as low — the AI must win and the tooltip
    // must reflect that source.
    renderRow({
      text: "Chemical spill kit was restocked — no action needed",
      index: 5,
      aiSeverity: "low",
    });
    const row = screen.getByTestId("suggestion-row-5");
    expect(row).toHaveAttribute("data-severity", "low");
    expect(row).toHaveAttribute("data-severity-source", "ai");
    const pill = within(row).getByLabelText("Severity: Low");
    expect(pill).toHaveAttribute("title", "AI severity: Low");
  });
});

describe("inferSuggestionSeverity — keyword rules", () => {
  it("returns 'high' for safety-critical wording", () => {
    expect(inferSuggestionSeverity("Chemical spill near mixer")).toBe("high");
    expect(inferSuggestionSeverity("Operator working without gloves")).toBe("high");
    expect(inferSuggestionSeverity("Stop the line — exposed wiring")).toBe("high");
  });

  it("returns 'medium' for housekeeping wording like missing labels", () => {
    expect(inferSuggestionSeverity("Missing label on the bin")).toBe("medium");
    expect(inferSuggestionSeverity("Signage is cracked")).toBe("medium");
  });

  it("returns 'low' for benign or empty text", () => {
    expect(inferSuggestionSeverity("Wipe down the bench")).toBe("low");
    expect(inferSuggestionSeverity("")).toBe("low");
  });
});
