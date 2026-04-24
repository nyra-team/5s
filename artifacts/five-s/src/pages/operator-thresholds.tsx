import {
  useGetOperatorThresholds,
  useUpdateOperatorThresholds,
  useGetAreaOperatorThresholds,
  useUpdateAreaOperatorThresholds,
  useClearAreaOperatorThresholds,
  useListAreas,
  getGetOperatorThresholdsQueryKey,
  getGetAreaOperatorThresholdsQueryKey,
  OperatorThresholds,
  OperatorThresholdAuditEntry,
  AreaOperatorThresholds,
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
  History,
  User,
  Building2,
  Globe2,
  Eraser,
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

const EMPTY_DRAFT: Record<FieldKey, DraftRow> = {
  encouragementMinPercent: { value: "" },
  priorBestWindowDays: { value: "" },
  dueSoonThresholdMinutes: { value: "" },
};

/** Sentinel for the "Global" option in the area selector. */
type Scope = "global" | { areaId: number };

export default function OperatorThresholdsPage() {
  const { data: globalData, isLoading: globalLoading } =
    useGetOperatorThresholds();
  const { data: areas } = useListAreas();
  const [scope, setScope] = useState<Scope>("global");

  if (globalLoading || !globalData) {
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
          Set a global default and, when needed, fine-tune a single area
          (e.g. a fast-cycling line that needs a tighter "due soon" lead).
        </p>
      </header>

      <ScopeSelector
        scope={scope}
        onChange={setScope}
        areas={(areas ?? []).map((a) => ({ id: a.id, name: a.name }))}
        areaOverrides={globalData.areaOverrides}
      />

      {scope === "global" ? (
        <GlobalEditor data={globalData} />
      ) : (
        <AreaEditor areaId={scope.areaId} globalData={globalData} />
      )}
    </div>
  );
}

function ScopeSelector({
  scope,
  onChange,
  areas,
  areaOverrides,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  areas: { id: number; name: string }[];
  areaOverrides: OperatorThresholds["areaOverrides"];
}) {
  const overrideIds = new Set(areaOverrides.map((a) => a.areaId));
  const isGlobal = scope === "global";
  return (
    <div className="bg-card rounded-2xl shadow-soft hairline p-3 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onChange("global")}
        data-testid="scope-global"
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${
          isGlobal
            ? "bg-primary text-primary-foreground"
            : "bg-secondary text-foreground hover:bg-secondary/80"
        }`}
      >
        <Globe2 className="w-3 h-3" /> Global
      </button>
      {areas.map((a) => {
        const selected = !isGlobal && (scope as { areaId: number }).areaId === a.id;
        const hasOverride = overrideIds.has(a.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onChange({ areaId: a.id })}
            data-testid={`scope-area-${a.id}`}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${
              selected
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-foreground hover:bg-secondary/80"
            }`}
          >
            <Building2 className="w-3 h-3" /> {a.name}
            {hasOverride && (
              <span
                className={`ml-1 inline-block w-1.5 h-1.5 rounded-full ${
                  selected ? "bg-primary-foreground" : "bg-emerald-500"
                }`}
                title="This area has a per-area override"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function GlobalEditor({ data }: { data: OperatorThresholds }) {
  const update = useUpdateOperatorThresholds();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Record<FieldKey, DraftRow>>(EMPTY_DRAFT);

  const serverSnapshot = `${data.dbOverrides.encouragementMinPercent}|${data.dbOverrides.priorBestWindowDays}|${data.dbOverrides.dueSoonThresholdMinutes}`;
  useEffect(() => {
    setDraft({
      encouragementMinPercent: rowFromOverride(data.dbOverrides.encouragementMinPercent),
      priorBestWindowDays: rowFromOverride(data.dbOverrides.priorBestWindowDays),
      dueSoonThresholdMinutes: rowFromOverride(data.dbOverrides.dueSoonThresholdMinutes),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSnapshot]);

  const validation = useValidation(draft);
  const dirty = useMemo(
    () => isDirty(draft, data.dbOverrides),
    [draft, data.dbOverrides],
  );
  const hasErrors = FIELD_ORDER.some((f) => validation[f] != null);

  const onSave = async () => {
    if (!dirty || hasErrors) return;
    const body = buildPatch(draft, data.dbOverrides);
    try {
      await update.mutateAsync({ data: body });
      queryClient.invalidateQueries({ queryKey: getGetOperatorThresholdsQueryKey() });
      toast({ title: "Global thresholds saved" });
    } catch {
      toast({ variant: "destructive", title: "Failed to save thresholds" });
    }
  };

  const onResetAll = () => setDraft(EMPTY_DRAFT);

  return (
    <>
      <section
        className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border"
        data-testid="editor-global"
      >
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
            <FieldRow
              key={f}
              field={f}
              meta={meta}
              effective={eff}
              error={err}
              draftValue={draft[f].value}
              draftRaw={draftRaw}
              lockedByEnv={lockedByEnv}
              dbPlaceholder={dbVal == null ? "—" : String(dbVal)}
              onChange={(v) => setDraft((d) => ({ ...d, [f]: { value: v } }))}
              onClear={() => setDraft((d) => ({ ...d, [f]: { value: "" } }))}
              footer={
                lockedByEnv ? (
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
                )
              }
            />
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
    </>
  );
}

function AreaEditor({
  areaId,
  globalData,
}: {
  areaId: number;
  globalData: OperatorThresholds;
}) {
  const { data, isLoading } = useGetAreaOperatorThresholds(areaId);
  const update = useUpdateAreaOperatorThresholds();
  const clearAll = useClearAreaOperatorThresholds();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Record<FieldKey, DraftRow>>(EMPTY_DRAFT);

  const serverSnapshot = data
    ? `${data.areaOverrides.encouragementMinPercent}|${data.areaOverrides.priorBestWindowDays}|${data.areaOverrides.dueSoonThresholdMinutes}`
    : "";
  useEffect(() => {
    if (!data) return;
    setDraft({
      encouragementMinPercent: rowFromOverride(data.areaOverrides.encouragementMinPercent),
      priorBestWindowDays: rowFromOverride(data.areaOverrides.priorBestWindowDays),
      dueSoonThresholdMinutes: rowFromOverride(data.areaOverrides.dueSoonThresholdMinutes),
    });
    // Reset draft whenever the user picks a different area, otherwise stale
    // edits would leak from one area's editor into the next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSnapshot, areaId]);

  const validation = useValidation(draft);
  const dirty = useMemo(() => {
    if (!data) return false;
    return isDirty(draft, data.areaOverrides);
  }, [draft, data]);
  const hasErrors = FIELD_ORDER.some((f) => validation[f] != null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetOperatorThresholdsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetAreaOperatorThresholdsQueryKey(areaId),
    });
  };

  const onSave = async () => {
    if (!data || !dirty || hasErrors) return;
    const body = buildPatch(draft, data.areaOverrides);
    try {
      await update.mutateAsync({ id: areaId, data: body });
      invalidateAll();
      toast({ title: `Saved overrides for ${data.areaName}` });
    } catch {
      toast({ variant: "destructive", title: "Failed to save area thresholds" });
    }
  };

  const onResetDraft = () => {
    if (!data) return;
    setDraft({
      encouragementMinPercent: rowFromOverride(data.areaOverrides.encouragementMinPercent),
      priorBestWindowDays: rowFromOverride(data.areaOverrides.priorBestWindowDays),
      dueSoonThresholdMinutes: rowFromOverride(data.areaOverrides.dueSoonThresholdMinutes),
    });
  };

  const onClearAllArea = async () => {
    if (!data) return;
    try {
      await clearAll.mutateAsync({ id: areaId });
      invalidateAll();
      toast({ title: `Cleared all overrides for ${data.areaName}` });
    } catch {
      toast({ variant: "destructive", title: "Failed to clear area thresholds" });
    }
  };

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const hasAnyAreaOverride = FIELD_ORDER.some(
    (f) => data.areaOverrides[f] != null,
  );

  return (
    <>
      <section
        className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border"
        data-testid={`editor-area-${areaId}`}
      >
        {FIELD_ORDER.map((f) => {
          const meta = FIELD_META[f];
          const env = data.envOverrides[f];
          const areaVal = data.areaOverrides[f];
          const globalVal = data.globalOverrides[f];
          const dflt = data.defaults[f];
          const eff = data[f];
          const err = validation[f];
          const draftRaw = clean(draft[f].value);
          const lockedByEnv = env != null;
          // Placeholder shows what the input would resolve to if the area
          // override is left blank — the next-layer-down (env > global > default)
          // tagged with "(global)" / "(default)" so the manager knows what
          // they're inheriting.
          let placeholder: string;
          if (lockedByEnv) placeholder = `${env}`;
          else if (globalVal != null) placeholder = `${globalVal} (global)`;
          else placeholder = `${dflt} (default)`;
          return (
            <FieldRow
              key={f}
              field={f}
              meta={meta}
              effective={eff}
              error={err}
              draftValue={draft[f].value}
              draftRaw={draftRaw}
              lockedByEnv={lockedByEnv}
              dbPlaceholder={placeholder}
              dbLabel="Area override (blank = use global)"
              onChange={(v) => setDraft((d) => ({ ...d, [f]: { value: v } }))}
              onClear={() => setDraft((d) => ({ ...d, [f]: { value: "" } }))}
              footer={
                lockedByEnv ? (
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                    <Lock className="w-3 h-3" /> Locked by env: {env} {meta.unit}
                  </span>
                ) : areaVal != null ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <Building2 className="w-3 h-3" /> Area override: {areaVal} {meta.unit}
                  </span>
                ) : globalVal != null ? (
                  <span
                    className="inline-flex items-center gap-1 text-muted-foreground"
                    data-testid={`source-global-${f}`}
                  >
                    <Globe2 className="w-3 h-3" /> Using global: {globalVal} {meta.unit}{" "}
                    <span className="opacity-70">(global)</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3" /> Using default ({dflt} {meta.unit}){" "}
                    <span className="opacity-70">(global)</span>
                  </span>
                )
              }
            />
          );
        })}
      </section>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || hasErrors || update.isPending}
          data-testid="save-area-thresholds"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium bg-primary text-primary-foreground shadow-soft transition-opacity disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {update.isPending ? "Saving…" : "Save area changes"}
        </button>
        <button
          type="button"
          onClick={onResetDraft}
          disabled={!dirty || update.isPending}
          data-testid="reset-area-thresholds"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset to saved
        </button>
        <button
          type="button"
          onClick={onClearAllArea}
          disabled={!hasAnyAreaOverride || clearAll.isPending}
          data-testid="clear-area-thresholds"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <Eraser className="w-3.5 h-3.5" />
          {clearAll.isPending ? "Clearing…" : "Clear all area overrides"}
        </button>
      </div>

      <AreaFootNote data={data} globalData={globalData} />
    </>
  );
}

function FieldRow(props: {
  field: FieldKey;
  meta: (typeof FIELD_META)[FieldKey];
  effective: number;
  error: string | null;
  draftValue: string;
  draftRaw: string;
  lockedByEnv: boolean;
  dbPlaceholder: string;
  dbLabel?: string;
  onChange: (v: string) => void;
  onClear: () => void;
  footer: React.ReactNode;
}) {
  const {
    field: f,
    meta,
    effective: eff,
    error: err,
    draftValue,
    draftRaw,
    lockedByEnv,
    dbPlaceholder,
    dbLabel,
    onChange,
    onClear,
    footer,
  } = props;
  return (
    <div className="px-5 py-5">
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
            {dbLabel ?? `DB override (${meta.unit}, blank = clear)`}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={meta.min}
            max={meta.max}
            step={1}
            disabled={lockedByEnv}
            value={draftValue}
            placeholder={dbPlaceholder}
            data-testid={`input-${f}`}
            onChange={(e) => onChange(e.target.value)}
            className="bg-secondary text-foreground rounded-lg px-3 py-2 h-10 text-[14px] tabular-nums hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-44 disabled:opacity-50"
          />
        </label>

        {draftRaw !== "" && !lockedByEnv && (
          <button
            type="button"
            onClick={onClear}
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

      <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">{footer}</div>
    </div>
  );
}

function useValidation(draft: Record<FieldKey, DraftRow>) {
  return useMemo(() => {
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
}

function isDirty(
  draft: Record<FieldKey, DraftRow>,
  source: { [K in FieldKey]: number | null },
) {
  for (const f of FIELD_ORDER) {
    const current = source[f];
    const next = clean(draft[f].value);
    const nextValue = next === "" ? null : Number(next);
    if (current !== nextValue) return true;
  }
  return false;
}

function buildPatch(
  draft: Record<FieldKey, DraftRow>,
  source: { [K in FieldKey]: number | null },
): Record<string, number | null> {
  const body: Record<string, number | null> = {};
  for (const f of FIELD_ORDER) {
    const current = source[f];
    const raw = clean(draft[f].value);
    const next = raw === "" ? null : Number(raw);
    if (current !== next) body[f] = next;
  }
  return body;
}

function FootNote({ data }: { data: OperatorThresholds }) {
  return (
    <div className="space-y-3" data-testid="thresholds-footnote">
      <LastChangeLine data={data} />
      <AuditHistory entries={data.auditHistory} />
      <p className="text-[12px] text-muted-foreground">
        Precedence: <span className="font-medium">env var</span> &gt;{" "}
        <span className="font-medium">area DB override</span> &gt;{" "}
        <span className="font-medium">global DB override</span> &gt;{" "}
        <span className="font-medium">default</span>. The operator UI and the
        /operator/recent endpoint pick up changes on their next request.
      </p>
    </div>
  );
}

function LastChangeLine({ data }: { data: OperatorThresholds }) {
  if (!data.updatedAt) {
    return (
      <p className="text-[12px] text-muted-foreground" data-testid="thresholds-last-change">
        No DB overrides have been saved yet.
      </p>
    );
  }
  const when = new Date(data.updatedAt).toLocaleString();
  // Prefer the resolved email; fall back to a numeric id only if the user
  // record is gone (e.g. deactivated manager).
  const who =
    data.updatedByUserEmail ??
    (data.updatedByUserId != null ? `user #${data.updatedByUserId}` : null);
  return (
    <p
      className="text-[12.5px] text-muted-foreground inline-flex items-center gap-1.5"
      data-testid="thresholds-last-change"
    >
      <User className="w-3.5 h-3.5" />
      Last changed by{" "}
      <span className="font-medium text-foreground" data-testid="thresholds-last-change-who">
        {who ?? "an unknown manager"}
      </span>{" "}
      on{" "}
      <span className="font-medium text-foreground" data-testid="thresholds-last-change-when">
        {when}
      </span>
      .
    </p>
  );
}

function AreaFootNote({
  data,
  globalData,
}: {
  data: AreaOperatorThresholds;
  globalData: OperatorThresholds;
}) {
  const updated = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString()
    : null;
  const globalUpdated = globalData.updatedAt
    ? new Date(globalData.updatedAt).toLocaleString()
    : null;
  return (
    <p className="text-[12px] text-muted-foreground" data-testid="area-thresholds-footnote">
      Editing <span className="font-medium">{data.areaName}</span>. Each blank
      field falls back to the global value (marked "(global)"), then to the
      shipped default. Precedence: <span className="font-medium">env</span> &gt;{" "}
      <span className="font-medium">area DB</span> &gt;{" "}
      <span className="font-medium">global DB</span> &gt;{" "}
      <span className="font-medium">default</span>.
      {updated ? ` Last area change: ${updated}.` : ""}
      {globalUpdated ? ` Last global change: ${globalUpdated}.` : ""}
    </p>
  );
}

const FIELD_LABEL: Record<string, string> = {
  encouragementMinPercent: "Encouragement chip cutoff",
  priorBestWindowDays: "Prior-best lookback window",
  dueSoonThresholdMinutes: "\"Due soon\" lead time",
};

const FIELD_UNIT: Record<string, string> = {
  encouragementMinPercent: "%",
  priorBestWindowDays: "days",
  dueSoonThresholdMinutes: "minutes",
};

function formatAuditValue(field: string, v: number | null | undefined): string {
  if (v == null) return "default";
  const unit = FIELD_UNIT[field];
  return unit ? `${v} ${unit}` : String(v);
}

function AuditHistory({
  entries,
}: {
  entries: OperatorThresholdAuditEntry[];
}) {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div
      className="bg-card rounded-2xl shadow-soft hairline px-5 py-4"
      data-testid="thresholds-audit-history"
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
            entry.changedByUserEmail ?? `user #${entry.changedByUserId}`;
          const when = new Date(entry.changedAt).toLocaleString();
          return (
            <li
              key={entry.id}
              className="py-2 text-[12.5px] text-muted-foreground flex flex-wrap items-baseline gap-x-2"
              data-testid={`audit-entry-${entry.id}`}
            >
              <span className="font-medium text-foreground">{label}</span>
              <span className="tabular-nums">
                <span data-testid={`audit-entry-${entry.id}-old`}>{oldText}</span>
                {" → "}
                <span
                  className="font-medium text-foreground"
                  data-testid={`audit-entry-${entry.id}-new`}
                >
                  {newText}
                </span>
              </span>
              <span className="ml-auto text-[11.5px]">
                <span data-testid={`audit-entry-${entry.id}-who`}>{who}</span>
                {" · "}
                <span data-testid={`audit-entry-${entry.id}-when`}>{when}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
