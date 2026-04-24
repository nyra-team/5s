import { useMemo } from "react";
import {
  useGetShiftConfig,
  getGetShiftConfigQueryKey,
  type ShiftConfig,
} from "@workspace/api-client-react";

const FALLBACK_CONFIG: ShiftConfig = {
  timeZone: "Asia/Kolkata",
  startHours: { A: 6, B: 14, C: 22 },
};

export interface ShiftLabelEntry {
  value: "A" | "B" | "C";
  /** "Shift A" / "Shift B" / "Shift C" */
  label: string;
  /** "6 AM – 2 PM" style range computed from backend start hours. */
  time: string;
}

export interface ShiftConfigBundle {
  /** Live config when loaded; falls back to the legacy IST defaults so the UI
   *  is never blank for a single render while the request is in flight. */
  config: ShiftConfig;
  /** True only when we're rendering with the fallback (no server data yet). */
  isFallback: boolean;
  /** Short timezone label suitable for display next to a time, e.g. "EDT". */
  tzLabel: string;
  /** Three "Shift A/B/C" pills with hours derived from backend start hours. */
  shiftLabels: ShiftLabelEntry[];
  /** Format an instant as a clock time in the configured shift timezone. */
  formatClockTime: (d: Date) => string;
  /** Format an instant as "MMM d, h:mm a" in the configured shift timezone. */
  formatDayTime: (d: Date) => string;
}

function formatHour12(hour24: number): string {
  const h = ((Math.trunc(hour24) % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

/**
 * Build the three shift pills from the backend's configured start hours so
 * the operator switcher shows the same hours the server uses to bucket
 * submissions. Shift C wraps across midnight up to the next day's A start.
 */
function buildShiftLabels(startHours: ShiftConfig["startHours"]): ShiftLabelEntry[] {
  const { A, B, C } = startHours;
  return [
    { value: "A", label: "Shift A", time: `${formatHour12(A)} – ${formatHour12(B)}` },
    { value: "B", label: "Shift B", time: `${formatHour12(B)} – ${formatHour12(C)}` },
    { value: "C", label: "Shift C", time: `${formatHour12(C)} – ${formatHour12(A)}` },
  ];
}

/**
 * Compute a short timezone abbreviation (e.g. "IST", "EDT", "PST") for the
 * given IANA timezone using the runtime's Intl data. Falls back to the IANA
 * id when the platform can't produce a short name.
 */
function shortTzLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === "timeZoneName")?.value;
    if (tzPart && tzPart.length > 0) return tzPart;
  } catch {
    // Unknown zone — fall through.
  }
  return timeZone;
}

/**
 * Hook for accessing the facility's shift timezone + start hours. Centralises
 * the React Query call so every "IST" label in the UI can be replaced with
 * the configured-tz equivalent without each component re-querying or
 * hardcoding "Asia/Kolkata".
 *
 * The query is intentionally long-lived (config rarely changes) and shares a
 * single query key across the app so all consumers stay in sync.
 */
export function useShiftConfig(): ShiftConfigBundle {
  const { data } = useGetShiftConfig({
    query: {
      queryKey: getGetShiftConfigQueryKey(),
      // Config only changes on server restart, so keep it warm and avoid
      // re-fetching on focus/mount churn.
      staleTime: 60 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    },
  });

  return useMemo(() => {
    const config = data ?? FALLBACK_CONFIG;
    const tzLabel = shortTzLabel(config.timeZone);
    const shiftLabels = buildShiftLabels(config.startHours);
    const formatClockTime = (d: Date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: config.timeZone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
    const formatDayTime = (d: Date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: config.timeZone,
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
    return {
      config,
      isFallback: !data,
      tzLabel,
      shiftLabels,
      formatClockTime,
      formatDayTime,
    };
  }, [data]);
}
