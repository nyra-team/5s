import { Router, type IRouter } from "express";
import { sql, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  operatorSettingsTable,
  operatorSettingsAuditTable,
  areaOperatorSettingsTable,
  areasTable,
  usersTable,
} from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import {
  DEFAULT_OPERATOR_THRESHOLDS,
  THRESHOLD_VALIDATORS,
  getDbOperatorThresholds,
  getEnvOperatorThresholds,
  getAllAreaOperatorThresholds,
  getDbAreaOperatorThresholds,
  resolveOperatorThresholds,
  loadEffectiveOperatorThresholds,
  type ThresholdSources,
} from "../lib/operator-thresholds.js";
import { pruneOperatorSettingsAudit } from "../lib/audit-prune.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const THRESHOLD_FIELDS = [
  "encouragementMinPercent",
  "priorBestWindowDays",
  "dueSoonThresholdMinutes",
] as const;
type ThresholdField = (typeof THRESHOLD_FIELDS)[number];

/** How many rows to surface on the admin page. */
const AUDIT_HISTORY_LIMIT = 5;

interface AuditEntry {
  id: number;
  changedAt: string;
  changedByUserId: number | null;
  changedByUserEmail: string | null;
  field: string;
  oldValue: number | null;
  newValue: number | null;
}

interface AreaOverrideEntry extends ThresholdSources {
  areaId: number;
  areaName: string;
  updatedAt: string | null;
  updatedByUserId: number | null;
}

interface ThresholdsPayload {
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  dueSoonThresholdMinutes: number;
  defaults: typeof DEFAULT_OPERATOR_THRESHOLDS;
  envOverrides: ThresholdSources;
  dbOverrides: ThresholdSources;
  updatedAt: string | null;
  updatedByUserId: number | null;
  updatedByUserEmail: string | null;
  auditHistory: AuditEntry[];
  /**
   * Every per-area override row we know about, joined with the area name so
   * the admin UI can render an area selector + provenance markers without a
   * second round-trip. Areas with no override row are simply absent.
   */
  areaOverrides: AreaOverrideEntry[];
}

async function loadAuditHistory(): Promise<AuditEntry[]> {
  // Pull the most recent N rows, then resolve user emails in a single
  // follow-up query keyed by the distinct ids we actually need. We don't
  // join in SQL because the audit row is intentionally append-only and
  // we want the email lookup tolerant of deleted users.
  const rows = await db
    .select()
    .from(operatorSettingsAuditTable)
    .orderBy(
      desc(operatorSettingsAuditTable.changedAt),
      desc(operatorSettingsAuditTable.id),
    )
    .limit(AUDIT_HISTORY_LIMIT);
  if (rows.length === 0) return [];

  const userIds = Array.from(
    new Set(rows.map((r) => r.changedByUserId).filter((id): id is number => id !== null)),
  );
  const users = userIds.length
    ? await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, userIds))
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  return rows.map((r) => ({
    id: r.id,
    changedAt: r.changedAt.toISOString(),
    changedByUserId: r.changedByUserId,
    changedByUserEmail:
      r.changedByUserId !== null ? emailById.get(r.changedByUserId) ?? null : null,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
  }));
}

async function resolveEmail(userId: number | null): Promise<string | null> {
  if (userId == null) return null;
  const [row] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.email ?? null;
}

async function buildPayload(): Promise<ThresholdsPayload> {
  const [effective, env, dbRow, auditHistory, areaRows, areaList] =
    await Promise.all([
      loadEffectiveOperatorThresholds(),
      Promise.resolve(getEnvOperatorThresholds()),
      getDbOperatorThresholds(),
      loadAuditHistory(),
      getAllAreaOperatorThresholds(),
      db
        .select({ id: areasTable.id, name: areasTable.name })
        .from(areasTable)
        .orderBy(areasTable.id),
    ]);
  const updatedByUserEmail = await resolveEmail(dbRow.updatedByUserId);
  const nameById = new Map(areaList.map((a) => [a.id, a.name] as const));
  const areaOverrides: AreaOverrideEntry[] = areaRows.map((r) => ({
    areaId: r.areaId,
    areaName: nameById.get(r.areaId) ?? `Area ${r.areaId}`,
    encouragementMinPercent: r.encouragementMinPercent,
    priorBestWindowDays: r.priorBestWindowDays,
    dueSoonThresholdMinutes: r.dueSoonThresholdMinutes,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    updatedByUserId: r.updatedByUserId,
  }));
  // Stable sort by area id so the UI selector keeps a predictable order even
  // as new areas are added or overrides are cleared/recreated.
  areaOverrides.sort((a, b) => a.areaId - b.areaId);
  return {
    ...effective,
    defaults: DEFAULT_OPERATOR_THRESHOLDS,
    envOverrides: env,
    dbOverrides: {
      encouragementMinPercent: dbRow.encouragementMinPercent,
      priorBestWindowDays: dbRow.priorBestWindowDays,
      dueSoonThresholdMinutes: dbRow.dueSoonThresholdMinutes,
    },
    updatedAt: dbRow.updatedAt ? dbRow.updatedAt.toISOString() : null,
    updatedByUserId: dbRow.updatedByUserId,
    updatedByUserEmail,
    auditHistory,
    areaOverrides,
  };
}

/**
 * Parse a `{field?: number|null|...}` patch into a `{field: number|null}`
 * map. Behaves the same way as the global PUT route did before per-area
 * overrides existed:
 *   * Field omitted → leave the existing override untouched (not in patch).
 *   * Field set to `null` → clear the override.
 *   * Field set to a valid integer → store as the new override.
 *   * Anything else (NaN, out-of-range, wrong type) is silently ignored,
 *     matching the permissive style used by the notification preferences
 *     endpoint so a stray bad field can't reject the whole payload.
 */
function parseThresholdPatch(
  body: Record<string, unknown>,
): Partial<Record<ThresholdField, number | null>> {
  const patch: Partial<Record<ThresholdField, number | null>> = {};
  for (const field of THRESHOLD_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === null) {
      patch[field] = null;
      continue;
    }
    if (typeof v === "number" && THRESHOLD_VALIDATORS[field](v)) {
      patch[field] = v;
    }
    // Anything else for this field is ignored (permissive).
  }
  return patch;
}

// Authenticated read — operators need the effective values to render the
// encouragement chip and "due soon" badge. Diagnostic fields (envOverrides,
// dbOverrides, areaOverrides, updatedAt, auditHistory) are returned
// unconditionally; they're not sensitive and the manager UI relies on them
// to show provenance.
router.get(
  "/operator-thresholds",
  authMiddleware,
  async (_req, res): Promise<void> => {
    res.json(await buildPayload());
  },
);

// Manager-only write for the GLOBAL DB override row. Per-field semantics
// match `parseThresholdPatch` above. The full effective state (including
// per-area overrides) is returned so the UI can confirm what actually
// landed.
router.put(
  "/operator-thresholds",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = parseThresholdPatch(body);

    if (Object.keys(patch).length > 0) {
      // Capture pre-write values so we can emit accurate audit rows that
      // describe each individual field that actually moved. We snapshot
      // *before* the upsert so a no-op set (e.g. saving the same number
      // back) doesn't pollute the history.
      const previous = await getDbOperatorThresholds();

      // Upsert the singleton row at id=1. We always touch updatedAt /
      // updatedByUserId so the admin UI can show "last changed by".
      const changedAt = new Date();
      await db
        .insert(operatorSettingsTable)
        .values({
          id: 1,
          encouragementMinPercent: patch.encouragementMinPercent ?? null,
          priorBestWindowDays: patch.priorBestWindowDays ?? null,
          dueSoonThresholdMinutes: patch.dueSoonThresholdMinutes ?? null,
          updatedByUserId: userId,
          updatedAt: changedAt,
        })
        .onConflictDoUpdate({
          target: operatorSettingsTable.id,
          set: {
            ...patch,
            updatedByUserId: userId,
            updatedAt: changedAt,
          },
        });

      // Keep the singleton sequence in step with the inserted id so future
      // serial allocations don't collide with our explicit id=1 write.
      await db.execute(
        sql`SELECT setval(pg_get_serial_sequence('operator_settings', 'id'), GREATEST((SELECT MAX(id) FROM operator_settings), 1))`,
      );

      // One audit row per field that actually moved. Reuses the same
      // changedAt as the settings write so a UI can group simultaneous
      // tweaks together.
      const auditValues: Array<{
        changedByUserId: number;
        changedAt: Date;
        field: string;
        oldValue: number | null;
        newValue: number | null;
      }> = [];
      for (const field of THRESHOLD_FIELDS) {
        if (!(field in patch)) continue;
        const oldValue = previous[field];
        const newValue = patch[field] ?? null;
        if (oldValue === newValue) continue;
        auditValues.push({
          changedByUserId: userId,
          changedAt,
          field,
          oldValue,
          newValue,
        });
      }
      if (auditValues.length > 0) {
        await db.insert(operatorSettingsAuditTable).values(auditValues);
        // Enforce the per-field retention cap right after we insert. Pruning
        // inline (instead of on a timer) means the table can only grow when
        // a manager actually edits a threshold, and each edit immediately
        // bounds the table to a known size — no separate scheduler needed.
        // Failures are logged and swallowed so a transient prune error never
        // rejects the manager's save.
        try {
          await pruneOperatorSettingsAudit();
        } catch (err) {
          logger.error(
            { err },
            "operator_settings_audit: post-insert prune failed",
          );
        }
      }
    }

    res.json(await buildPayload());
  },
);

interface AreaThresholdsPayload {
  areaId: number;
  areaName: string;
  /** env > area-DB > global-DB > default. */
  encouragementMinPercent: number;
  priorBestWindowDays: number;
  dueSoonThresholdMinutes: number;
  defaults: typeof DEFAULT_OPERATOR_THRESHOLDS;
  envOverrides: ThresholdSources;
  /** Global DB override (the layer that applies when no area override is set). */
  globalOverrides: ThresholdSources;
  /** This area's per-area DB override (all-nulls when the area has no row yet). */
  areaOverrides: ThresholdSources;
  updatedAt: string | null;
  updatedByUserId: number | null;
}

async function buildAreaPayload(args: {
  areaId: number;
  areaName: string;
}): Promise<AreaThresholdsPayload> {
  const [env, globalRow, areaRow] = await Promise.all([
    Promise.resolve(getEnvOperatorThresholds()),
    getDbOperatorThresholds(),
    getDbAreaOperatorThresholds(args.areaId),
  ]);
  const effective = resolveOperatorThresholds({
    env,
    areaOverride: areaRow,
    globalOverride: globalRow,
  });
  return {
    areaId: args.areaId,
    areaName: args.areaName,
    ...effective,
    defaults: DEFAULT_OPERATOR_THRESHOLDS,
    envOverrides: env,
    globalOverrides: {
      encouragementMinPercent: globalRow.encouragementMinPercent,
      priorBestWindowDays: globalRow.priorBestWindowDays,
      dueSoonThresholdMinutes: globalRow.dueSoonThresholdMinutes,
    },
    areaOverrides: {
      encouragementMinPercent: areaRow.encouragementMinPercent,
      priorBestWindowDays: areaRow.priorBestWindowDays,
      dueSoonThresholdMinutes: areaRow.dueSoonThresholdMinutes,
    },
    updatedAt: areaRow.updatedAt ? areaRow.updatedAt.toISOString() : null,
    updatedByUserId: areaRow.updatedByUserId,
  };
}

// Authenticated read — same audience as the global GET (operators consume
// the resolved values; managers consume the diagnostic fields too).
router.get(
  "/operator-thresholds/areas/:id",
  authMiddleware,
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid area id" });
      return;
    }
    const [area] = await db
      .select({ id: areasTable.id, name: areasTable.name })
      .from(areasTable)
      .where(eq(areasTable.id, id))
      .limit(1);
    if (!area) {
      res.status(404).json({ error: "Area not found" });
      return;
    }
    res.json(await buildAreaPayload({ areaId: area.id, areaName: area.name }));
  },
);

// Manager-only write for a per-area DB override. Per-field semantics match
// the global PUT. If every patched field comes back null AND the row already
// existed with all-nulls afterwards, we delete the row outright to keep the
// table tidy — but only when the manager explicitly cleared everything.
router.put(
  "/operator-thresholds/areas/:id",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid area id" });
      return;
    }
    const [area] = await db
      .select({ id: areasTable.id, name: areasTable.name })
      .from(areasTable)
      .where(eq(areasTable.id, id))
      .limit(1);
    if (!area) {
      res.status(404).json({ error: "Area not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = parseThresholdPatch(body);

    if (Object.keys(patch).length > 0) {
      // Per-area changes are not audited yet — see follow-up #135.
      await db
        .insert(areaOperatorSettingsTable)
        .values({
          areaId: area.id,
          encouragementMinPercent: patch.encouragementMinPercent ?? null,
          priorBestWindowDays: patch.priorBestWindowDays ?? null,
          dueSoonThresholdMinutes: patch.dueSoonThresholdMinutes ?? null,
          updatedByUserId: userId,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: areaOperatorSettingsTable.areaId,
          set: {
            ...patch,
            updatedByUserId: userId,
            updatedAt: new Date(),
          },
        });

      // Tidy the row away if the manager cleared every override for this
      // area (all stored values are NULL). Keeps `areaOverrides` in the
      // global payload from accumulating empty entries forever.
      const after = await getDbAreaOperatorThresholds(area.id);
      if (
        after.encouragementMinPercent == null &&
        after.priorBestWindowDays == null &&
        after.dueSoonThresholdMinutes == null
      ) {
        await db
          .delete(areaOperatorSettingsTable)
          .where(eq(areaOperatorSettingsTable.areaId, area.id));
      }
    }

    res.json(await buildAreaPayload({ areaId: area.id, areaName: area.name }));
  },
);

// Manager-only delete: drop every per-area override for an area in one
// shot. Equivalent to PUTting `{field: null}` for every field, but cheaper
// from the UI's perspective and friendlier in audit logs.
router.delete(
  "/operator-thresholds/areas/:id",
  authMiddleware,
  requireRole("MANAGER"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid area id" });
      return;
    }
    const [area] = await db
      .select({ id: areasTable.id, name: areasTable.name })
      .from(areasTable)
      .where(eq(areasTable.id, id))
      .limit(1);
    if (!area) {
      res.status(404).json({ error: "Area not found" });
      return;
    }
    // Per-area changes are not audited yet — see follow-up #135.
    await db
      .delete(areaOperatorSettingsTable)
      .where(eq(areaOperatorSettingsTable.areaId, area.id));
    res.json(await buildAreaPayload({ areaId: area.id, areaName: area.name }));
  },
);

export default router;
