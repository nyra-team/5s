/**
 * Mobile-layout regression for the global manager <Layout> shell.
 *
 * Task #148 made the manager nav tabs horizontally scrollable so all eight
 * tabs (Live shift, Dashboard, Submissions, Areas, Escalations,
 * Notifications, Thresholds, Shifts) remain reachable on a 375px-wide phone
 * screen. Without this guard a future refactor — for example dropping
 * `overflow-x-auto`, switching the nav to `flex-wrap`, or hiding tabs behind
 * a `hidden md:flex` toggle — could silently bury tabs off-screen on phones.
 *
 * These tests assert:
 *   1. Every manager tab is rendered as a link with the correct href.
 *   2. The nav lives inside a horizontally scrollable container so phones
 *      can pan past the visible viewport to reach the trailing tabs.
 *   3. The nav itself is laid out as a single non-wrapping row (no
 *      `flex-wrap`), which is what makes horizontal scrolling meaningful
 *      instead of letting the tabs collapse onto a second line.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

vi.mock("@workspace/api-client-react", () => ({
  useGetEscalationCount: () => ({ data: { open: 3 }, isLoading: false }),
  useGetMyNotificationPreferences: () => ({
    data: {
      quietHoursEnabled: false,
      quietHoursActive: false,
      quietHoursActiveUntil: null,
      quietHoursNextStart: null,
    },
    isLoading: false,
  }),
  useGetShiftConfig: () => ({
    data: { timeZone: "Asia/Kolkata", startHours: { A: 6, B: 14, C: 22 } },
    isLoading: false,
  }),
  getGetShiftConfigQueryKey: () => ["shift-config"],
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, email: "manager@5s.test", role: "MANAGER" },
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => null,
}));

import { Layout } from "@/components/layout";

function withQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const EXPECTED_TABS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Live shift", href: "/live" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "Submissions", href: "/submissions" },
  { label: "Areas", href: "/areas" },
  { label: "Escalations", href: "/escalations" },
  { label: "Notifications", href: "/notifications" },
  { label: "Thresholds", href: "/operator-thresholds" },
  { label: "Shifts", href: "/facility-settings" },
];

describe("Layout — mobile manager nav (375px regression)", () => {
  beforeEach(() => {
    cleanup();
    // Simulate an iPhone-sized phone viewport. The actual layout collapse
    // happens via Tailwind classes (no JS reads this), but pinning the
    // viewport documents intent and protects against future window-size
    // assertions added to the component.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
  });

  test("renders every manager nav tab with the correct destination href", () => {
    render(withQuery(<Layout>page body</Layout>));

    const nav = screen.getByTestId("nav-manager-tabs");
    for (const { label, href } of EXPECTED_TABS) {
      const link = screen.getByRole("link", { name: new RegExp(label, "i") });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", href);
      // Each tab also lives inside the manager nav (not somewhere else in
      // the page) so a future refactor that splits the nav can't
      // accidentally satisfy this assertion by exposing duplicate links.
      expect(nav).toContainElement(link);
    }
  });

  test("the nav scroll container is horizontally scrollable on mobile", () => {
    render(withQuery(<Layout>page body</Layout>));

    const scroll = screen.getByTestId("nav-manager-scroll");
    expect(scroll.className).toMatch(/\boverflow-x-auto\b/);
    // The nav itself must remain a single non-wrapping row so horizontal
    // scrolling actually reveals the trailing tabs instead of stacking.
    const nav = screen.getByTestId("nav-manager-tabs");
    expect(nav.className).not.toMatch(/\bflex-wrap\b/);
    // Sanity: the nav lives inside the scroll container.
    expect(scroll).toContainElement(nav);
  });
});
