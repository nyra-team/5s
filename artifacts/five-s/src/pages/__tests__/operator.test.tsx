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
  shift: { shift: "A" } as { shift: "A" | "B" | "C" },
  profile: undefined as unknown,
  nudges: [] as unknown[],
  submission: undefined as unknown,
};

vi.mock("@workspace/api-client-react", () => {
  const stub = (key: keyof typeof mockState) => () => ({
    data: mockState[key],
    isLoading: false,
  });
  return {
    useGetCurrentShift: stub("shift"),
    useGetOperatorStatus: stub("statuses"),
    useGetNextChecks: stub("nextChecks"),
    useGetOperatorRecent: stub("recent"),
    useGetActiveNudges: stub("nudges"),
    useGetAreaProfile: stub("profile"),
    useGetSubmission: stub("submission"),
    useCreateSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useReuploadSubmission: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    getGetCurrentShiftQueryKey: () => ["shift"],
    getGetOperatorStatusQueryKey: () => ["status"],
    getGetNextChecksQueryKey: () => ["next-checks"],
    getGetOperatorRecentQueryKey: () => ["recent"],
    getGetActiveNudgesQueryKey: () => ["nudges"],
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
import type {
  AreaStatus,
  NextCheck,
  RecentSubmission,
  Submission,
} from "@workspace/api-client-react";

const RECENT_STRIP_PREF_KEY = "operator.recentStrip.collapsed";

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
  mockState.profile = undefined;
  mockState.nudges = [];
  mockState.submission = undefined;
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
  it("renders 'New best this week' when score ≥80% AND beats prior week best", () => {
    // scoreTotal 22 → 88%; beats bestScoreInLastWeek 18 (72%).
    const submission = makeSubmission({ id: 555, areaId: 7, scoreTotal: 22 });
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
        scoreTotal: 22,
        prevScoreTotal: 18,
        bestScoreInLastWeek: 18,
      }),
    ];

    renderOperator();
    const chip = screen.getByTestId(`chip-encouragement-${submission.id}`);
    expect(chip).toHaveTextContent(/New best this week/);
  });

  it("does NOT render the chip when score is below 80% even if it beats the prior best", () => {
    // scoreTotal 19 → 76%, below the 80% threshold.
    const submission = makeSubmission({ id: 556, areaId: 8, scoreTotal: 19 });
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
        scoreTotal: 19,
        prevScoreTotal: 10,
        bestScoreInLastWeek: 10,
      }),
    ];

    renderOperator();
    expect(
      screen.queryByTestId(`chip-encouragement-${submission.id}`),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the chip when the score does not beat prior week best", () => {
    // scoreTotal 22 (88%) but bestScoreInLastWeek already 23 — should suppress.
    const submission = makeSubmission({ id: 557, areaId: 9, scoreTotal: 22 });
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
        scoreTotal: 22,
        prevScoreTotal: 22,
        bestScoreInLastWeek: 23,
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
});
