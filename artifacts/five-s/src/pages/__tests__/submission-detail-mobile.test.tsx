/**
 * Mobile-layout regression for the submission detail modal.
 *
 * Task #148 reordered the mobile rendering of the submission detail modal
 * so managers see Score Breakdown and AI Issues *before* the keyframe strip
 * — without that fix, on a phone the right column scrolled past 4–8
 * keyframe thumbnails before reaching the actual score the manager came to
 * review. The desktop layout is unaffected (keyframes live in the left
 * column there).
 *
 * These tests render the Submissions page, click a submission row to open
 * the detail dialog, and assert that:
 *   1. Both the score-breakdown section and the mobile keyframe strip
 *      render inside the dialog.
 *   2. In the document-flow order, Score Breakdown comes before the
 *      mobile keyframe strip.
 *   3. The same goes for the AI Issues section vs the mobile keyframe
 *      strip — managers reach findings before scrolling past frames.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

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
    get: (_t, prop: string) => make(prop),
  });
  const AnimatePresence = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return { motion: motionProxy, AnimatePresence };
});

vi.mock("@workspace/api-client-react", () => {
  // Fixtures live INSIDE the factory because vi.mock() is hoisted above
  // any top-level `const` declarations in the test file — referencing an
  // outer fixture from here triggers a TDZ error at module-evaluation time.
  const submission = {
    id: 42,
    areaId: 1,
    areaName: "Packing Floor",
    userId: 1,
    userEmail: "op@5s.test",
    shift: "A" as const,
    scoreTotal: 18,
    scoreJson: { sort: 4, set: 4, shine: 3, standardize: 4, sustain: 3 },
    suggestionsJson: ["Tidy bench"],
    imageUrl: "/uploads/walk.mp4",
    mediaType: "video" as const,
    // Three keyframes — large enough to push the score below the fold if
    // the mobile reorder ever regresses.
    keyframesJson: [
      "/uploads/walk-frame-1.jpg",
      "/uploads/walk-frame-2.jpg",
      "/uploads/walk-frame-3.jpg",
    ],
    machineTag: null,
    failingPillarsJson: [],
    scoringMode: "ai",
    modelVersion: "test-model",
    aiReasoningJson: null,
    aiIssuesJson: [
      {
        issue: "Tools left out",
        evidence: "Two wrenches on the bench.",
        location: "Bench A",
        pillar: "set",
        principle: "A place for everything",
      },
    ],
    aiRecommendationsJson: [],
    createdAt: new Date().toISOString(),
  };
  const row = {
    id: submission.id,
    areaId: submission.areaId,
    areaName: submission.areaName,
    userEmail: submission.userEmail,
    shift: submission.shift,
    scoreTotal: submission.scoreTotal,
    mediaType: submission.mediaType,
    imageUrl: submission.imageUrl,
    keyframesJson: submission.keyframesJson,
    machineTag: submission.machineTag,
    scoringMode: submission.scoringMode,
    failingPillarsJson: submission.failingPillarsJson,
    createdAt: submission.createdAt,
    openEscalationId: null,
  };
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
    useListSubmissions: noopQuery([row]),
    useGetSubmission: noopQuery(submission),
    useGetAreaModelStatus: noopQuery(undefined),
    useListAreas: noopQuery([
      {
        id: submission.areaId,
        name: submission.areaName,
        environmentType: "factory",
      },
    ]),
    useGetLabels: noopQuery([]),
    useCreateLabel: noopMutation,
    useQuickApproveLabel: noopMutation,
    useResolveEscalation: noopMutation,
    useReuploadSubmission: noopMutation,
    useDeleteSubmission: noopMutation,
    getGetAreaModelStatusQueryKey: (id: number) => ["area-model-status", id],
    getListSubmissionsQueryKey: () => ["submissions"],
    getGetSubmissionQueryKey: (id: number) => ["submission", id],
    getGetLabelsQueryKey: (id: number) => ["labels", id],
    getListEscalationsQueryKey: () => ["escalations"],
    getGetEscalationCountQueryKey: () => ["escalation-count"],
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "manager@5s.test", role: "MANAGER" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

import Submissions from "@/pages/submissions";

function withQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("SubmissionDetail modal — mobile section order (320–375px)", () => {
  beforeEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
  });

  test("Score Breakdown renders before the mobile keyframe strip in DOM order", async () => {
    render(withQuery(<Submissions />));

    // Click the mobile card for the fixture submission. The page renders
    // both the mobile <li> and the desktop <tr> in jsdom (CSS hidden), so we
    // target by stable testid rather than by visible text.
    const card = await screen.findByTestId("card-submission-42");
    // First button is the row-open trigger; subsequent buttons are the
    // Approve / Needs work manager actions inside the same card.
    const trigger = within(card).getAllByRole("button")[0];
    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const score = within(dialog).getByTestId("submission-score-section");
    const keyframesMobile = within(dialog).getByTestId(
      "submission-keyframes-mobile",
    );

    expect(score).toBeInTheDocument();
    expect(keyframesMobile).toBeInTheDocument();
    // DOCUMENT_POSITION_FOLLOWING (0x04) means `score` comes before
    // `keyframesMobile` in the document. If the order ever flips back to
    // keyframes-first on mobile, this assertion fails.
    expect(
      score.compareDocumentPosition(keyframesMobile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("AI Issues section also renders before the mobile keyframe strip", async () => {
    render(withQuery(<Submissions />));

    const card = await screen.findByTestId("card-submission-42");
    const trigger = within(card).getAllByRole("button")[0];
    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const aiIssues = within(dialog).getByTestId("submission-ai-issues-section");
    const keyframesMobile = within(dialog).getByTestId(
      "submission-keyframes-mobile",
    );

    expect(aiIssues).toBeInTheDocument();
    expect(keyframesMobile).toBeInTheDocument();
    expect(
      aiIssues.compareDocumentPosition(keyframesMobile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("the mobile keyframe strip is `md:hidden` so desktop only sees the left-column copy", async () => {
    render(withQuery(<Submissions />));

    const card = await screen.findByTestId("card-submission-42");
    const trigger = within(card).getAllByRole("button")[0];
    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const keyframesMobile = within(dialog).getByTestId(
      "submission-keyframes-mobile",
    );
    expect(keyframesMobile.className).toMatch(/\bmd:hidden\b/);
  });
});
