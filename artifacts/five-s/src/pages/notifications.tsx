import {
  useGetMyNotificationPreferences,
  useUpdateMyNotificationPreferences,
  getGetMyNotificationPreferencesQueryKey,
  NotificationPreferences,
  SettingsAuditEntry,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Mail, MessageSquare, AlertCircle, CheckCircle2, MoonStar, History, User } from "lucide-react";
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

      <PreferencesAuditFootNote data={data} />
    </div>
  );
}

// Friendly labels for the audit timeline. Keys MUST match the wire-format
// field names emitted by the audit endpoint (and used as `field` on the
// row). Fields not in this map fall back to the raw key — callers who add
// new audited fields should extend this table to keep the timeline readable.
const FIELD_LABEL: Record<string, string> = {
  notifyEmailEnabled: "Email notifications",
  notifySlackEnabled: "Slack notifications",
  quietHoursEnabled: "Quiet hours",
  quietHoursStart: "Quiet hours start",
  quietHoursEnd: "Quiet hours end",
  quietHoursWeekdayMask: "Quiet hours days",
};

function formatWeekdayMask(mask: number): string {
  // Display order Mon..Sun, mirroring the toggle row above; bit indices
  // remain JS Date#getDay (0 = Sun … 6 = Sat) to match the server.
  const order: Array<{ label: string; bit: number }> = [
    { label: "Mon", bit: 1 },
    { label: "Tue", bit: 2 },
    { label: "Wed", bit: 3 },
    { label: "Thu", bit: 4 },
    { label: "Fri", bit: 5 },
    { label: "Sat", bit: 6 },
    { label: "Sun", bit: 0 },
  ];
  if (mask === 127) return "every day";
  if (mask === 0) return "no days";
  return order.filter((d) => mask & (1 << d.bit)).map((d) => d.label).join(", ");
}

function formatAuditValue(field: string, v: string | number | boolean | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (field === "quietHoursWeekdayMask" && typeof v === "number") {
    return formatWeekdayMask(v);
  }
  return String(v);
}

function PreferencesAuditFootNote({ data }: { data: NotificationPreferences }) {
  return (
    <div className="space-y-3" data-testid="preferences-footnote">
      <PreferencesLastChangeLine data={data} />
      <PreferencesAuditHistory entries={data.auditHistory} />
    </div>
  );
}

function PreferencesLastChangeLine({ data }: { data: NotificationPreferences }) {
  if (!data.lastChangedAt) {
    return (
      <p
        className="text-[12px] text-muted-foreground"
        data-testid="preferences-last-change"
      >
        You haven't changed your notification preferences yet.
      </p>
    );
  }
  const when = new Date(data.lastChangedAt).toLocaleString();
  // Prefer the resolved email; fall back to a numeric id only if the user
  // record is gone (matches the operator-thresholds page's degradation).
  const who =
    data.lastChangedByUserEmail ??
    (data.lastChangedByUserId != null ? `user #${data.lastChangedByUserId}` : null);
  return (
    <p
      className="text-[12.5px] text-muted-foreground inline-flex items-center gap-1.5 flex-wrap"
      data-testid="preferences-last-change"
    >
      <User className="w-3.5 h-3.5" />
      Last changed by{" "}
      <span
        className="font-medium text-foreground"
        data-testid="preferences-last-change-who"
      >
        {who ?? "an unknown user"}
      </span>{" "}
      on{" "}
      <span
        className="font-medium text-foreground"
        data-testid="preferences-last-change-when"
      >
        {when}
      </span>
      .
    </p>
  );
}

function PreferencesAuditHistory({ entries }: { entries: SettingsAuditEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div
      className="bg-card rounded-2xl shadow-soft hairline px-5 py-4"
      data-testid="preferences-audit-history"
    >
      <p className="eyebrow inline-flex items-center gap-1.5">
        <History className="w-3 h-3" /> Recent changes
      </p>
      <ul className="mt-3 divide-y divide-border">
        {entries.map((entry) => {
          const label = FIELD_LABEL[entry.field] ?? entry.field;
          const oldText = formatAuditValue(entry.field, entry.oldValue);
          const newText = formatAuditValue(entry.field, entry.newValue);
          const who =
            entry.changedByUserEmail ??
            (entry.changedByUserId != null
              ? `user #${entry.changedByUserId}`
              : "an unknown user");
          const when = new Date(entry.changedAt).toLocaleString();
          return (
            <li
              key={entry.id}
              className="py-2 text-[12.5px] text-muted-foreground flex flex-wrap items-baseline gap-x-2"
              data-testid={`preferences-audit-entry-${entry.id}`}
            >
              <span className="font-medium text-foreground">{label}</span>
              <span className="tabular-nums">
                <span data-testid={`preferences-audit-entry-${entry.id}-old`}>
                  {oldText}
                </span>
                {" → "}
                <span
                  className="font-medium text-foreground"
                  data-testid={`preferences-audit-entry-${entry.id}-new`}
                >
                  {newText}
                </span>
              </span>
              <span className="ml-auto text-[11.5px]">
                <span data-testid={`preferences-audit-entry-${entry.id}-who`}>
                  {who}
                </span>
                {" · "}
                <span data-testid={`preferences-audit-entry-${entry.id}-when`}>
                  {when}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
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
