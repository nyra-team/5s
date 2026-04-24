import { pgTable, text, serial, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ENVIRONMENT_TYPES = ["factory", "warehouse", "home", "corporate_office"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

export const areasTable = pgTable("areas", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  environmentType: text("environment_type").notNull().default("factory"),
  // Per-area override of the environment-specific walk-through hint bullets
  // shown to operators in the capture sheet. NULL means "use the default for
  // this area's environmentType" (the hard-coded list in
  // artifacts/five-s/src/lib/environment.tsx). A non-empty array of strings
  // is the manager's custom override. Empty arrays are not stored — the API
  // normalizes `[]` to NULL on write so the contract stays consistent with
  // the render rule (override is only applied when non-empty).
  walkthroughHintsOverrideJson: jsonb("walkthrough_hints_override_json").$type<string[] | null>(),
});

export const insertAreaSchema = createInsertSchema(areasTable, {
  environmentType: z.enum(ENVIRONMENT_TYPES).optional(),
  walkthroughHintsOverrideJson: z.array(z.string()).nullable().optional(),
}).omit({ id: true });
export type InsertArea = z.infer<typeof insertAreaSchema>;
export type Area = typeof areasTable.$inferSelect;
