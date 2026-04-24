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
import {
  useGetFacilitySettings,
  getGetFacilitySettingsQueryKey,
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
