import { createContext, useContext, useEffect, useState } from "react";
import {
  DEFAULT_NIGHT_SHIFT_WINDOW,
  useNightShiftWindow,
} from "@/lib/facility-settings";

export type ThemeMode = "system" | "light" | "dark" | "auto";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "five-s-theme";

export interface NightShiftWindow {
  startHour: number;
  endHour: number;
  timeZone: string;
}

/**
 * Synchronous fallback for places that can't use the React hook (module-load
 * call sites in older code, tests, the very first render before the API
 * responds). The DB-backed `useNightShiftWindow()` hook is the authoritative
 * runtime source — this is just the seed value.
 */
export function getNightShiftWindow(): NightShiftWindow {
  return DEFAULT_NIGHT_SHIFT_WINDOW;
}

export interface ShiftLabel {
  value: "A" | "B" | "C";
  label: string;
  time: string;
}

const FALLBACK_SHIFT_LABELS: ShiftLabel[] = [
  { value: "A", label: "Shift A", time: "6 AM – 2 PM" },
  { value: "B", label: "Shift B", time: "2 PM – 10 PM" },
  { value: "C", label: "Shift C", time: "10 PM – 6 AM" },
];

function formatHour12(hour24: number): string {
  const h = ((Math.trunc(hour24) % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

function nightWindowDurationHours(window: NightShiftWindow): number {
  const { startHour, endHour } = window;
  if (startHour === endHour) return 0;
  return startHour < endHour ? endHour - startHour : 24 - startHour + endHour;
}

/**
 * Build the three shift labels (A/B/C) from the per-facility night-shift
 * window so the times shown in the operator switcher stay in sync with the
 * configuration the rest of the app uses. Hours are interpreted in the
 * configured timezone (the same way `isWithinNightWindow` does).
 *
 * Falls back to the legacy "6 AM – 2 PM / 2 PM – 10 PM / 10 PM – 6 AM"
 * labels when the configured night window isn't a clean 8-hour block we
 * can tile into three equal shifts.
 */
export function getShiftLabels(
  window: NightShiftWindow = getNightShiftWindow(),
): ShiftLabel[] {
  if (nightWindowDurationHours(window) !== 8) return FALLBACK_SHIFT_LABELS;
  const cStart = window.startHour;
  const cEnd = window.endHour;
  const aStart = cEnd;
  const aEnd = (cEnd + 8) % 24;
  const bStart = aEnd;
  const bEnd = (aEnd + 8) % 24;
  return [
    {
      value: "A",
      label: "Shift A",
      time: `${formatHour12(aStart)} – ${formatHour12(aEnd)}`,
    },
    {
      value: "B",
      label: "Shift B",
      time: `${formatHour12(bStart)} – ${formatHour12(bEnd)}`,
    },
    {
      value: "C",
      label: "Shift C",
      time: `${formatHour12(cStart)} – ${formatHour12(cEnd)}`,
    },
  ];
}

function getHourInTimeZone(now: Date, timeZone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
    const h = parseInt(raw, 10);
    // Some locales report "24" for midnight under hour12:false; normalise.
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/**
 * True when "now" falls inside [startHour, endHour) in the given timezone.
 * Handles wrap-around windows like 22 → 6.
 */
export function isWithinNightWindow(now: Date, window: NightShiftWindow): boolean {
  const { startHour, endHour, timeZone } = window;
  if (startHour === endHour) return false; // empty window → never night
  const hour = getHourInTimeZone(now, timeZone);
  if (startHour < endHour) {
    // Same-day window, e.g. 0 → 6.
    return hour >= startHour && hour < endHour;
  }
  // Wrap-around window, e.g. 22 → 6.
  return hour >= startHour || hour < endHour;
}

function getSystemPref(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getShiftPref(window: NightShiftWindow): "light" | "dark" {
  return isWithinNightWindow(new Date(), window) ? "dark" : "light";
}

function resolveMode(mode: ThemeMode, window: NightShiftWindow): "light" | "dark" {
  if (mode === "system") return getSystemPref();
  if (mode === "auto") return getShiftPref(window);
  return mode;
}

function readStored(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" || v === "auto" ? v : "system";
}

function applyTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  if (resolved === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Live, DB-backed night-shift window. Falls back to the bundled defaults
  // until the API responds (and on the unauthenticated login screen the
  // public GET still succeeds). Re-renders the provider whenever a manager
  // edits the schedule, which re-runs the auto-theme effect below.
  const nightWindow = useNightShiftWindow();
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolveMode(readStored(), DEFAULT_NIGHT_SHIFT_WINDOW),
  );

  useEffect(() => {
    const next = resolveMode(mode, nightWindow);
    setResolved(next);
    applyTheme(next);
  }, [mode, nightWindow.startHour, nightWindow.endHour, nightWindow.timeZone]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = mq.matches ? "dark" : "light";
      setResolved(next);
      applyTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    if (mode !== "auto") return;
    const tick = () => {
      const next = getShiftPref(nightWindow);
      setResolved((prev) => {
        if (prev !== next) applyTheme(next);
        return next;
      });
    };
    tick();
    const interval = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(interval);
  }, [mode, nightWindow.startHour, nightWindow.endHour, nightWindow.timeZone]);

  const setMode = (m: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, m);
    setModeState(m);
  };

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
