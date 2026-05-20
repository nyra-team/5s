import { useState, useEffect } from "react";
import { Settings as SettingsIcon, Bell, Sliders, Clock, Bot, BarChart3, Palette, Zap, AlertTriangle, Trash2 } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

import NotificationsPage from "@/pages/notifications";
import OperatorThresholdsPage from "@/pages/operator-thresholds";
import FacilitySettingsPage from "@/pages/facility-settings";
import AiSettingsPage from "@/pages/ai-settings";
import {
  AiReliabilityPanel,
  AiCostPanel,
  BackfillReasoningPanel,
  LearningStatusPanel,
} from "@/pages/dashboard";

/**
 * Settings & Stats — the umbrella page that hosts configuration tabs
 * (notifications, thresholds, shifts, AI model, theme) that used to clutter
 * the top nav, plus an AI ops Stats tab carrying the four panels lifted
 * off the Manager Dashboard during the Phase 1 dashboard cleanup.
 *
 * Each tab pane renders the existing standalone page body inside the tab.
 * The standalone routes (/notifications, /operator-thresholds, etc.) are
 * left registered so any direct link from an old email or browser
 * bookmark still works — they just aren't in the top nav anymore.
 */

type TabKey = "notifications" | "thresholds" | "shifts" | "ai" | "stats" | "theme";

const TABS: { key: TabKey; label: string; icon: typeof Bell }[] = [
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "thresholds", label: "Operator thresholds", icon: Sliders },
  { key: "shifts", label: "Shifts & timezone", icon: Clock },
  { key: "ai", label: "AI model", icon: Bot },
  { key: "stats", label: "AI ops stats", icon: BarChart3 },
  { key: "theme", label: "Theme", icon: Palette },
];

export default function SettingsPage() {
  // Default to "stats" — the AI ops widgets that used to sit on the
  // dashboard. Most managers will open this page wanting that first.
  const [tab, setTab] = useState<TabKey>("stats");

  return (
    <div className="space-y-8 pb-12">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <SettingsIcon className="w-3 h-3" /> Configuration &amp; stats
        </p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">Settings &amp; Stats</h1>
        <p className="text-muted-foreground text-[15px]">
          Everything that used to be in the top nav, plus the AI ops widgets
          moved off the dashboard.
        </p>
      </header>

      <div
        className="overflow-x-auto scrollbar-none -mx-2 px-2"
        data-testid="settings-tab-strip"
      >
        <nav className="inline-flex items-center gap-1 p-1 pill-track rounded-full">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "text-foreground pill-thumb-bg shadow-soft"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`settings-tab-${t.key}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      <section className="min-h-[60vh]" data-testid={`settings-pane-${tab}`}>
        {tab === "notifications" && <NotificationsPage />}
        {tab === "thresholds" && <OperatorThresholdsPage />}
        {tab === "shifts" && <FacilitySettingsPage />}
        {tab === "ai" && <AiSettingsPage />}
        {tab === "stats" && (
          <div className="space-y-6">
            <CacheHitRatePanel />
            <AiReliabilityPanel />
            <AiCostPanel />
            <BackfillReasoningPanel />
            <LearningStatusPanel />
          </div>
        )}
        {tab === "theme" && (
          <div className="space-y-6 max-w-2xl">
            <div className="bg-card rounded-2xl shadow-soft p-6">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="eyebrow inline-flex items-center gap-1.5">
                    <Palette className="w-3 h-3" /> Appearance
                  </p>
                  <h2 className="text-lg font-semibold tracking-tight mt-1">Theme</h2>
                </div>
                <ThemeToggle />
              </div>
              <p className="text-[13.5px] text-muted-foreground leading-relaxed">
                Light, Dark, or Auto. The Auto setting follows the facility's
                shift schedule — dark during night shift, light during day shift.
                Operators see the same theme; the toggle here applies across the
                whole organization for now.
              </p>
            </div>
            <DangerZone />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Cache hit rate widget — surfaces how many VLM round-trips we've skipped
 * because the dHash-keyed score cache had a hit. Reads
 * /api/dashboard/ai-cache directly via fetch (the OpenAPI client hasn't
 * been regenerated for this endpoint yet — we can fold it in next time
 * orval runs).
 */
function CacheHitRatePanel() {
  type Stats = {
    entries: number;
    totalHits: number;
    hitsToday: number;
    hitRate: number;
    topAreas: { areaId: number; areaName: string; hits: number; entries: number }[];
  };
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem("token");
        const res = await fetch("/api/dashboard/ai-cache", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Stats;
        if (!cancelled) setStats(body);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="bg-card rounded-2xl shadow-soft p-6" data-testid="cache-hit-rate-panel">
      <div className="mb-5">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Zap className="w-3 h-3" /> Score cache
        </p>
        <h2 className="text-lg font-semibold tracking-tight mt-1">Cache hit rate</h2>
        <p className="text-[12.5px] text-muted-foreground mt-1">
          How many VLM round-trips we skipped because the same area was
          re-captured with no visual change. Higher is better.
        </p>
      </div>
      {error ? (
        <p className="text-[13px] text-rose-600">Couldn't load: {error}</p>
      ) : !stats ? (
        <div className="h-20 bg-secondary rounded-xl animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 mb-5">
            <Tile label="Hit rate" value={`${stats.hitRate}%`} />
            <Tile label="Hits today" value={String(stats.hitsToday)} />
            <Tile label="Cached entries" value={String(stats.entries)} />
          </div>
          {stats.topAreas.length > 0 && (
            <div>
              <p className="eyebrow mb-2">Top cached areas</p>
              <ul className="space-y-1.5">
                {stats.topAreas.map((a) => (
                  <li
                    key={a.areaId}
                    className="flex items-center justify-between bg-secondary/60 rounded-lg px-3 py-2 text-[13px]"
                  >
                    <span className="font-medium truncate">{a.areaName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {a.hits} hits · {a.entries} cached
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Account deletion card. Sits at the bottom of the Theme tab (since "danger
 * zone" feels orthogonal to configuration). Asks the user to type their
 * email + password to confirm — the backend re-verifies the password
 * before soft-deleting + anonymising the row.
 */
function DangerZone() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [emailEcho, setEmailEcho] = useState("");
  const [pending, setPending] = useState(false);

  const canSubmit =
    !!user &&
    emailEcho.trim().toLowerCase() === user.email.toLowerCase() &&
    password.length > 0 &&
    !pending;

  const onDelete = async () => {
    setPending(true);
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/auth/me", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({
          variant: "destructive",
          title: "Couldn't delete account",
          description: body?.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      toast({ title: "Account deleted", description: "Signing you out." });
      setTimeout(() => logout(), 800);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't delete account",
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="bg-card rounded-2xl shadow-soft border border-rose-200/60 dark:border-rose-500/20 p-6"
      data-testid="danger-zone"
    >
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <div>
          <p className="eyebrow text-rose-600 dark:text-rose-400">Danger zone</p>
          <h2 className="text-lg font-semibold tracking-tight mt-1">Delete account</h2>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
            Permanently removes your sign-in access and anonymises your
            email / display name. Submissions you've made stay in the audit
            log but no longer carry your identity. This can't be undone.
          </p>
        </div>
      </div>

      {!confirming ? (
        <Button
          variant="outline"
          className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10"
          onClick={() => setConfirming(true)}
          data-testid="danger-zone-start"
        >
          <Trash2 className="w-4 h-4 mr-2" /> Delete my account
        </Button>
      ) : (
        <div className="space-y-3 max-w-md">
          <div>
            <label className="text-[12px] text-muted-foreground mb-1 block">
              Type your email to confirm
            </label>
            <Input
              value={emailEcho}
              onChange={(e) => setEmailEcho(e.target.value)}
              placeholder={user?.email}
              autoComplete="off"
              className="h-10"
              data-testid="danger-zone-email"
            />
          </div>
          <div>
            <label className="text-[12px] text-muted-foreground mb-1 block">
              Current password
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-10"
              data-testid="danger-zone-password"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="destructive"
              disabled={!canSubmit}
              onClick={onDelete}
              data-testid="danger-zone-confirm"
            >
              {pending ? "Deleting…" : "Permanently delete"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false);
                setPassword("");
                setEmailEcho("");
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/60 rounded-xl px-3 py-2.5">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-[20px] font-semibold tabular-nums mt-1">{value}</p>
    </div>
  );
}
