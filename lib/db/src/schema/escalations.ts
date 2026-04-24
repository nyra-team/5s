import { pgTable, text, serial, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { usersTable } from "./users";
import { submissionsTable } from "./submissions";

export const escalationsTable = pgTable("escalations", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => submissionsTable.id),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  operatorId: integer("operator_id").notNull().references(() => usersTable.id),
  scoreTotal: integer("score_total").notNull(),
  scorePercent: integer("score_percent").notNull(),
  failingPillarsJson: jsonb("failing_pillars_json").notNull().default([]),
  recommendedActionsJson: jsonb("recommended_actions_json").notNull().default([]),
  evidenceUrlsJson: jsonb("evidence_urls_json").notNull().default([]),
  status: text("status").notNull().default("OPEN"),
  ackedByUserId: integer("acked_by_user_id").references(() => usersTable.id),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  resolvedByUserId: integer("resolved_by_user_id").references(() => usersTable.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Stamped after we've made our best-effort attempt to send the email/Slack
  // notification (or explicitly logged it as undeliverable). Rows where this
  // is NULL are scanned at startup so an API restart mid-grouping-window
  // doesn't silently swallow manager alerts.
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  // Tracks the *outcome* of the notify attempt that stamped `notifiedAt`.
  // NULL alongside a NULL `notifiedAt` means dispatch hasn't happened yet.
  // Known values:
  //   "DELIVERED"                — providers were attempted (Slack/Resend);
  //                                individual provider failures are logged but
  //                                we still mark delivered to avoid re-pinging
  //                                on every restart.
  //   "SKIPPED_RECOVERY_WINDOW"  — the startup recovery sweep found this row
  //                                older than the recovery window and gave up
  //                                on dispatching it, stamping `notifiedAt` so
  //                                it stops being re-scanned. Surfaced in the
  //                                manager UI as a "delivery skipped" badge.
  //   "NO_PROVIDER_CONFIGURED"   — dispatch ran but no notification channel
  //                                could carry the alert: either neither
  //                                Slack nor Resend is configured at all, or
  //                                every targeted manager only had channels
  //                                enabled whose providers are missing.
  //                                Surfaced in the manager UI as a "no
  //                                channel configured" badge so the inbox
  //                                doesn't pretend the alert went out.
  notifyDeliveryStatus: text("notify_delivery_status"),
  repingCount: integer("reping_count").notNull().default(0),
  lastRepingAt: timestamp("last_reping_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEscalationSchema = createInsertSchema(escalationsTable).omit({ id: true, createdAt: true });
export type InsertEscalation = z.infer<typeof insertEscalationSchema>;
export type Escalation = typeof escalationsTable.$inferSelect;
