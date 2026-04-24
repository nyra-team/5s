import { createContext, useContext, useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark" | "auto";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "five-s-theme";

const DEFAULT_NIGHT_START_HOUR = 22;
const DEFAULT_NIGHT_END_HOUR = 6;
const DEFAULT_NIGHT_TZ = "Asia/Kolkata";

export interface NightShiftWindow {
  startHour: number;
  endHour: number;
  timeZone: string;
}

function parseHour(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const h = Math.trunc(n);
  if (h < 0 || h > 23) return fallback;
  return h;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the night-shift window from build-time config so each facility can
 * deploy with its own hours / timezone without code changes. Falls back to the
 * legacy 22:00–06:00 IST window when nothing is configured.
 *
 * Recognised env vars (Vite, prefixed with VITE_):
 *   VITE_NIGHT_SHIFT_START_HOUR   integer 0–23, default 22
 *   VITE_NIGHT_SHIFT_END_HOUR     integer 0–23, default 6
 *   VITE_NIGHT_SHIFT_TZ           IANA timezone, default Asia/Kolkata
 */
export function getNightShiftWindow(): NightShiftWindow {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const startHour = parseHour(env.VITE_NIGHT_SHIFT_START_HOUR, DEFAULT_NIGHT_START_HOUR);
  const endHour = parseHour(env.VITE_NIGHT_SHIFT_END_HOUR, DEFAULT_NIGHT_END_HOUR);
  const rawTz = env.VITE_NIGHT_SHIFT_TZ;
  const timeZone = rawTz && isValidTimeZone(rawTz) ? rawTz : DEFAULT_NIGHT_TZ;
  return { startHour, endHour, timeZone };
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

function getShiftPref(): "light" | "dark" {
  return isWithinNightWindow(new Date(), getNightShiftWindow()) ? "dark" : "light";
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return getSystemPref();
  if (mode === "auto") return getShiftPref();
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
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveMode(readStored()));

  useEffect(() => {
    const next = resolveMode(mode);
    setResolved(next);
    applyTheme(next);
  }, [mode]);

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
      const next = getShiftPref();
      setResolved((prev) => {
        if (prev !== next) applyTheme(next);
        return next;
      });
    };
    tick();
    const interval = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(interval);
  }, [mode]);

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
