import { pgTable, text, serial, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("OPERATOR"),
  // Optional human-readable name shown in the UI in place of the email's
  // local-part (e.g. on the manager's "Dismissed by …" chip). Nullable so
  // existing rows and self-signups that never set a name keep working —
  // surfaces fall back to the email-local-part when this is unset.
  displayName: text("display_name"),
  // Notification preferences. Only consulted for MANAGER users today, but kept
  // on the base users table so we can extend to operator-facing notifications
  // later without a second migration. Email defaults on for managers because
  // they already gave us their address; Slack defaults off because it requires
  // a channel webhook to be configured server-side.
  notifyEmailEnabled: boolean("notify_email_enabled").notNull().default(true),
  notifySlackEnabled: boolean("notify_slack_enabled").notNull().default(false),
  // Quiet hours window — interpreted in IST (UTC+5:30). When `enabled` is true
  // and the current IST time falls inside the window on a weekday whose bit is
  // set in the mask, the recipient is treated as inactive: their email is
  // skipped, and Slack is only posted if at least one *other* subscriber is
  // currently active. Times are stored as 24h "HH:MM" strings. The window may
  // wrap midnight (e.g. 22:00–07:00 for night shift). The weekday mask is a
  // 7-bit field where bit 0 = Sunday … bit 6 = Saturday (matching
  // JavaScript's Date#getDay), defaulting to 127 (all days).
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(false),
  quietHoursStart: text("quiet_hours_start").notNull().default("22:00"),
  quietHoursEnd: text("quiet_hours_end").notNull().default("07:00"),
  quietHoursWeekdayMask: integer("quiet_hours_weekday_mask").notNull().default(127),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
