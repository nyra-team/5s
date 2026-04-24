import { MoonStar, BellOff } from "lucide-react";
import { useShiftConfig } from "@/lib/shift-config";

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

function formatZonedMoment(
  iso: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  // If the moment is within the next ~20 hours, the clock time alone is
  // unambiguous. Otherwise include the weekday so "Mon 22:00" reads cleanly.
  const diffMs = when.getTime() - now.getTime();
  const opts: Intl.DateTimeFormatOptions =
    diffMs <= 20 * 60 * 60 * 1000
      ? { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }
      : {
          timeZone,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        };
  return new Intl.DateTimeFormat("en-GB", opts).format(when);
}

/**
 * Live indicator that tells a manager whether their escalation alerts are
 * currently being suppressed by quiet hours, and when that ends. When alerts
 * are not muted but quiet hours are configured, shows the next mute time so
 * the manager can plan around it.
 *
 * Times and the timezone label come from the facility's configured shift
 * timezone (`/shift/config`) — never the hardcoded IST defaults — so a
 * site running in America/New_York sees "EDT" instead of "IST".
 */
export function QuietHoursStatusBadge({
  active,
  activeUntil,
  nextStart,
  quietHoursEnabled,
  variant,
}: Props) {
  const { config: shiftConfig, tzLabel } = useShiftConfig();
  if (!quietHoursEnabled) return null;

  if (active && activeUntil) {
    const until = formatZonedMoment(activeUntil, shiftConfig.timeZone);
    const label = `Quiet hours active until ${until} ${tzLabel}`;
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
        {variant === "compact" ? `Muted until ${until} ${tzLabel}` : label}
      </span>
    );
  }

  // Quiet hours configured but not currently active. Only show the upcoming
  // next-start hint on the notifications page itself; keep the global header
  // clean when alerts are flowing through.
  if (variant === "compact") return null;
  if (!nextStart) return null;
  const next = formatZonedMoment(nextStart, shiftConfig.timeZone);
  return (
    <span
      data-testid="quiet-hours-status-inactive"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium bg-secondary text-muted-foreground ring-1 ring-border"
    >
      <MoonStar className="w-3.5 h-3.5" />
      Alerts active — next mute at {next} {tzLabel}
    </span>
  );
}
