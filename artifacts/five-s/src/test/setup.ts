import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    // ignore quota / privacy mode
  }
});

// jsdom does not implement matchMedia; framer-motion's reduced-motion check
// and several Radix components touch it during render.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom lacks ResizeObserver and IntersectionObserver, both used by Radix.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (typeof window !== "undefined") {
  if (!(window as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
    (window as unknown as { ResizeObserver: typeof NoopObserver }).ResizeObserver =
      NoopObserver;
  }
  if (!(window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver) {
    (window as unknown as { IntersectionObserver: typeof NoopObserver }).IntersectionObserver =
      NoopObserver;
  }
}

// jsdom doesn't implement scrollIntoView, which Radix Select / Sheet may call.
if (
  typeof window !== "undefined" &&
  !(window.HTMLElement.prototype as unknown as { scrollIntoView?: unknown })
    .scrollIntoView
) {
  window.HTMLElement.prototype.scrollIntoView = function noop() {};
}

if (typeof window !== "undefined" && !window.URL.createObjectURL) {
  window.URL.createObjectURL = () => "blob:mock";
  window.URL.revokeObjectURL = () => {};
}

// jsdom doesn't implement the pointer capture APIs that Radix primitives
// (Toast, Select, Slider, etc.) call on pointer events. Without these stubs
// any Radix component that wires pointer handlers throws unhandled
// "target.hasPointerCapture is not a function" errors during interaction —
// notably the manager-label Slider drag flow exercised by task #131's tests.
if (typeof window !== "undefined") {
  const proto = window.HTMLElement.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
}
