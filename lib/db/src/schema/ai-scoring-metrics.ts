import { pgTable, serial, text, boolean, timestamp, integer, index } from "drizzle-orm/pg-core";

// Append-only log of VLM call attempts. One row per `callVLM()` invocation
// inside the AI scoring pipeline AND per `callIdentificationVLM()` invocation
// inside the AI identification pipeline (`callKind` distinguishes them).
//
// We use it for two related things on the manager dashboard:
//  - retry rate (how often the model's first response failed our JSON shape
//    check and we had to spend a second API call) — surfaces model misbehavior
//    that doubles per-audit cost;
//  - per-model latency + token usage rollups — lets managers sanity-check the
//    cost/time impact of upgrading the underlying model (e.g. gpt-5-mini → gpt-5)
//    by comparing rows attributed to the old and new `modelVersion` strings.
//
// All fields beyond modelVersion/retried/createdAt are nullable so older rows
// (written before we captured latency / token usage) and the identification
// path's first writes (which don't go through the JSON-validation retry loop)
// stay valid.
export const aiScoringMetricsTable = pgTable(
  "ai_scoring_metrics",
  {
    id: serial("id").primaryKey(),
    modelVersion: text("model_version").notNull(),
    // True iff the first response failed validateVlmJson and we issued a
    // second call. False on a clean first-try response. Identification rows
    // (which don't have a JSON-validation retry loop) always set this false.
    retried: boolean("retried").notNull(),
    // The validation message that triggered the retry, if any. Capped at
    // ~500 chars by the writer so a verbose model error can't bloat the row.
    validationError: text("validation_error"),
    // What kind of model call this row represents. "scoring" = the rubric
    // pass via callVLM(); "identification" = the area-detection pass via
    // callIdentificationVLM(). Defaults to "scoring" so historical rows
    // (written before identification was instrumented) classify correctly.
    callKind: text("call_kind").notNull().default("scoring"),
    // Wall-clock duration of the chat.completions call(s), in milliseconds.
    // For scoring rows where `retried=true` this is the SUM of both attempts
    // — one row per callVLM() invocation, regardless of whether we retried.
    // Nullable for legacy rows written before timing was captured.
    latencyMs: integer("latency_ms"),
    // Token usage as reported by the model proxy's `response.usage`. Summed
    // across both attempts for retried scoring rows. Nullable when the
    // proxy didn't include a usage object on the response.
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Indexed for the time-window aggregates the dashboard runs.
    createdAtIdx: index("ai_scoring_metrics_created_at_idx").on(t.createdAt),
  }),
);

export type AiScoringMetric = typeof aiScoringMetricsTable.$inferSelect;
export type InsertAiScoringMetric = typeof aiScoringMetricsTable.$inferInsert;
