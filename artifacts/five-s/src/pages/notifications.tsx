import {
  useGetMyNotificationPreferences,
  useUpdateMyNotificationPreferences,
  getGetMyNotificationPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Mail, MessageSquare, AlertCircle, CheckCircle2, MoonStar } from "lucide-react";
import { QuietHoursStatusBadge } from "@/components/quiet-hours-status-badge";
import { useShiftConfig } from "@/lib/shift-config";

type Channel = "email" | "slack";

// Display order is Mon..Sun (the way humans read a work week), but the bit
// indices are JS Date#getDay (0 = Sun … 6 = Sat) so they match the server.
const WEEKDAYS: Array<{ label: string; bit: number }> = [
  { label: "Mon", bit: 1 },
  { label: "Tue", bit: 2 },
  { label: "Wed", bit: 3 },
  { label: "Thu", bit: 4 },
  { label: "Fri", bit: 5 },
  { label: "Sat", bit: 6 },
  { label: "Sun", bit: 0 },
];

export default function NotificationsPage() {
  const { tzLabel } = useShiftConfig();
  const { data, isLoading } = useGetMyNotificationPreferences({
    query: {
      // Recompute the live "muted right now" status without waiting for a
      // page refresh. 60s is granular enough for HH:MM windows.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const update = useUpdateMyNotificationPreferences();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Optimistic local mirrors so the UI feels instant; we sync from server data
  // whenever it lands or refreshes.
  const [emailOn, setEmailOn] = useState(false);
  const [slackOn, setSlackOn] = useState(false);
  const [quietOn, setQuietOn] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const [weekdayMask, setWeekdayMask] = useState(127);

  useEffect(() => {
    if (!data) return;
    setEmailOn(data.notifyEmailEnabled);
    setSlackOn(data.notifySlackEnabled);
    setQuietOn(data.quietHoursEnabled);
    setQuietStart(data.quietHoursStart);
    setQuietEnd(data.quietHoursEnd);
    setWeekdayMask(data.quietHoursWeekdayMask);
  }, [data]);

  const persist = async (next: {
    notifyEmailEnabled?: boolean;
    notifySlackEnabled?: boolean;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    quietHoursWeekdayMask?: number;
  }) => {
    try {
      await update.mutateAsync({ data: next });
      queryClient.invalidateQueries({ queryKey: getGetMyNotificationPreferencesQueryKey() });
      toast({ title: "Preferences saved" });
    } catch {
      // Roll back optimistic state so the UI matches the server.
      if (data) {
        setEmailOn(data.notifyEmailEnabled);
        setSlackOn(data.notifySlackEnabled);
        setQuietOn(data.quietHoursEnabled);
        setQuietStart(data.quietHoursStart);
        setQuietEnd(data.quietHoursEnd);
        setWeekdayMask(data.quietHoursWeekdayMask);
      }
      toast({ variant: "destructive", title: "Failed to save preferences" });
    }
  };

  const onToggle = (channel: Channel, value: boolean) => {
    if (channel === "email") {
      setEmailOn(value);
      persist({ notifyEmailEnabled: value });
    } else {
      setSlackOn(value);
      persist({ notifySlackEnabled: value });
    }
  };

  const onQuietToggle = (value: boolean) => {
    setQuietOn(value);
    persist({ quietHoursEnabled: value });
  };

  // Time inputs fire onChange on every keystroke; debounce so a fully-typed
  // value is what hits the server.
  const startDebounceRef = useRef<number | null>(null);
  const endDebounceRef = useRef<number | null>(null);
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  const onStartChange = (v: string) => {
    setQuietStart(v);
    if (!TIME_RE.test(v)) return;
    if (startDebounceRef.current) window.clearTimeout(startDebounceRef.current);
    startDebounceRef.current = window.setTimeout(() => {
      persist({ quietHoursStart: v });
    }, 400);
  };

  const onEndChange = (v: string) => {
    setQuietEnd(v);
    if (!TIME_RE.test(v)) return;
    if (endDebounceRef.current) window.clearTimeout(endDebounceRef.current);
    endDebounceRef.current = window.setTimeout(() => {
      persist({ quietHoursEnd: v });
    }, 400);
  };

  const onToggleDay = (bit: number) => {
    const next = weekdayMask ^ (1 << bit);
    setWeekdayMask(next);
    persist({ quietHoursWeekdayMask: next });
  };

  const summary = useMemo(() => {
    if (!quietOn) return "Quiet hours are off — you'll be alerted any time, every day.";
    const days =
      weekdayMask === 127
        ? "every day"
        : weekdayMask === 0
          ? "no days (window inactive)"
          : `on ${WEEKDAYS.filter((d) => weekdayMask & (1 << d.bit)).map((d) => d.label).join(", ")}`;
    const wraps = quietStart >= quietEnd;
    const tail = wraps ? " (next morning)" : "";
    return `Muted ${quietStart}–${quietEnd}${tail} ${tzLabel} ${days}.`;
  }, [quietOn, quietStart, quietEnd, weekdayMask, tzLabel]);

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Bell className="w-3 h-3" /> Notifications
        </p>
        <h1 className="text-[26px] sm:text-[34px] font-semibold tracking-tight leading-tight">
          Escalation alerts
        </h1>
        <p className="text-muted-foreground text-[14px] sm:text-[15px]">
          Get notified the moment a failed audit (below 60%) is auto-escalated, so
          you can respond across shifts without keeping the app open.
        </p>
        <div className="pt-1">
          <QuietHoursStatusBadge
            active={data.quietHoursActive}
            activeUntil={data.quietHoursActiveUntil}
            nextStart={data.quietHoursNextStart}
            quietHoursEnabled={data.quietHoursEnabled}
            variant="inline"
          />
        </div>
      </header>

      <div className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border">
        <ChannelRow
          icon={<Mail className="w-4 h-4" />}
          label="Email"
          sublabel={`Sent to ${data.email}`}
          checked={emailOn}
          onChange={(v) => onToggle("email", v)}
          configured={data.emailConfigured}
          unconfiguredHint="Server email provider isn't configured. Toggle has no effect until an admin sets RESEND_API_KEY and NOTIFICATION_FROM_EMAIL."
          testid="toggle-email"
        />
        <ChannelRow
          icon={<MessageSquare className="w-4 h-4" />}
          label="Slack"
          sublabel="Posted to your team's escalations channel"
          checked={slackOn}
          onChange={(v) => onToggle("slack", v)}
          configured={data.slackConfigured}
          unconfiguredHint="Slack channel webhook isn't configured. Toggle has no effect until an admin sets SLACK_WEBHOOK_URL."
          testid="toggle-slack"
        />
      </div>

      <section className="bg-card rounded-2xl shadow-soft hairline">
        <div className="px-4 sm:px-5 py-4 flex items-start gap-3 sm:gap-4">
          <div className="mt-1 w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-foreground/80 shrink-0">
            <MoonStar className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-medium tracking-tight">Quiet hours</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Mute alerts you can't act on. Email is skipped; Slack is only
                  posted if at least one other subscriber is active.
                </p>
              </div>
              <div className="shrink-0 pt-0.5">
                <Switch checked={quietOn} onChange={onQuietToggle} testid="toggle-quiet-hours" />
              </div>
            </div>

            {quietOn && (
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <TimeField
                    label={`Start (${tzLabel})`}
                    value={quietStart}
                    onChange={onStartChange}
                    testid="quiet-hours-start"
                  />
                  <TimeField
                    label={`End (${tzLabel})`}
                    value={quietEnd}
                    onChange={onEndChange}
                    testid="quiet-hours-end"
                  />
                </div>

                <div>
                  <p className="text-[12.5px] text-muted-foreground mb-2">Apply on</p>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => {
                      const on = (weekdayMask & (1 << d.bit)) !== 0;
                      return (
                        <button
                          key={d.bit}
                          type="button"
                          aria-pressed={on}
                          onClick={() => onToggleDay(d.bit)}
                          data-testid={`quiet-hours-day-${d.label.toLowerCase()}`}
                          className={`text-[12px] font-medium px-2.5 py-1 rounded-full transition-colors ${
                            on
                              ? "bg-primary text-primary-foreground"
                              : "bg-secondary text-foreground/70 hover:text-foreground"
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <p
              className="mt-3 text-[11.5px] text-muted-foreground"
              data-testid="quiet-hours-summary"
            >
              {summary}
            </p>
          </div>
        </div>
      </section>

      <p className="text-[12.5px] text-muted-foreground">
        Each notification includes the area, score percentage, failing pillars, and a
        link to the escalations inbox.
      </p>
    </div>
  );
}

function ChannelRow({
  icon,
  label,
  sublabel,
  checked,
  onChange,
  configured,
  unconfiguredHint,
  testid,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  configured: boolean;
  unconfiguredHint: string;
  testid: string;
}) {
  return (
    <div className="px-4 sm:px-5 py-4 flex items-start gap-3 sm:gap-4">
      <div className="mt-1 w-9 h-9 rounded-xl bg-secondary flex items-center justify-center text-foreground/80 shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium tracking-tight">{label}</p>
            <p className="text-[12.5px] text-muted-foreground truncate">{sublabel}</p>
          </div>
          <Switch checked={checked} onChange={onChange} testid={testid} />
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 text-[11.5px]">
          {configured ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3 h-3" /> Provider configured
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
              title={unconfiguredHint}
            >
              <AlertCircle className="w-3 h-3" /> Provider not configured
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="bg-secondary text-foreground rounded-lg px-3 py-1.5 text-[14px] tabular-nums hairline focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </label>
  );
}

function Switch({
  checked,
  onChange,
  testid,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      data-testid={testid}
      className={`relative inline-flex items-center h-6 w-11 rounded-full transition-colors shrink-0 ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 rounded-full bg-white shadow-soft transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
