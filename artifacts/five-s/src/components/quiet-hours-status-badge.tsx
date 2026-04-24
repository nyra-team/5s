import { MoonStar, BellOff } from "lucide-react";

interface Props {
  active: boolean;
  /** ISO datetime when the current window ends; null when not active. */
  activeUntil: string | null;
  /** ISO datetime when the next window begins; null when active or off. */
  nextStart: string | null;
  /** Whether the user has quiet hours configured at all. */
  quietHoursEnabled: boolean;
  /**
   * `inline` renders a wider pill suitable for the notifications page header.
   * `compact` renders a smaller pill for the global app header.
   */
  variant: "inline" | "compact";
}

const IST_FMT_TIME: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const IST_FMT_TIME_DAY: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

function formatIstMoment(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  // If the moment is within the next ~20 hours, the IST clock time alone is
  // unambiguous. Otherwise include the weekday so "Mon 22:00" reads cleanly.
  const diffMs = when.getTime() - now.getTime();
  const opts = diffMs <= 20 * 60 * 60 * 1000 ? IST_FMT_TIME : IST_FMT_TIME_DAY;
  return new Intl.DateTimeFormat("en-GB", opts).format(when);
}

/**
 * Live indicator that tells a manager whether their escalation alerts are
 * currently being suppressed by quiet hours, and when that ends. When alerts
 * are not muted but quiet hours are configured, shows the next mute time so
 * the manager can plan around it.
 */
export function QuietHoursStatusBadge({
  active,
  activeUntil,
  nextStart,
  quietHoursEnabled,
  variant,
}: Props) {
  if (!quietHoursEnabled) return null;

  if (active && activeUntil) {
    const until = formatIstMoment(activeUntil);
    const label = `Quiet hours active until ${until} IST`;
    return (
      <span
        data-testid="quiet-hours-status-active"
        title={label}
        className={
          variant === "compact"
            ? "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200 ring-1 ring-amber-200/70 dark:ring-amber-700/40"
            : "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200 ring-1 ring-amber-200/70 dark:ring-amber-700/40"
        }
      >
        <BellOff className={variant === "compact" ? "w-3 h-3" : "w-3.5 h-3.5"} />
        {variant === "compact" ? `Muted until ${until} IST` : label}
      </span>
    );
  }

  // Quiet hours configured but not currently active. Only show the upcoming
  // next-start hint on the notifications page itself; keep the global header
  // clean when alerts are flowing through.
  if (variant === "compact") return null;
  if (!nextStart) return null;
  const next = formatIstMoment(nextStart);
  return (
    <span
      data-testid="quiet-hours-status-inactive"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium bg-secondary text-muted-foreground ring-1 ring-border"
    >
      <MoonStar className="w-3.5 h-3.5" />
      Alerts active — next mute at {next} IST
    </span>
  );
}
