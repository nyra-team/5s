import { useEffect, useState } from "react";

const minuteTickListeners = new Set<() => void>();
let minuteTickIntervalId: ReturnType<typeof setInterval> | null = null;

export function subscribeMinuteTick(listener: () => void) {
  minuteTickListeners.add(listener);
  if (minuteTickIntervalId == null) {
    minuteTickIntervalId = setInterval(() => {
      for (const fn of minuteTickListeners) fn();
    }, 60_000);
  }
  return () => {
    minuteTickListeners.delete(listener);
    if (minuteTickListeners.size === 0 && minuteTickIntervalId != null) {
      clearInterval(minuteTickIntervalId);
      minuteTickIntervalId = null;
    }
  };
}

export function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeMinuteTick(() => setTick((t) => t + 1)), []);
}
