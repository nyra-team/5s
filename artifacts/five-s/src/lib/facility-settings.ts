/**
 * Frontend wrapper around `/facility-settings`. The "Auto" theme uses this
 * to read the same DB-backed shift schedule the backend reads from, so a
 * manager re-tuning shift hours through the settings page also re-shapes
 * the operator UI's day/night theme without a redeploy.
 *
 * Falls back to the legacy 22:00–06:00 Asia/Kolkata window when the API
 * isn't reachable yet — the same defaults the build-time
 * `VITE_NIGHT_SHIFT_*` env vars used to provide.
 */
import { useEffect, useRef } from "react";
import {
  useGetFacilitySettings,
  getGetFacilitySettingsQueryKey,
  type FacilitySettings,
} from "@workspace/api-client-react";
import type { NightShiftWindow } from "@/lib/theme";

export const DEFAULT_NIGHT_SHIFT_WINDOW: NightShiftWindow = {
  startHour: 22,
  endHour: 6,
  timeZone: "Asia/Kolkata",
};

/**
 * React hook returning the night-shift window derived from the facility's
 * shift schedule. Night = `[shiftCStartHour, shiftAStartHour)` in the
 * configured timezone, matching how the API splits shifts.
 *
 * Slow-poll (60s) so a manager edit lands without a hard refresh, and
 * `staleTime` of 30s keeps the most recent value cached across screen
 * mounts. This endpoint is unauthenticated by design (operational metadata,
 * no PII), so it works on the login screen too where the ThemeProvider
 * lives above the AuthProvider.
 */
export function useNightShiftWindow(): NightShiftWindow {
  const { data } = useGetFacilitySettings({
    query: {
      refetchInterval: 60_000,
      staleTime: 30_000,
      queryKey: getGetFacilitySettingsQueryKey(),
    },
  });
  if (!data) return DEFAULT_NIGHT_SHIFT_WINDOW;
  return {
    startHour: data.shiftCStartHour,
    endHour: data.shiftAStartHour,
    timeZone: data.timeZone,
  };
}

/**
 * Snapshot of the operator-visible facility schedule. We compare these four
 * fields between polls to decide whether a manager just retuned shift hours.
 * `updatedAt` alone isn't enough: env-var or default changes can move the
 * effective hours without touching the DB row, so we watch the merged
 * effective values too.
 */
export interface FacilityScheduleSnapshot {
  timeZone: string;
  shiftAStartHour: number;
  shiftBStartHour: number;
  shiftCStartHour: number;
  updatedAt: string | null;
}

function snapshotOf(data: FacilitySettings): FacilityScheduleSnapshot {
  return {
    timeZone: data.timeZone,
    shiftAStartHour: data.shiftAStartHour,
    shiftBStartHour: data.shiftBStartHour,
    shiftCStartHour: data.shiftCStartHour,
    updatedAt: data.updatedAt ?? null,
  };
}

function snapshotsEqual(
  a: FacilityScheduleSnapshot,
  b: FacilityScheduleSnapshot,
): boolean {
  return (
    a.timeZone === b.timeZone &&
    a.shiftAStartHour === b.shiftAStartHour &&
    a.shiftBStartHour === b.shiftBStartHour &&
    a.shiftCStartHour === b.shiftCStartHour &&
    a.updatedAt === b.updatedAt
  );
}

/**
 * Polls `/facility-settings` (sharing the cache + 60s refetch with
 * `useNightShiftWindow`) and invokes `onChange` whenever the operator-visible
 * schedule actually moves between two successful fetches. The first
 * settled response is the baseline — we never fire on it, so a fresh page
 * load doesn't pop a "shift hours changed" toast at the operator just
 * because nothing was previously loaded.
 *
 * The callback is held in a ref so callers can pass an inline arrow without
 * triggering re-fires every render.
 */
export function useFacilitySettingsChangeListener(
  onChange: (
    next: FacilityScheduleSnapshot,
    prev: FacilityScheduleSnapshot,
  ) => void,
): void {
  const { data } = useGetFacilitySettings({
    query: {
      refetchInterval: 60_000,
      staleTime: 30_000,
      queryKey: getGetFacilitySettingsQueryKey(),
    },
  });

  const cbRef = useRef(onChange);
  useEffect(() => {
    cbRef.current = onChange;
  }, [onChange]);

  const seenRef = useRef<FacilityScheduleSnapshot | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = snapshotOf(data);
    const prev = seenRef.current;
    seenRef.current = next;
    if (prev === null) return; // baseline — don't notify on first load
    if (snapshotsEqual(prev, next)) return;
    cbRef.current(next, prev);
  }, [data]);
}
