import {
  useGetOperatorThresholds,
  useUpdateOperatorThresholds,
  getGetOperatorThresholdsQueryKey,
  OperatorThresholds,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useState } from "react";
import {
  Sliders,
  RotateCcw,
  Save,
  Lock,
  Database,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

type FieldKey =
  | "encouragementMinPercent"
  | "priorBestWindowDays"
  | "dueSoonThresholdMinutes";

const FIELD_META: Record<FieldKey, {
  label: string;
  unit: string;
  min: number;
  max: number;
  help: string;
}> = {
  encouragementMinPercent: {
    label: "Encouragement chip cutoff",
    unit: "%",
    min: 0,
    max: 100,
    help:
      "Display percent at which a submission is considered \"good\". Drives the encouragement chip and the \"Last good\" hint in the operator capture sheet.",
  },
  priorBestWindowDays: {
    label: "Prior-best lookback window",
    unit: "days",
    min: 1,
    max: 365,
    help:
      "How far back to look when computing the operator's prior best per area. Affects the \"New best this week\" chip and the API's /operator/recent response.",
  },
  dueSoonThresholdMinutes: {
    label: "\"Due soon\" lead time",
    unit: "minutes",
    min: 0,
    max: 1440,
    help:
      "How far ahead an upcoming check is flagged \"due soon\" in the operator's area grid.",
  },
};

const FIELD_ORDER: FieldKey[] = [
  "encouragementMinPercent",
  "priorBestWindowDays",
  "dueSoonThresholdMinutes",
];

interface DraftRow {
  /** Empty string means "no DB override" (clear). */
  value: string;
}

function rowFromOverride(v: number | null | undefined): DraftRow {
  return { value: v == null ? "" : String(v) };
}

function clean(s: string): string {
  return s.trim();
}

export default function OperatorThresholdsPage() {
  const { data, isLoading } = useGetOperatorThresholds();
  const update = useUpdateOperatorThresholds();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Draft state for the per-field override inputs. Mirrors the DB override
  // (NOT the effective value) so an empty input cleanly maps to "clear".
  const [draft, setDraft] = useState<Record<FieldKey, DraftRow>>({
    encouragementMinPercent: { value: "" },
    priorBestWindowDays: { value: "" },
    dueSoonThresholdMinutes: { value: "" },
  });

  // Re-sync the draft only when the server-side override values actually
  // CHANGE — not on every react-query refetch (those return a new `data`
  // reference even when the content is identical, which would otherwise
  // wipe the user's in-flight edits).
  const serverSnapshot = data
    ? `${data.dbOverrides.encouragementMinPercent}|${data.dbOverrides.priorBestWindowDays}|${data.dbOverrides.dueSoonThresholdMinutes}`
    : "";
  useEffect(() => {
    if (!data) return;
    setDraft({
      encouragementMinPercent: rowFromOverride(data.dbOverrides.encouragementMinPercent),
      priorBestWindowDays: rowFromOverride(data.dbOverrides.priorBestWindowDays),
      dueSoonThresholdMinutes: rowFromOverride(data.dbOverrides.dueSoonThresholdMinutes),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSnapshot]);

  const validation = useMemo(() => {
    const out: Record<FieldKey, string | null> = {
      encouragementMinPercent: null,
      priorBestWindowDays: null,
      dueSoonThresholdMinutes: null,
    };
    for (const f of FIELD_ORDER) {
      const raw = clean(draft[f].value);
      if (raw === "") continue;
      const n = Number(raw);
      const meta = FIELD_META[f];
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        out[f] = "Must be a whole number";
      } else if (n < meta.min || n > meta.max) {
        out[f] = `Must be between ${meta.min} and ${meta.max}`;
      }
    }
    return out;
  }, [draft]);

  const dirty = useMemo(() => {
    if (!data) return false;
    for (const f of FIELD_ORDER) {
      const current = data.dbOverrides[f];
      const next = clean(draft[f].value);
      const nextValue = next === "" ? null : Number(next);
      if (current !== nextValue) return true;
    }
    return false;
  }, [data, draft]);

  const hasErrors = FIELD_ORDER.some((f) => validation[f] != null);

  const onSave = async () => {
    if (!data || !dirty || hasErrors) return;
    const body: Record<string, number | null> = {};
    for (const f of FIELD_ORDER) {
      const current = data.dbOverrides[f];
      const raw = clean(draft[f].value);
      const next = raw === "" ? null : Number(raw);
      if (current !== next) body[f] = next;
    }
    try {
      await update.mutateAsync({ data: body });
      queryClient.invalidateQueries({ queryKey: getGetOperatorThresholdsQueryKey() });
      toast({ title: "Thresholds saved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to save thresholds" });
    }
  };

  const onResetAll = () => {
    setDraft({
      encouragementMinPercent: { value: "" },
      priorBestWindowDays: { value: "" },
      dueSoonThresholdMinutes: { value: "" },
    });
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
          <Sliders className="w-3 h-3" /> Operator thresholds
        </p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">
          Tune operator thresholds
        </h1>
        <p className="text-muted-foreground text-[15px]">
          Adjust the cutoffs that drive the operator UI without a redeploy.
          Leave a field blank to fall back to the env-var override (if set)
          or the shipped default.
        </p>
      </header>

      <section className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border">
        {FIELD_ORDER.map((f) => {
          const meta = FIELD_META[f];
          const env = data.envOverrides[f];
          const dbVal = data.dbOverrides[f];
          const dflt = data.defaults[f];
          const eff = data[f];
          const err = validation[f];
          const draftRaw = clean(draft[f].value);
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
                    {eff} <span className="text-[12px] font-normal text-muted-foreground">{meta.unit}</span>
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-end gap-3 flex-wrap">
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-muted-foreground">
                    DB override ({meta.unit}, blank = clear)
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={meta.min}
                    max={meta.max}
                    step={1}
                    disabled={lockedByEnv}
                    value={draft[f].value}
                    placeholder={dbVal == null ? "—" : String(dbVal)}
                    data-testid={`input-${f}`}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f]: { value: e.target.value } }))
                    }
                    className="bg-secondary text-foreground rounded-lg px-3 py-1.5 text-[14px] tabular-nums hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-32 disabled:opacity-50"
                  />
                </label>

                {draftRaw !== "" && !lockedByEnv && (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({ ...d, [f]: { value: "" } }))
                    }
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
                    <Lock className="w-3 h-3" /> Locked by env: {env} {meta.unit}
                  </span>
                ) : dbVal != null ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <Database className="w-3 h-3" /> DB override: {dbVal} {meta.unit}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3" /> Using default ({dflt} {meta.unit})
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
          data-testid="save-thresholds"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium bg-primary text-primary-foreground shadow-soft transition-opacity disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onResetAll}
          disabled={!dirty || update.isPending}
          data-testid="reset-thresholds"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset to saved
        </button>
      </div>

      <FootNote data={data} />
    </div>
  );
}

function FootNote({ data }: { data: OperatorThresholds }) {
  const updated = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString()
    : null;
  return (
    <p className="text-[12px] text-muted-foreground" data-testid="thresholds-footnote">
      Precedence: <span className="font-medium">env var</span> &gt;{" "}
      <span className="font-medium">DB override</span> &gt;{" "}
      <span className="font-medium">default</span>. The operator UI and the
      /operator/recent endpoint pick up changes on their next request.
      {updated ? ` Last DB change: ${updated}.` : ""}
    </p>
  );
}
