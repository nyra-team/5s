import {
  db,
  areaSchedulesTable,
  submissionsTable,
  areasTable,
  areaProfilesTable,
} from "@workspace/db";
import { eq, sql, and, gte } from "drizzle-orm";

const DEFAULT_CADENCE_SECONDS = 4 * 60 * 60; // 4h
const MIN_CADENCE_SECONDS = 60 * 60;          // 1h
const MAX_CADENCE_SECONDS = 12 * 60 * 60;     // 12h
const AREA_BASELINE_KEY = ""; // empty machine string == area-level baseline

/** Recompute cadence based on recent failure rate, optionally scoped to one machine. */
export async function recomputeCadence(areaId: number, machine: string | null): Promise<number> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const conds = [eq(submissionsTable.areaId, areaId), gte(submissionsTable.createdAt, since)];
  if (machine) conds.push(eq(submissionsTable.machineTag, machine));
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      fails: sql<number>`sum(case when ${submissionsTable.scoreTotal} * 4 < 60 then 1 else 0 end)::int`,
    })
    .from(submissionsTable)
    .where(and(...conds));

  const total = rows[0]?.total ?? 0;
  const fails = rows[0]?.fails ?? 0;
  const failRate = total > 0 ? fails / total : 0;

  let cadence = Math.round(DEFAULT_CADENCE_SECONDS * (1 - failRate * 0.85));
  cadence = Math.max(MIN_CADENCE_SECONDS, Math.min(MAX_CADENCE_SECONDS, cadence));
  return cadence;
}

async function upsertSchedule(areaId: number, machine: string, cadence: number, when: Date) {
  const next = new Date(when.getTime() + cadence * 1000);
  const existing = await db
    .select()
    .from(areaSchedulesTable)
    .where(and(eq(areaSchedulesTable.areaId, areaId), eq(areaSchedulesTable.machine, machine)));
  if (existing.length === 0) {
    await db.insert(areaSchedulesTable).values({
      areaId,
      machine,
      cadenceSeconds: cadence,
      lastCheckAt: when,
      nextDueAt: next,
    });
  } else {
    await db
      .update(areaSchedulesTable)
      .set({ cadenceSeconds: cadence, lastCheckAt: when, nextDueAt: next, updatedAt: new Date() })
      .where(and(eq(areaSchedulesTable.areaId, areaId), eq(areaSchedulesTable.machine, machine)));
  }
}

/** Record a check: always updates the area baseline; if a machine tag is given, also updates per-machine cadence. */
export async function recordCheck(areaId: number, machineTag: string | null, when: Date = new Date()) {
  const baseline = await recomputeCadence(areaId, null);
  await upsertSchedule(areaId, AREA_BASELINE_KEY, baseline, when);

  if (machineTag && machineTag.trim()) {
    const m = machineTag.trim();
    const cadence = await recomputeCadence(areaId, m);
    await upsertSchedule(areaId, m, cadence, when);
  }
}

interface NextCheckItem {
  areaId: number;
  areaName: string;
  machine: string | null;
  lastCheckAt: string | null;
  nextDueAt: string;
  cadenceSeconds: number;
  overdue: boolean;
  reason: string;
}

export async function getNextChecks(): Promise<NextCheckItem[]> {
  const areas = await db.select().from(areasTable).orderBy(areasTable.id);
  const schedules = await db.select().from(areaSchedulesTable);
  const profiles = await db.select().from(areaProfilesTable);
  const profileByArea = new Map(profiles.map((p) => [p.areaId, p]));
  const now = Date.now();

  const items: NextCheckItem[] = [];

  // Group schedules by area
  const byArea = new Map<number, typeof schedules>();
  for (const s of schedules) {
    const arr = byArea.get(s.areaId) ?? [];
    arr.push(s);
    byArea.set(s.areaId, arr);
  }

  for (const area of areas) {
    const profile = profileByArea.get(area.id);
    const isTrained = profile?.status === "TRAINED";
    const known = byArea.get(area.id) ?? [];
    const baseline = known.find((s) => s.machine === AREA_BASELINE_KEY);
    const machineRows = known.filter((s) => s.machine !== AREA_BASELINE_KEY);

    // Always include an area-level entry
    {
      const cadence = baseline?.cadenceSeconds ?? DEFAULT_CADENCE_SECONDS;
      const last = baseline?.lastCheckAt ?? null;
      const next = baseline?.nextDueAt ?? new Date(0);
      const overdue = next.getTime() <= now;
      let reason: string;
      if (!last) {
        reason = `Never checked — capture a baseline walk-through.`;
      } else {
        const sinceMin = Math.round((now - last.getTime()) / 60000);
        const cadenceHr = Math.round(cadence / 3600);
        const human = sinceMin < 60 ? `${sinceMin} min ago` : `${Math.round(sinceMin / 60)}h ago`;
        reason = overdue
          ? `Normally checked every ${cadenceHr}h — last check ${human}.`
          : `Last check ${human}, next due in ${Math.round((next.getTime() - now) / 60000)} min.`;
      }
      items.push({
        areaId: area.id,
        areaName: area.name,
        machine: null,
        lastCheckAt: last ? last.toISOString() : null,
        nextDueAt: next.toISOString(),
        cadenceSeconds: cadence,
        overdue,
        reason,
      });
    }

    // Per-machine entries (only meaningful once area is trained — operators get
    // pinpointed reminders for known equipment instead of generic area pings).
    if (isTrained) {
      for (const row of machineRows) {
        const cadence = row.cadenceSeconds;
        const last = row.lastCheckAt;
        const next = row.nextDueAt ?? new Date(0);
        const overdue = next.getTime() <= now;
        let reason: string;
        if (!last) {
          reason = `Newly tracked machine — capture a first walk-through.`;
        } else {
          const sinceMin = Math.round((now - last.getTime()) / 60000);
          const cadenceHr = Math.round(cadence / 3600);
          const human = sinceMin < 60 ? `${sinceMin} min ago` : `${Math.round(sinceMin / 60)}h ago`;
          reason = overdue
            ? `${row.machine} normally checked every ${cadenceHr}h — last check ${human}.`
            : `${row.machine} last checked ${human}, next due in ${Math.round((next.getTime() - now) / 60000)} min.`;
        }
        items.push({
          areaId: area.id,
          areaName: area.name,
          machine: row.machine,
          lastCheckAt: last ? last.toISOString() : null,
          nextDueAt: next.toISOString(),
          cadenceSeconds: cadence,
          overdue,
          reason,
        });
      }
    }
  }

  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return new Date(a.nextDueAt).getTime() - new Date(b.nextDueAt).getTime();
  });

  return items;
}
