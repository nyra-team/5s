import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { areasTable } from "./areas";
import { submissionsTable } from "./submissions";
import { usersTable } from "./users";

// Audit table for the structured drift / correction events that previously
// only landed in application logs (kind="area-detection-drift" /
// "area-detection-correction"). Persisting them as rows lets the
// auto-retune loop and the dashboard query them without scraping logs.
//
// kind values:
//   - "DRIFT"      : the chosen area differed from the operator's tapped area.
//   - "CORRECTION" : the operator overrode the AI's top suggestion.
// A single submission can produce both rows when both conditions hold.
export const areaDetectionEventsTable = pgTable(
  "area_detection_events",
  {
    id: serial("id").primaryKey(),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submissionsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    // The area the submission was ultimately saved against.
    areaId: integer("area_id")
      .notNull()
      .references(() => areasTable.id),
    // The area the operator originally tapped (intent). Nullable when the
    // client didn't send it (legacy build).
    tappedAreaId: integer("tapped_area_id").references(() => areasTable.id),
    // The AI's top-confidence suggestion at the moment of submission, when known.
    aiSuggestedAreaId: integer("ai_suggested_area_id").references(() => areasTable.id),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-area window queries (the auto-retune loop and the dashboard drill-down).
    areaCreatedIdx: index("area_detection_events_area_created_idx").on(t.areaId, t.createdAt),
    submissionIdx: index("area_detection_events_submission_idx").on(t.submissionId),
  }),
);

export const insertAreaDetectionEventSchema = createInsertSchema(areaDetectionEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAreaDetectionEvent = z.infer<typeof insertAreaDetectionEventSchema>;
export type AreaDetectionEvent = typeof areaDetectionEventsTable.$inferSelect;

export const AREA_DETECTION_EVENT_KIND = {
  DRIFT: "DRIFT",
  CORRECTION: "CORRECTION",
} as const;
export type AreaDetectionEventKind =
  (typeof AREA_DETECTION_EVENT_KIND)[keyof typeof AREA_DETECTION_EVENT_KIND];
