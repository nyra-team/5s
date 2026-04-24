import { pgTable, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { areasTable } from "./areas";
import { usersTable } from "./users";

/**
 * Operator → area assignment. Presence of any rows for a given user means the
 * operator's view (home grid, identify-area candidates, submission targets)
 * is scoped to *only* the areas listed here. Absence of rows for a user is
 * the backward-compatible "this operator can see everything" mode — that's
 * deliberate so existing single-line setups keep working without a manager
 * having to fill in assignments for every operator on day one.
 *
 * The composite primary key (user_id, area_id) prevents duplicate
 * assignments and lets the manager UI replace assignments by deleting +
 * inserting in a single transaction.
 */
export const areaAssignmentsTable = pgTable(
  "area_assignments",
  {
    userId: integer("user_id").notNull().references(() => usersTable.id),
    areaId: integer("area_id").notNull().references(() => areasTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.areaId] }),
  })
);

export type AreaAssignment = typeof areaAssignmentsTable.$inferSelect;
