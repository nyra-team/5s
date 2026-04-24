import {
  useGetMyNotificationPreferences,
  useUpdateMyNotificationPreferences,
  getGetMyNotificationPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { Bell, Mail, MessageSquare, AlertCircle, CheckCircle2 } from "lucide-react";

type Channel = "email" | "slack";

export default function NotificationsPage() {
  const { data, isLoading } = useGetMyNotificationPreferences();
  const update = useUpdateMyNotificationPreferences();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Optimistic local mirrors so the UI feels instant; we sync from server data
  // whenever it lands or refreshes.
  const [emailOn, setEmailOn] = useState(false);
  const [slackOn, setSlackOn] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEmailOn(data.notifyEmailEnabled);
    setSlackOn(data.notifySlackEnabled);
  }, [data]);

  const persist = async (next: { notifyEmailEnabled?: boolean; notifySlackEnabled?: boolean }) => {
    try {
      await update.mutateAsync({ data: next });
      queryClient.invalidateQueries({ queryKey: getGetMyNotificationPreferencesQueryKey() });
      toast({ title: "Preferences saved" });
    } catch {
      // Roll back the optimistic toggle so the UI matches the server.
      if (data) {
        setEmailOn(data.notifyEmailEnabled);
        setSlackOn(data.notifySlackEnabled);
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
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">
          Escalation alerts
        </h1>
        <p className="text-muted-foreground text-[15px]">
          Get notified the moment a failed audit (below 60%) is auto-escalated, so
          you can respond across shifts without keeping the app open.
        </p>
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
    <div className="px-5 py-4 flex items-start gap-4">
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
