import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";

export const idealPhotosTable = pgTable("ideal_photos", {
  id: serial("id").primaryKey(),
  areaId: integer("area_id").notNull().references(() => areasTable.id),
  imageUrl: text("image_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertIdealPhotoSchema = createInsertSchema(idealPhotosTable).omit({ id: true, createdAt: true });
export type InsertIdealPhoto = z.infer<typeof insertIdealPhotoSchema>;
export type IdealPhoto = typeof idealPhotosTable.$inferSelect;
