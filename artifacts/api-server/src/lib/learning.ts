import { db, areaProfilesTable, areaSchedulesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { VLMProfileExtract } from "./ai-scoring.js";
import { recomputeCadence } from "./schedule.js";

export const TRAINING_THRESHOLD = 5;

function mergeStrings(existing: string[], incoming: string[], cap = 25): string[] {
  const seen = new Map<string, string>();
  for (const item of [...existing, ...incoming]) {
    const norm = item.trim();
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (!seen.has(key)) seen.set(key, norm);
  }
  return Array.from(seen.values()).slice(0, cap);
}

export async function getOrCreateProfile(areaId: number) {
  const [existing] = await db
    .select()
    .from(areaProfilesTable)
    .where(eq(areaProfilesTable.areaId, areaId));
  if (existing) return existing;
  const [created] = await db
    .insert(areaProfilesTable)
    .values({ areaId })
    .returning();
  return created;
}

export async function ingestProfileExtract(
  areaId: number,
  extract: VLMProfileExtract
) {
  const profile = await getOrCreateProfile(areaId);
  const newCount = (profile.submissionsCount ?? 0) + 1;
  const items = mergeStrings((profile.itemsJson as string[]) ?? [], extract.items, 25);
  const machines = mergeStrings((profile.machinesJson as string[]) ?? [], extract.machines, 15);
  const layout = mergeStrings((profile.layoutJson as string[]) ?? [], extract.layout, 10);
  const issues = mergeStrings((profile.commonIssuesJson as string[]) ?? [], extract.observedIssues, 10);
  const status = newCount >= TRAINING_THRESHOLD ? "TRAINED" : "LEARNING";
  // Stamp trainedAt the moment we flip LEARNING -> TRAINED. Once stamped we
  // leave it alone so subsequent ingests don't overwrite the original date.
  const justTrained = status === "TRAINED" && profile.status !== "TRAINED";
  const trainedAt = justTrained ? new Date() : profile.trainedAt;

  const [updated] = await db
    .update(areaProfilesTable)
    .set({
      submissionsCount: newCount,
      itemsJson: items,
      machinesJson: machines,
      layoutJson: layout,
      commonIssuesJson: issues,
      summary: extract.summary || profile.summary,
      status,
      trainedAt,
      updatedAt: new Date(),
    })
    .where(eq(areaProfilesTable.areaId, areaId))
    .returning();

  // Once trained, proactively seed per-machine schedule rows for any machine
  // the VLM has identified — operators get pinpointed reminders without needing
  // to wait for someone to manually tag a submission first.
  if (status === "TRAINED" && machines.length > 0) {
    await seedMachineSchedules(areaId, machines);
  }

  return updated;
}

/** Insert a baseline schedule row (cadence only, not yet checked) for any
 *  learned machine that has no row yet. Existing rows are left untouched so
 *  recordCheck() retains its history. */
async function seedMachineSchedules(areaId: number, machines: string[]) {
  const existing = await db
    .select({ machine: areaSchedulesTable.machine })
    .from(areaSchedulesTable)
    .where(eq(areaSchedulesTable.areaId, areaId));
  const known = new Set(existing.map((r) => r.machine));

  for (const m of machines) {
    const name = m.trim();
    if (!name || known.has(name)) continue;
    const cadence = await recomputeCadence(areaId, name);
    // No prior check for this machine yet — set nextDueAt to now so it shows
    // up at the top of the operator's "Next checks" list as a fresh prompt.
    const now = new Date();
    await db
      .insert(areaSchedulesTable)
      .values({
        areaId,
        machine: name,
        cadenceSeconds: cadence,
        lastCheckAt: null,
        nextDueAt: now,
      })
      .onConflictDoNothing({
        target: [areaSchedulesTable.areaId, areaSchedulesTable.machine],
      });
  }
}
