/**
 * Mobile-layout regression for the per-area "Edit profile" form.
 *
 * Task #148 capped the editable profile grid to `max-h-[55vh]` and gave it
 * its own `overflow-y-auto`, so the Save / Cancel buttons render *outside*
 * the scroll region and stay reachable on a phone. Without that cap the
 * five textareas (summary + four chip lists) pushed the Save button below
 * the visible viewport on a 375px-tall phone — managers thought the form
 * had no save action at all.
 *
 * These tests render the Areas page, expand a card into edit mode, and
 * assert:
 *   1. The scroll-capped textarea container exists and uses
 *      `max-h-[55vh] overflow-y-auto` on phones, expanding back to full
 *      height (`sm:max-h-none sm:overflow-visible`) on tablet+.
 *   2. The Save button is rendered as a sibling *outside* the scroll
 *      container, so it's always pinned beneath the scrollable form.
 *   3. The Cancel button lives next to Save (still outside the scroll
 *      container), so neither action gets buried in the form scroll.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@workspace/api-client-react", () => {
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
    useListAreas: noopQuery([
      {
        id: 7,
        name: "Packing Floor",
        environmentType: "factory",
      },
    ]),
    useCreateArea: noopMutation,
    useUpdateArea: noopMutation,
    useDeleteArea: noopMutation,
    useGetAreaProfile: noopQuery({
      status: "TRAINED",
      summary: "Existing summary",
      items: ["Cart"],
      machines: ["Mixer"],
      layout: ["South wall"],
      commonIssues: ["Spills"],
      submissionsCount: 8,
      targetSubmissions: 5,
      updatedAt: new Date().toISOString(),
    }),
    useResetAreaProfile: noopMutation,
    useUpdateAreaProfile: noopMutation,
    useListOperators: noopQuery([]),
    useGetAreaAssignments: noopQuery([]),
    useSetAreaAssignments: noopMutation,
    getListAreasQueryKey: () => ["areas"],
    getGetAreaProfileQueryKey: (id: number) => ["area-profile", id],
    getGetAreaAssignmentsQueryKey: (id: number) => ["area-assignments", id],
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

import Areas from "@/pages/areas";

const AREA_ID = 7;

function withQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

async function enterEditMode() {
  const editButton = await screen.findByTestId(`button-edit-profile-${AREA_ID}`);
  await userEvent.click(editButton);
}

describe("Areas — profile edit form mobile layout (320–375px)", () => {
  beforeEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
  });

  test("textarea grid is scroll-capped on phones and expands at the sm breakpoint", async () => {
    render(withQuery(<Areas />));
    await enterEditMode();

    const scroll = await screen.findByTestId(`profile-edit-scroll-${AREA_ID}`);
    const classes = scroll.className.split(/\s+/);
    // Phone: capped height + own scroll.
    expect(classes).toContain("max-h-[55vh]");
    expect(classes).toContain("overflow-y-auto");
    // Tablet+: relax both so the Save button sits naturally at the bottom.
    expect(classes).toContain("sm:max-h-none");
    expect(classes).toContain("sm:overflow-visible");
  });

  test("Save button renders OUTSIDE the scroll region so it stays reachable", async () => {
    render(withQuery(<Areas />));
    await enterEditMode();

    const scroll = await screen.findByTestId(`profile-edit-scroll-${AREA_ID}`);
    const saveButton = await screen.findByTestId(
      `button-save-profile-${AREA_ID}`,
    );

    // The Save button must NOT be a descendant of the scroll container,
    // otherwise it scrolls away with the textareas on phones.
    expect(scroll.contains(saveButton)).toBe(false);
    // Sanity: in DOM order Save is rendered AFTER the scroll container so
    // it visually sits under the form on every viewport.
    expect(
      scroll.compareDocumentPosition(saveButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("Cancel sits next to Save outside the scroll region too", async () => {
    render(withQuery(<Areas />));
    await enterEditMode();

    const scroll = await screen.findByTestId(`profile-edit-scroll-${AREA_ID}`);
    const saveButton = await screen.findByTestId(
      `button-save-profile-${AREA_ID}`,
    );
    const actionRow = saveButton.parentElement as HTMLElement | null;
    expect(actionRow).not.toBeNull();

    // Cancel is a sibling of Save and shares the same action row.
    const cancelButton = within(actionRow!).getByRole("button", {
      name: /^Cancel$/,
    });
    expect(cancelButton).toBeInTheDocument();
    expect(scroll.contains(cancelButton)).toBe(false);
  });
});
