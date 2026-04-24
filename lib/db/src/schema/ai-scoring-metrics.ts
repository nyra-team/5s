import { pgTable, serial, text, boolean, timestamp, integer, index } from "drizzle-orm/pg-core";

// Append-only log of VLM call attempts. One row per `callVLM()` invocation
// inside the AI scoring pipeline AND per `callIdentificationVLM()` invocation
// inside the AI identification pipeline (`callKind` distinguishes them).
//
// We use the table for two related things on the manager dashboard:
//  - retry rate / outcome breakdown (Task #203): how often the model's
//    response failed our JSON-shape check, got rate-limited, or timed out.
//    The wider `jsonAttempts` / `transientAttempts` / `outcome` counters
//    let on-call tell *why* a call retried — JSON-shape miss vs 429 vs
//    per-attempt timeout — instead of a single boolean.
//  - per-model latency + token usage rollups (Task #166): managers can
//    sanity-check the cost/time impact of upgrading the underlying model
//    (e.g. gpt-5-mini → gpt-5) by comparing rows attributed to the old and
//    new `modelVersion` strings.
//
// Compatibility:
//  - Reliability columns (`jsonAttempts`, `transientAttempts`, `outcome`)
//    carry NOT NULL defaults so identification-path writes (which don't go
//    through the JSON-validation retry loop) and historical rows backfilled
//    by drizzle push keep working without code changes.
//  - Cost/latency columns (`latencyMs`, `promptTokens`, `completionTokens`,
//    `totalTokens`) and `elapsedMs` are nullable for legacy rows written
//    before timing/usage was captured.
export const aiScoringMetricsTable = pgTable(
  "ai_scoring_metrics",
  {
    id: serial("id").primaryKey(),
    modelVersion: text("model_version").notNull(),
    // True iff ANY retry happened — JSON-validation retry OR transient retry.
    // Kept as the dashboard's "did this call cost us extra" flag so the
    // existing rolling-window aggregate doesn't have to migrate. Identification
    // rows (which don't have a JSON-validation retry loop) always set this false.
    retried: boolean("retried").notNull(),
    // The validation message that triggered the FIRST retry (JSON or transient),
    // if any. Capped at ~500 chars by the writer so a verbose model error
    // can't bloat the row.
    validationError: text("validation_error"),
    // How many attempts the JSON-validation retry loop made before either
    // accepting a response or giving up. 1 = clean first try (no JSON retry).
    // Bounded by MAX_JSON_ATTEMPTS in ai-scoring.ts.
    jsonAttempts: integer("json_attempts").notNull().default(1),
    // How many attempts the transient retry loop made *across all JSON
    // attempts*. Includes the initial call. 1 = first call succeeded with no
    // 429/5xx/network/timeout retry. Bounded by MAX_TRANSIENT_RETRIES + 1.
    transientAttempts: integer("transient_attempts").notNull().default(1),
    // Final outcome of the call. One of: "success", "malformed",
    // "rate_limited", "timeout", "transient_failure". The bucket the
    // operator-visible toast was derived from.
    outcome: text("outcome").notNull().default("success"),
    // Wall-clock duration of the entire callVLM() invocation in
    // milliseconds, including all transient/JSON retries AND non-network
    // work (JSON parse, validation, accumulation). Nullable for historical
    // rows written before the column existed.
    elapsedMs: integer("elapsed_ms"),
    // What kind of model call this row represents. "scoring" = the rubric
    // pass via callVLM(); "identification" = the area-detection pass via
    // callIdentificationVLM(). Defaults to "scoring" so historical rows
    // (written before identification was instrumented) classify correctly.
    callKind: text("call_kind").notNull().default("scoring"),
    // Wall-clock duration of the chat.completions call(s) only, in
    // milliseconds. Summed across all transient + JSON-retry attempts for
    // a single callVLM(). This is strictly the time the model proxy held
    // the request (smaller than `elapsedMs`, which also covers our local
    // bookkeeping). Nullable for legacy rows.
    latencyMs: integer("latency_ms"),
    // Token usage as reported by the model proxy's `response.usage`. Summed
    // across every attempt the call made. Nullable when the proxy didn't
    // include a usage object on the response.
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
