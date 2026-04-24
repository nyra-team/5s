import { pgTable, text, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ENVIRONMENT_TYPES = ["factory", "warehouse", "home"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const areasTable = pgTable("areas", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  environmentType: text("environment_type").notNull().default("factory"),
});

export const insertAreaSchema = createInsertSchema(areasTable, {
  environmentType: z.enum(ENVIRONMENT_TYPES).optional(),
}).omit({ id: true });
export type InsertArea = z.infer<typeof insertAreaSchema>;
export type Area = typeof areasTable.$inferSelect;
