import { pgTable, serial, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Append-only log of VLM call attempts. One row per `callVLM()` invocation
// inside the AI scoring pipeline. We use it to surface how often the model's
// first response failed our JSON shape check and we had to spend a second
// API call retrying it — a high retry rate means the model is misbehaving
// (and we're paying ~2x per audit). The dashboard reads aggregates over the
// last 24h / 7d from this table; we never read individual rows from the UI.
export const aiScoringMetricsTable = pgTable(
  "ai_scoring_metrics",
  {
    id: serial("id").primaryKey(),
    modelVersion: text("model_version").notNull(),
    // True iff the first response failed validateVlmJson and we issued a
    // second call. False on a clean first-try response.
    retried: boolean("retried").notNull(),
    // The validation message that triggered the retry, if any. Capped at
    // ~500 chars by the writer so a verbose model error can't bloat the row.
    validationError: text("validation_error"),
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
