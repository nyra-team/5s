/**
 * Locks in the contract of `useFacilitySettingsChangeListener`: the operator
 * page leans on it to pop a "shift hours just updated" toast when a manager
 * retunes the schedule mid-shift, so the change-detection rules need to be
 * surgical:
 *
 *   - Don't fire on the first settled response (avoids spurious toasts on a
 *     fresh page load when no baseline existed yet).
 *   - Don't fire when the polled response repeats the same effective values.
 *   - Fire when any of timeZone / shiftA/B/C start hours / updatedAt changes.
 *   - Always pass the latest callback (handle inline arrow re-renders without
 *     dropping the ref).
 *
 * We mock `useGetFacilitySettings` so the test owns the polled data without
 * spinning up the React Query refetch loop.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { FacilitySettings } from "@workspace/api-client-react";

const fakeData: { value: FacilitySettings | undefined } = { value: undefined };

vi.mock("@workspace/api-client-react", () => ({
  useGetFacilitySettings: () => ({ data: fakeData.value, isLoading: false }),
  getGetFacilitySettingsQueryKey: () => ["facility-settings"],
}));

import { useFacilitySettingsChangeListener } from "../facility-settings";

function makeSettings(overrides: Partial<FacilitySettings> = {}): FacilitySettings {
  return {
    timeZone: "Asia/Kolkata",
    shiftAStartHour: 6,
    shiftBStartHour: 14,
    shiftCStartHour: 22,
    defaults: {
      timeZone: "Asia/Kolkata",
      shiftAStartHour: 6,
      shiftBStartHour: 14,
      shiftCStartHour: 22,
    },
    envOverrides: {
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
    },
    dbOverrides: {
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
    },
    updatedAt: null,
    updatedByUserId: null,
    ...overrides,
  };
}

beforeEach(() => {
  fakeData.value = undefined;
});

describe("useFacilitySettingsChangeListener", () => {
  test("never fires on the first settled response (treats it as the baseline)", () => {
    const onChange = vi.fn();
    fakeData.value = makeSettings();
    renderHook(() => useFacilitySettingsChangeListener(onChange));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("does not fire when polled values repeat (effective hours unchanged)", () => {
    const onChange = vi.fn();
    fakeData.value = makeSettings();
    const { rerender } = renderHook(() =>
      useFacilitySettingsChangeListener(onChange),
    );
    // Simulate a refetch returning a fresh object reference but the same values.
    fakeData.value = makeSettings();
    rerender();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("fires once with prev/next when a shift hour shifts", () => {
    const onChange = vi.fn();
    fakeData.value = makeSettings({ shiftAStartHour: 6 });
    const { rerender } = renderHook(() =>
      useFacilitySettingsChangeListener(onChange),
    );
    fakeData.value = makeSettings({ shiftAStartHour: 7 });
    rerender();
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next, prev] = onChange.mock.calls[0];
    expect(prev.shiftAStartHour).toBe(6);
    expect(next.shiftAStartHour).toBe(7);
  });

  test("fires when only the updatedAt stamp moves (manager re-saved same values)", () => {
    const onChange = vi.fn();
    fakeData.value = makeSettings({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const { rerender } = renderHook(() =>
      useFacilitySettingsChangeListener(onChange),
    );
    fakeData.value = makeSettings({ updatedAt: "2026-01-01T00:05:00.000Z" });
    rerender();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("fires when the timezone changes even if the hours stay put", () => {
    const onChange = vi.fn();
    fakeData.value = makeSettings({ timeZone: "Asia/Kolkata" });
    const { rerender } = renderHook(() =>
      useFacilitySettingsChangeListener(onChange),
    );
    fakeData.value = makeSettings({ timeZone: "America/New_York" });
    rerender();
    expect(onChange).toHaveBeenCalledTimes(1);
    const [next] = onChange.mock.calls[0];
    expect(next.timeZone).toBe("America/New_York");
  });

  test("uses the latest callback when the parent re-renders with a new closure", () => {
    const first = vi.fn();
    const second = vi.fn();
    fakeData.value = makeSettings({ shiftAStartHour: 6 });
    const { rerender } = renderHook(
      ({ cb }: { cb: (n: unknown, p: unknown) => void }) =>
        useFacilitySettingsChangeListener(cb),
      { initialProps: { cb: first } },
    );
    rerender({ cb: second });
    fakeData.value = makeSettings({ shiftAStartHour: 7 });
    rerender({ cb: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
