import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// One-time password-reset tokens. A row is inserted whenever a user requests
// a password reset; it carries the random hex `token` (returned in the reset
// URL), the `userId` it grants access to, an `expiresAt` cutoff, and a
// `usedAt` marker that is stamped the first time the token is consumed so
// the same token can't be re-used. Old rows are kept for audit and pruned
// out-of-band — single-row reads by token PK are O(1) regardless of churn.
export const passwordResetTokensTable = pgTable("password_reset_tokens", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
