import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useMinuteTick, subscribeMinuteTick } from "../use-minute-tick";

function ProbeWithHook({
  onRender,
}: {
  onRender: () => void;
}) {
  useMinuteTick();
  onRender();
  return null;
}

describe("useMinuteTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-renders the subscriber once per minute", () => {
    const onRender = vi.fn();
    render(<ProbeWithHook onRender={onRender} />);
    expect(onRender).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onRender).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onRender).toHaveBeenCalledTimes(3);
  });

  it("shares a single interval across multiple subscribers and tears it down on the last unsubscribe", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeMinuteTick(a);
    const unsubB = subscribeMinuteTick(b);

    // Both subscribers share one underlying timer.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // First unsubscribe must NOT clear the interval — the other listener
    // still depends on it.
    unsubA();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    // When the last listener unsubscribes the shared interval is cleared.
    unsubB();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
