import {
  useGetFacilitySettings,
  useUpdateFacilitySettings,
  getGetFacilitySettingsQueryKey,
  FacilitySettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useState } from "react";
import {
  Clock,
  RotateCcw,
  Save,
  Lock,
  Database,
  CheckCircle2,
  AlertTriangle,
  Globe2,
  BellRing,
} from "lucide-react";

type HourField = "shiftAStartHour" | "shiftBStartHour" | "shiftCStartHour";

const HOUR_FIELDS: HourField[] = [
  "shiftAStartHour",
  "shiftBStartHour",
  "shiftCStartHour",
];

const HOUR_META: Record<HourField, { label: string; help: string }> = {
  shiftAStartHour: {
    label: "Shift A start hour",
    help:
      "Local hour (0–23) at which Shift A begins. Drives shift bucketing for submissions, the live shift view, and dashboard slicing.",
  },
  shiftBStartHour: {
    label: "Shift B start hour",
    help: "Local hour (0–23) at which Shift B begins. Must be later than Shift A.",
  },
  shiftCStartHour: {
    label: "Shift C start hour",
    help:
      "Local hour (0–23) at which Shift C begins. Must be later than Shift B. Also marks the start of the operator UI's Auto night theme.",
  },
};

type RepingField = "repingThresholdMinutes" | "repingMaxRepings";

const REPING_FIELDS: RepingField[] = [
  "repingThresholdMinutes",
  "repingMaxRepings",
];

interface RepingMeta {
  label: string;
  unit: string;
  help: string;
  min: number;
  max: number;
}

const REPING_META: Record<RepingField, RepingMeta> = {
  repingThresholdMinutes: {
    label: "Re-ping after (minutes)",
    unit: "min",
    help:
      "How long an unacknowledged escalation must sit before the scheduler nudges managers again. Picked up on the next sweep tick — no restart required.",
    min: 1,
    max: 1440,
  },
  repingMaxRepings: {
    label: "Maximum re-pings per escalation",
    unit: "",
    help:
      "How many reminder pings to send before going quiet. Set to 0 to disable re-pings entirely.",
    min: 0,
    max: 20,
  },
};

interface DraftState {
  timeZone: string;
  shiftAStartHour: string;
  shiftBStartHour: string;
  shiftCStartHour: string;
  repingThresholdMinutes: string;
  repingMaxRepings: string;
}

function clean(s: string): string {
  return s.trim();
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function rowFromHourOverride(v: number | null | undefined): string {
  return v == null ? "" : String(v);
}

function rowFromTzOverride(v: string | null | undefined): string {
  return v == null ? "" : v;
}

export default function FacilitySettingsPage() {
  const { data, isLoading } = useGetFacilitySettings();
  const update = useUpdateFacilitySettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Draft state mirrors the DB OVERRIDE values (not the effective ones), so
  // an empty input cleanly maps to "clear this override and fall back to env
  // var or the bootstrap default".
  const [draft, setDraft] = useState<DraftState>({
    timeZone: "",
    shiftAStartHour: "",
    shiftBStartHour: "",
    shiftCStartHour: "",
    repingThresholdMinutes: "",
    repingMaxRepings: "",
  });

  // Re-sync draft only when the server-side override values actually CHANGE
  // — react-query returns a fresh `data` reference on every refetch, which
  // would otherwise wipe in-flight edits.
  const serverSnapshot = data
    ? [
        data.dbOverrides.timeZone,
        data.dbOverrides.shiftAStartHour,
        data.dbOverrides.shiftBStartHour,
        data.dbOverrides.shiftCStartHour,
        data.dbOverrides.repingThresholdMinutes,
        data.dbOverrides.repingMaxRepings,
      ].join("|")
    : "";
  useEffect(() => {
    if (!data) return;
    setDraft({
      timeZone: rowFromTzOverride(data.dbOverrides.timeZone),
      shiftAStartHour: rowFromHourOverride(data.dbOverrides.shiftAStartHour),
      shiftBStartHour: rowFromHourOverride(data.dbOverrides.shiftBStartHour),
      shiftCStartHour: rowFromHourOverride(data.dbOverrides.shiftCStartHour),
      repingThresholdMinutes: rowFromHourOverride(
        data.dbOverrides.repingThresholdMinutes,
      ),
      repingMaxRepings: rowFromHourOverride(data.dbOverrides.repingMaxRepings),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSnapshot]);

  const validation = useMemo(() => {
    const out: {
      timeZone: string | null;
      shiftAStartHour: string | null;
      shiftBStartHour: string | null;
      shiftCStartHour: string | null;
      repingThresholdMinutes: string | null;
      repingMaxRepings: string | null;
      ordering: string | null;
    } = {
      timeZone: null,
      shiftAStartHour: null,
      shiftBStartHour: null,
      shiftCStartHour: null,
      repingThresholdMinutes: null,
      repingMaxRepings: null,
      ordering: null,
    };

    const tzRaw = clean(draft.timeZone);
    if (tzRaw !== "" && !isValidTimeZone(tzRaw)) {
      out.timeZone = "Must be a valid IANA timezone (e.g. Asia/Kolkata)";
    }

    for (const f of HOUR_FIELDS) {
      const raw = clean(draft[f]);
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        out[f] = "Must be a whole number";
      } else if (n < 0 || n > 23) {
        out[f] = "Must be between 0 and 23";
      }
    }

    for (const f of REPING_FIELDS) {
      const raw = clean(draft[f]);
      if (raw === "") continue;
      const n = Number(raw);
      const meta = REPING_META[f];
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        out[f] = "Must be a whole number";
      } else if (n < meta.min || n > meta.max) {
        out[f] = `Must be between ${meta.min} and ${meta.max}`;
      }
    }

    // Cross-field ordering check uses the EFFECTIVE values (env > draft >
    // existing DB > default) so the warning matches what the API will
    // actually accept on save.
    if (data) {
      const eff = (f: HourField, dflt: number): number => {
        const env = data.envOverrides[f];
        if (env != null) return env;
        const raw = clean(draft[f]);
        if (raw !== "") {
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
        }
        const db = data.dbOverrides[f];
        if (db != null) return db;
        return dflt;
      };
      const a = eff("shiftAStartHour", data.defaults.shiftAStartHour);
      const b = eff("shiftBStartHour", data.defaults.shiftBStartHour);
      const c = eff("shiftCStartHour", data.defaults.shiftCStartHour);
      if (!(a < b && b < c)) {
        out.ordering = `Shift hours must be strictly increasing — got A=${a}, B=${b}, C=${c}.`;
      }
    }
    return out;
  }, [draft, data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    if (rowFromTzOverride(data.dbOverrides.timeZone) !== clean(draft.timeZone))
      return true;
    for (const f of HOUR_FIELDS) {
      const current = data.dbOverrides[f];
      const next = clean(draft[f]);
      const nextValue = next === "" ? null : Number(next);
      if (current !== nextValue) return true;
    }
    for (const f of REPING_FIELDS) {
      const current = data.dbOverrides[f];
      const next = clean(draft[f]);
      const nextValue = next === "" ? null : Number(next);
      if (current !== nextValue) return true;
    }
    return false;
  }, [data, draft]);

  const hasErrors =
    validation.timeZone != null ||
    validation.shiftAStartHour != null ||
    validation.shiftBStartHour != null ||
    validation.shiftCStartHour != null ||
    validation.repingThresholdMinutes != null ||
    validation.repingMaxRepings != null ||
    validation.ordering != null;

  const onSave = async () => {
    if (!data || !dirty || hasErrors) return;
    const body: Record<string, string | number | null> = {};

    const tzRaw = clean(draft.timeZone);
    const tzNext = tzRaw === "" ? null : tzRaw;
    if (data.dbOverrides.timeZone !== tzNext) body.timeZone = tzNext;

    for (const f of HOUR_FIELDS) {
      const current = data.dbOverrides[f];
      const raw = clean(draft[f]);
      const next = raw === "" ? null : Number(raw);
      if (current !== next) body[f] = next;
    }
    for (const f of REPING_FIELDS) {
      const current = data.dbOverrides[f];
      const raw = clean(draft[f]);
      const next = raw === "" ? null : Number(raw);
      if (current !== next) body[f] = next;
    }
    try {
      await update.mutateAsync({ data: body });
      queryClient.invalidateQueries({ queryKey: getGetFacilitySettingsQueryKey() });
      toast({ title: "Facility settings saved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to save facility settings" });
    }
  };

  const onResetAll = () => {
    if (!data) return;
    setDraft({
      timeZone: rowFromTzOverride(data.dbOverrides.timeZone),
      shiftAStartHour: rowFromHourOverride(data.dbOverrides.shiftAStartHour),
      shiftBStartHour: rowFromHourOverride(data.dbOverrides.shiftBStartHour),
      shiftCStartHour: rowFromHourOverride(data.dbOverrides.shiftCStartHour),
      repingThresholdMinutes: rowFromHourOverride(
        data.dbOverrides.repingThresholdMinutes,
      ),
      repingMaxRepings: rowFromHourOverride(data.dbOverrides.repingMaxRepings),
    });
  };

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const tzEnv = data.envOverrides.timeZone;
  const tzDb = data.dbOverrides.timeZone;
  const tzDflt = data.defaults.timeZone;
  const tzEff = data.timeZone;
  const tzLockedByEnv = tzEnv != null;

  return (
    <div className="space-y-8 max-w-2xl">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Clock className="w-3 h-3" /> Facility settings
        </p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">
          Set your shift schedule
        </h1>
        <p className="text-muted-foreground text-[15px]">
          Configure the timezone and start hour of each shift. The API uses
          this to bucket every submission into the right shift, and the
          operator UI's Auto theme uses Shift C → Shift A as its night
          window. Leave a field blank to fall back to the env-var override
          (if set) or the shipped default.
        </p>
      </header>

      <section className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border">
        {/* Timezone row */}
        <div className="px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium tracking-tight">Timezone</p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">
                IANA timezone the facility operates in. All shift hours are
                interpreted in this zone.
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Effective
              </p>
              <p
                className="text-[15px] font-semibold"
                data-testid="effective-timeZone"
              >
                {tzEff}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">
                DB override (blank = clear)
              </span>
              <input
                type="text"
                disabled={tzLockedByEnv}
                value={draft.timeZone}
                placeholder={tzDb ?? "—"}
                data-testid="input-timeZone"
                onChange={(e) =>
                  setDraft((d) => ({ ...d, timeZone: e.target.value }))
                }
                className="bg-secondary text-foreground rounded-lg px-3 py-1.5 text-[14px] hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-56 disabled:opacity-50"
              />
            </label>
            {clean(draft.timeZone) !== "" && !tzLockedByEnv && (
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, timeZone: "" }))}
                className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
                data-testid="clear-timeZone"
              >
                <RotateCcw className="w-3 h-3" /> Clear
              </button>
            )}
          </div>

          {validation.timeZone && (
            <p
              className="mt-2 inline-flex items-center gap-1 text-[12px] text-rose-700 dark:text-rose-300"
              data-testid="error-timeZone"
            >
              <AlertTriangle className="w-3 h-3" /> {validation.timeZone}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">
            {tzLockedByEnv ? (
              <span
                className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
                title="An environment variable on the API is overriding both the DB value and the default."
              >
                <Lock className="w-3 h-3" /> Locked by env: {tzEnv}
              </span>
            ) : tzDb != null ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                <Database className="w-3 h-3" /> DB override: {tzDb}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Globe2 className="w-3 h-3" /> Using default ({tzDflt})
              </span>
            )}
          </div>
        </div>

        {/* Shift hour rows */}
        {HOUR_FIELDS.map((f) => {
          const meta = HOUR_META[f];
          const env = data.envOverrides[f];
          const dbVal = data.dbOverrides[f];
          const dflt = data.defaults[f];
          const eff = data[f];
          const err = validation[f];
          const draftRaw = clean(draft[f]);
          const lockedByEnv = env != null;

          return (
            <div key={f} className="px-5 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium tracking-tight">{meta.label}</p>
                  <p className="text-[12.5px] text-muted-foreground mt-0.5">{meta.help}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Effective
                  </p>
                  <p
                    className="text-[18px] font-semibold tabular-nums"
                    data-testid={`effective-${f}`}
                  >
                    {eff}
                    <span className="text-[12px] font-normal text-muted-foreground">
                      :00
                    </span>
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-end gap-3 flex-wrap">
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">
                    DB override (hour, blank = clear)
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={23}
                    step={1}
                    disabled={lockedByEnv}
                    value={draft[f]}
                    placeholder={dbVal == null ? "—" : String(dbVal)}
                    data-testid={`input-${f}`}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f]: e.target.value }))
                    }
                    className="bg-secondary text-foreground rounded-lg px-3 py-1.5 text-[14px] tabular-nums hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-32 disabled:opacity-50"
                  />
                </label>

                {draftRaw !== "" && !lockedByEnv && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, [f]: "" }))}
                    className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
                    data-testid={`clear-${f}`}
                  >
                    <RotateCcw className="w-3 h-3" /> Clear
                  </button>
                )}
              </div>

              {err && (
                <p
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-rose-700 dark:text-rose-300"
                  data-testid={`error-${f}`}
                >
                  <AlertTriangle className="w-3 h-3" /> {err}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">
                {lockedByEnv ? (
                  <span
                    className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
                    title="An environment variable on the API is overriding both the DB value and the default."
                  >
                    <Lock className="w-3 h-3" /> Locked by env: {env}:00
                  </span>
                ) : dbVal != null ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <Database className="w-3 h-3" /> DB override: {dbVal}:00
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3" /> Using default ({dflt}:00)
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {validation.ordering && (
        <p
          className="inline-flex items-center gap-1 text-[12.5px] text-rose-700 dark:text-rose-300"
          data-testid="error-ordering"
        >
          <AlertTriangle className="w-3.5 h-3.5" /> {validation.ordering}
        </p>
      )}

      <header className="space-y-2 pt-4">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <BellRing className="w-3 h-3" /> Escalation re-pings
        </p>
        <h2 className="text-[24px] font-semibold tracking-tight leading-tight">
          Tune how often unacknowledged alerts re-nudge managers
        </h2>
        <p className="text-muted-foreground text-[15px]">
          When an escalation sits OPEN past the threshold below, the
          scheduler re-pings managers up to the configured cap. Changes
          land on the next sweep tick — no API restart needed.
        </p>
      </header>

      <section className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border">
        {REPING_FIELDS.map((f) => {
          const meta = REPING_META[f];
          const env = data.envOverrides[f];
          const dbVal = data.dbOverrides[f];
          const dflt = data.defaults[f];
          const eff = data[f];
          const err = validation[f];
          const draftRaw = clean(draft[f]);
          const lockedByEnv = env != null;
          const fmt = (n: number) =>
            meta.unit ? `${n} ${meta.unit}` : String(n);

          return (
            <div key={f} className="px-5 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium tracking-tight">
                    {meta.label}
                  </p>
                  <p className="text-[12.5px] text-muted-foreground mt-0.5">
                    {meta.help}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Effective
                  </p>
                  <p
                    className="text-[18px] font-semibold tabular-nums"
                    data-testid={`effective-${f}`}
                  >
                    {eff}
                    {meta.unit && (
                      <span className="text-[12px] font-normal text-muted-foreground ml-1">
                        {meta.unit}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-end gap-3 flex-wrap">
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">
                    DB override (blank = clear)
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={meta.min}
                    max={meta.max}
                    step={1}
                    disabled={lockedByEnv}
                    value={draft[f]}
                    placeholder={dbVal == null ? "—" : String(dbVal)}
                    data-testid={`input-${f}`}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f]: e.target.value }))
                    }
                    className="bg-secondary text-foreground rounded-lg px-3 py-1.5 text-[14px] tabular-nums hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-32 disabled:opacity-50"
                  />
                </label>

                {draftRaw !== "" && !lockedByEnv && (
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, [f]: "" }))}
                    className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground"
                    data-testid={`clear-${f}`}
                  >
                    <RotateCcw className="w-3 h-3" /> Clear
                  </button>
                )}
              </div>

              {err && (
                <p
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-rose-700 dark:text-rose-300"
                  data-testid={`error-${f}`}
                >
                  <AlertTriangle className="w-3 h-3" /> {err}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">
                {lockedByEnv ? (
                  <span
                    className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
                    title="An environment variable on the API is overriding both the DB value and the default."
                  >
                    <Lock className="w-3 h-3" /> Locked by env: {fmt(env)}
                  </span>
                ) : dbVal != null ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <Database className="w-3 h-3" /> DB override: {fmt(dbVal)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3" /> Using default ({fmt(dflt)})
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || hasErrors || update.isPending}
          data-testid="save-facility-settings"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium bg-primary text-primary-foreground shadow-soft transition-opacity disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onResetAll}
          disabled={!dirty || update.isPending}
          data-testid="reset-facility-settings"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset to saved
        </button>
      </div>

      <FootNote data={data} />
    </div>
  );
}

function FootNote({ data }: { data: FacilitySettings }) {
  const updated = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString()
    : null;
  return (
    <p className="text-[12px] text-muted-foreground" data-testid="facility-settings-footnote">
      Precedence: <span className="font-medium">env var</span> &gt;{" "}
      <span className="font-medium">DB override</span> &gt;{" "}
      <span className="font-medium">default</span>. Submission bucketing,
      live shift, and dashboard slicing pick up changes on their next
      request.
      {updated ? ` Last DB change: ${updated}.` : ""}
    </p>
  );
}
