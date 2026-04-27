import {
  useGetAiSettings,
  useUpdateAiSettings,
  getGetAiSettingsQueryKey,
  AiSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  RotateCcw,
  Save,
  Lock,
  Database,
  CheckCircle2,
  AlertTriangle,
  History,
  User,
  Eraser,
} from "lucide-react";

const VLM_MODEL_MAX_LENGTH = 128;

const PRESETS: { id: string; label: string; hint: string }[] = [
  { id: "gpt-5-mini", label: "gpt-5-mini", hint: "Default" },
  { id: "gpt-5", label: "gpt-5", hint: "Flagship" },
];

function clean(s: string): string {
  return s.trim();
}

function validate(raw: string): string | null {
  if (raw === "") return null;
  if (raw.length > VLM_MODEL_MAX_LENGTH) {
    return `Must be at most ${VLM_MODEL_MAX_LENGTH} characters`;
  }
  return null;
}

export default function AiSettingsPage() {
  const { data, isLoading } = useGetAiSettings();
  const update = useUpdateAiSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Empty draft = no DB override (matches operator-thresholds idiom).
  const [draft, setDraft] = useState<string>("");

  const dbSnapshot = data?.dbOverrides.vlmModel ?? "";
  useEffect(() => {
    setDraft(dbSnapshot);
  }, [dbSnapshot]);

  const error = useMemo(() => validate(clean(draft)), [draft]);
  const dirty = useMemo(() => clean(draft) !== (dbSnapshot ?? ""), [
    draft,
    dbSnapshot,
  ]);

  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-primary"></div>
      </div>
    );
  }

  const env = data.envOverrides.vlmModel;
  const dbVal = data.dbOverrides.vlmModel;
  const dflt = data.defaults.vlmModel;
  const eff = data.vlmModel;
  const lockedByEnv = env != null;
  const draftRaw = clean(draft);

  const onSave = async () => {
    if (!dirty || error) return;
    const next = draftRaw === "" ? null : draftRaw;
    try {
      await update.mutateAsync({ data: { vlmModel: next } });
      queryClient.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() });
      toast({
        title:
          next == null
            ? "Cleared model override (using default)"
            : `Model override saved: ${next}`,
      });
    } catch {
      toast({ variant: "destructive", title: "Failed to save model override" });
    }
  };

  const onResetDraft = () => setDraft(dbSnapshot);
  const onClearDraft = () => setDraft("");

  return (
    <div className="space-y-8 max-w-2xl">
      <header className="space-y-2">
        <p className="eyebrow inline-flex items-center gap-1.5">
          <Bot className="w-3 h-3" /> AI model
        </p>
        <h1 className="text-[34px] font-semibold tracking-tight leading-tight">
          AI vision model
        </h1>
        <p className="text-muted-foreground text-[15px]">
          Choose which model the scoring and identification calls use.
          Changes take effect on the next request without a restart.
          Use this to quickly switch (e.g. up to <span className="font-mono">gpt-5</span>)
          if the default model regresses.
        </p>
      </header>

      <section
        className="bg-card rounded-2xl shadow-soft hairline divide-y divide-border"
        data-testid="editor-ai-settings"
      >
        <div className="px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[15px] font-medium tracking-tight">VLM model id</p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">
                The model id sent to the OpenAI proxy for both scoring and
                identification. The submission's <span className="font-mono">modelVersion</span>{" "}
                tag tracks this value automatically.
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Effective
              </p>
              <p
                className="text-[18px] font-semibold tabular-nums font-mono"
                data-testid="effective-vlmModel"
              >
                {eff}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted-foreground">
                DB override (blank = clear, falls back to env / default)
              </span>
              <input
                type="text"
                disabled={lockedByEnv}
                value={draft}
                placeholder={dbVal ?? "—"}
                maxLength={VLM_MODEL_MAX_LENGTH}
                data-testid="input-vlmModel"
                onChange={(e) => setDraft(e.target.value)}
                className="bg-secondary text-foreground rounded-lg px-3 py-2 h-10 text-[14px] font-mono hairline focus:outline-none focus:ring-2 focus:ring-primary/40 w-full max-w-md disabled:opacity-50"
              />
            </label>
            {!lockedByEnv && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setDraft(p.id)}
                    data-testid={`preset-${p.id}`}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-mono transition-colors ${
                      draftRaw === p.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-foreground hover:bg-secondary/80"
                    }`}
                    title={p.hint}
                  >
                    {p.label}
                    <span className="opacity-60 font-sans">· {p.hint}</span>
                  </button>
                ))}
                {draftRaw !== "" && (
                  <button
                    type="button"
                    onClick={onClearDraft}
                    data-testid="clear-vlmModel"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    <Eraser className="w-3 h-3" /> Clear
                  </button>
                )}
              </div>
            )}
          </div>

          {error && (
            <p
              className="mt-2 inline-flex items-center gap-1 text-[12px] text-rose-700 dark:text-rose-300"
              data-testid="error-vlmModel"
            >
              <AlertTriangle className="w-3 h-3" /> {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-3 text-[11.5px]">
            {lockedByEnv ? (
              <span
                className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"
                title="The VLM_MODEL environment variable on the API is overriding both the DB value and the default."
              >
                <Lock className="w-3 h-3" /> Locked by env:{" "}
                <span className="font-mono">{env}</span>
              </span>
            ) : dbVal != null ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                <Database className="w-3 h-3" /> DB override:{" "}
                <span className="font-mono">{dbVal}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <CheckCircle2 className="w-3 h-3" /> Using default (
                <span className="font-mono">{dflt}</span>)
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || !!error || update.isPending || lockedByEnv}
          data-testid="save-ai-settings"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium bg-primary text-primary-foreground shadow-soft transition-opacity disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {update.isPending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onResetDraft}
          disabled={!dirty || update.isPending}
          data-testid="reset-ai-settings"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" /> Reset to saved
        </button>
      </div>

      <FootNote data={data} />
    </div>
  );
}

function FootNote({ data }: { data: AiSettings }) {
  return (
    <div className="space-y-3" data-testid="ai-settings-footnote">
      <p className="text-[12px] text-muted-foreground inline-flex items-center gap-1.5">
        <History className="w-3 h-3" />
        {data.updatedAt
          ? `DB override last updated ${new Date(data.updatedAt).toLocaleString()}`
          : "No DB override stored yet."}
        {data.updatedByUserEmail && (
          <>
            <span className="opacity-50">·</span>
            <User className="w-3 h-3" /> {data.updatedByUserEmail}
          </>
        )}
      </p>
      <p className="text-[11.5px] text-muted-foreground">
        Resolution order: <span className="font-mono">VLM_MODEL</span> env var
        (locks the value) → DB override above → shipped default (
        <span className="font-mono">{data.defaults.vlmModel}</span>). Affects
        both the scoring and identification calls.
      </p>
    </div>
  );
}
