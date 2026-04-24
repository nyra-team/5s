/**
 * Regression test for task #131: dragging a pillar slider in the manager
 * label form must not close the surrounding submission detail dialog.
 *
 * Why this matters:
 *   The label form lived inside a Radix Dialog, with sliders rendered as
 *   plain <input type="range">. When a manager dragged the thumb hard
 *   enough that the pointer / focus left the Dialog content, the Radix
 *   dismissable layer fired its outside listener and closed the dialog —
 *   wiping the in-progress label and the AI reasoning the manager was
 *   reading.
 *
 *   The fix swaps the native input for a Radix Slider primitive. Radix
 *   sets pointer capture on the thumb at pointerdown, so subsequent
 *   pointer events are routed back to the thumb (still inside the dialog
 *   subtree) instead of leaking to the document. That keeps Radix
 *   Dialog's `onPointerDownOutside` from firing.
 *
 * These tests assert:
 *   1. The pillar sliders are Radix sliders (role="slider" on a non-input
 *      element), so a future revert to <input type="range"> fails loudly.
 *   2. A drag-style pointer sequence that would previously have escaped
 *      the dialog (pointerdown on thumb, pointermove + pointerup on the
 *      document body) does not trigger Dialog onOpenChange(false).
 *   3. Pointerdown events that genuinely originate outside the dialog
 *      still close it, so we haven't broken the normal dismiss path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("framer-motion", async () => {
  const ReactNs = await import("react");
  type AnyProps = Record<string, unknown> & { children?: React.ReactNode };
  const strip = (props: AnyProps) => {
    const {
      initial: _i, animate: _a, exit: _e, transition: _t, layout: _l,
      layoutId: _lid, whileHover: _wh, whileTap: _wt, whileFocus: _wf,
      whileInView: _wi, variants: _v, drag: _d, ...rest
    } = props;
    return rest;
  };
  const make = (tag: string) =>
    ReactNs.forwardRef<HTMLElement, AnyProps>(function MotionTag(props, ref) {
      const cleaned = strip(props);
      return ReactNs.createElement(tag, { ...cleaned, ref }, (cleaned as { children?: React.ReactNode }).children);
    });
  const motionProxy = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => make(prop),
  });
  const AnimatePresence = ({ children }: { children: React.ReactNode }) =>
    ReactNs.createElement(ReactNs.Fragment, null, children);
  return { motion: motionProxy, AnimatePresence };
});

const createLabelMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useCreateLabel: () => ({
    mutate: createLabelMutate,
    isPending: false,
    isSuccess: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "manager@test.local", role: "MANAGER" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { LabelForm } from "../submissions";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

function renderInDialog(onOpenChange: (open: boolean) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          {/* Title + description silence Radix's a11y warnings without
              affecting the slider/dismiss behavior under test. */}
          <DialogTitle className="sr-only">Submission detail</DialogTitle>
          <DialogDescription className="sr-only">
            Manager label form
          </DialogDescription>
          <LabelForm submissionId={42} />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createLabelMutate.mockReset();
});

describe("LabelForm pillar sliders inside Dialog (task #131)", () => {
  it("renders Radix sliders rather than native <input type=\"range\">", () => {
    renderInDialog(vi.fn());

    const sliders = screen.getAllByRole("slider");
    // Five 5S pillars → five sliders.
    expect(sliders).toHaveLength(5);
    // Radix Slider's thumb is a <span>, not an <input>. If someone reverts
    // to a native range input, this assertion fails — which is the whole
    // point of this regression: the native input is what allowed the
    // dialog to dismiss mid-drag.
    sliders.forEach((s) => {
      expect(s.tagName).not.toBe("INPUT");
    });
    // Each pillar still has its data-testid handle for other tests.
    for (const key of ["sort", "set", "shine", "standardize", "sustain"]) {
      expect(screen.getByTestId(`label-pillar-slider-${key}`)).toBeInTheDocument();
    }
  });

  it("keeps the dialog open when a pointerdown originates on a slider thumb", () => {
    const onOpenChange = vi.fn();
    renderInDialog(onOpenChange);

    // Radix DismissableLayer attaches its document pointerdown listener
    // inside a setTimeout(0) — flush it before firing the drag.
    act(() => {
      vi.useFakeTimers();
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
    });

    const thumb = screen.getAllByRole("slider")[0];

    // A drag that would previously leak out of the dialog: pointerdown
    // on the thumb, then pointermove + pointerup on document.body. With
    // pointer capture wired up by Radix Slider, no pointerdown fires
    // outside the dialog content, so DismissableLayer's outside handler
    // never runs and onOpenChange(false) is never invoked.
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 4000, clientY: 4000 });
    fireEvent.pointerUp(document.body, { pointerId: 1, clientX: 4000, clientY: 4000 });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still dismisses the dialog when a pointerdown genuinely lands outside it", () => {
    const onOpenChange = vi.fn();
    renderInDialog(onOpenChange);

    // The dismissable layer registers its document listener via
    // setTimeout(0); wait one tick of the macrotask queue before
    // dispatching the outside event.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        fireEvent.pointerDown(document.body, {
          pointerId: 1,
          button: 0,
          clientX: 4000,
          clientY: 4000,
        });
        // Sanity check: the normal outside-click path is intact, so the
        // earlier "stays open" assertion isn't a false positive caused
        // by the listener never running.
        expect(onOpenChange).toHaveBeenCalledWith(false);
        resolve();
      }, 1);
    });
  });
});
