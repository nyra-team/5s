import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOperatorRecent,
  getGetOperatorStatusQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";

function scoreTone(percent: number) {
  if (percent >= 80)
    return {
      text: "text-emerald-700 dark:text-emerald-300",
      bg: "bg-emerald-50 dark:bg-emerald-500/15",
    };
  if (percent >= 60)
    return {
      text: "text-amber-700 dark:text-amber-300",
      bg: "bg-amber-50 dark:bg-amber-500/15",
    };
  return {
    text: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-500/15",
  };
}

const SCORING_FAILURE_MODES = new Set([
  "FALLBACK",
  "VIDEO_UNREADABLE",
  "FRAMES_TOO_DARK",
  "AI_RATE_LIMITED",
  "AI_TIMEOUT",
  "AI_MALFORMED",
]);

function failureDescription(mode: string | null | undefined): string {
  switch (mode) {
    case "VIDEO_UNREADABLE":
      return "We couldn't read your video. Try a shorter walk-through or a still photo.";
    case "FRAMES_TOO_DARK":
      return "Capture was too dark to grade. Turn on more light and try again.";
    case "AI_RATE_LIMITED":
      return "Scoring is rate-limited right now. Wait a minute and try again.";
    case "AI_TIMEOUT":
      return "Scoring timed out. Try again — a smaller capture usually helps.";
    case "AI_MALFORMED":
      return "Model returned an unusable response. Try again — usually transient.";
    default:
      return "Re-upload with brighter lighting and a steadier angle.";
  }
}

/**
 * Watches the operator's recent submissions for the `PENDING` → scored
 * transition and fires a bottom-right toast as soon as a background scoring
 * job finishes, regardless of which screen in the operator app they're on.
 *
 * Mounted once at the App shell. The polling query reuses the operator's
 * existing /operator/recent endpoint so we don't add a new endpoint or
 * regenerate the orval client; the trade-off is a short polling cadence
 * while a submission is in flight.
 */
export function useScoringCompletionToasts() {
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useGetOperatorRecent(
    { limit: 12 },
    {
      query: {
        enabled: isOperator,
        // Poll fast enough that the operator's wait between "Submitted" and
        // "Scoring completed" toasts feels responsive (~5s upper bound) but
        // not so fast that we pound the API while idle. The query stays
        // mounted for the whole authenticated session.
        refetchInterval: isOperator ? 5_000 : false,
        refetchIntervalInBackground: false,
      },
    },
  );

  // submissionId -> last-seen scoringMode. We compare each poll against this
  // so we only fire on the PENDING→scored edge, not every time we see a
  // scored row in the list.
  const lastSeenMode = useRef<Map<number, string | null>>(new Map());
  // Whether we've populated lastSeenMode from at least one server response.
  // The very first response is just baseline state — firing toasts for it
  // would surface a "Scoring completed" for every recent audit on cold load.
  const initialized = useRef(false);

  useEffect(() => {
    if (!isOperator || !data) return;

    const next = new Map<number, string | null>();
    const completed: Array<{
      id: number;
      areaName: string;
      scoreTotal: number;
      scoringMode: string | null;
    }> = [];

    for (const row of data) {
      const mode = (row.scoringMode as string | null | undefined) ?? null;
      next.set(row.id, mode);

      if (!initialized.current) continue;

      const prev = lastSeenMode.current.get(row.id);
      // Only a PENDING→non-PENDING transition counts. A row that appears
      // for the first time already scored (e.g. a peer's submission we
      // somehow see) doesn't fire — that's not "your" completion.
      if (prev === "PENDING" && mode !== "PENDING") {
        completed.push({
          id: row.id,
          areaName: row.areaName,
          scoreTotal: row.scoreTotal,
          scoringMode: mode,
        });
      }
    }

    lastSeenMode.current = next;
    if (!initialized.current) {
      initialized.current = true;
      return;
    }

    for (const c of completed) {
      if (c.scoringMode && SCORING_FAILURE_MODES.has(c.scoringMode)) {
        toast({
          variant: "destructive",
          title: `${c.areaName} — couldn't be scored`,
          description: failureDescription(c.scoringMode),
          duration: 12_000,
        });
      } else {
        const percent = Math.round(c.scoreTotal * 4);
        const tone = scoreTone(percent);
        toast({
          title: `Scoring completed — ${percent}%`,
          description: c.areaName,
          className: `${tone.bg} ${tone.text} border-transparent`,
          duration: 12_000,
        });
      }
    }

    // The area-card grid and the "next checks" panel read separate queries
    // that don't auto-poll, so refresh them when scoring lands. The
    // /operator/recent query that drove this effect is already fresh.
    if (completed.length > 0) {
      queryClient.invalidateQueries({ queryKey: getGetOperatorStatusQueryKey() });
    }
  }, [data, isOperator, toast, queryClient]);
}
