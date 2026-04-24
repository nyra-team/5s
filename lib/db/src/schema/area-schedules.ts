import { pgTable, integer, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";

/**
 * Per-area and per-machine cadence schedule. A row with `machine = ''` represents
 * the area-level baseline. Per-machine rows (machine != '') are added once the
 * area's profile is TRAINED so operators get pinpointed reminders.
 */
export const areaSchedulesTable = pgTable(
  "area_schedules",
  {
    areaId: integer("area_id").notNull().references(() => areasTable.id),
    machine: text("machine").notNull().default(""),
    cadenceSeconds: integer("cadence_seconds").notNull().default(14400),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.areaId, t.machine] }),
  })
);

export const insertAreaScheduleSchema = createInsertSchema(areaSchedulesTable).omit({ updatedAt: true });
export type InsertAreaSchedule = z.infer<typeof insertAreaScheduleSchema>;
export type AreaSchedule = typeof areaSchedulesTable.$inferSelect;
