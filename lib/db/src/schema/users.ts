import { pgTable, text, serial, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("OPERATOR"),
  // Notification preferences. Only consulted for MANAGER users today, but kept
  // on the base users table so we can extend to operator-facing notifications
  // later without a second migration. Email defaults on for managers because
  // they already gave us their address; Slack defaults off because it requires
  // a channel webhook to be configured server-side.
  notifyEmailEnabled: boolean("notify_email_enabled").notNull().default(true),
  notifySlackEnabled: boolean("notify_slack_enabled").notNull().default(false),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
