import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row table holding the admin-tunable VLM model id (singleton, lowest
 * id wins). NULL `vlmModel` = no DB override; resolver falls through.
 */
export const aiSettingsTable = pgTable("ai_settings", {
  id: serial("id").primaryKey(),
  vlmModel: text("vlm_model"),
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AiSettingsRow = typeof aiSettingsTable.$inferSelect;
