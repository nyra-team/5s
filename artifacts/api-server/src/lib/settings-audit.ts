import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import {
  db,
  settingsAuditTable,
  usersTable,
  type SettingsAuditRow,
} from "@workspace/db";

/**
 * Generic helper for diff-and-audit on any manager-tunable setting.
 *
 * The first consumer is `/me/notification-preferences`; the operator
 * thresholds page still uses its bespoke `operator_settings_audit` table
 * for backwards compatibility, but every NEW settings endpoint should
 * write into `settings_audit` via `recordSettingsChanges` so we don't
 * spawn a fresh table per page.
 */

/** A primitive value the audit table knows how to round-trip. */
export type AuditValue = string | number | boolean | null;

/** Resolved audit row as returned to API clients. */
export interface SettingsAuditEntry {
  id: number;
  changedAt: string;
  changedByUserId: number | null;
  changedByUserEmail: string | null;
  field: string;
  /** Decoded back into its original primitive (or null when no override). */
  oldValue: AuditValue;
  newValue: AuditValue;
}

/** Default cap on the number of history rows returned to the UI. */
export const DEFAULT_AUDIT_HISTORY_LIMIT = 5;

function encodeValue(v: AuditValue): string | null {
  // We deliberately store NULL as a SQL NULL (not the string "null") so the
  // distinction between "field cleared" and "field set to literal null"
  // stays unambiguous at the DB layer. Today no setting actually stores
  // the JSON value `null`, so this is mostly a future-proofing call.
  if (v === null) return null;
  return JSON.stringify(v);
}

function decodeValue(raw: string | null): AuditValue {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed === "boolean" ||
      typeof parsed === "number" ||
      typeof parsed === "string"
    ) {
      return parsed;
    }
    // Anything else (arrays/objects) collapses to its JSON string so the UI
    // still has something readable. We don't expect callers to write these.
    return raw;
  } catch {
    // Non-JSON legacy values (or hand-edited rows) round-trip as raw text.
    return raw;
  }
}

interface FieldChange {
  field: string;
  oldValue: AuditValue;
  newValue: AuditValue;
}

/**
 * Compute the per-field diff between `before` and `after` for the given
 * fields, emitting one entry for each value that actually moved. Fields
 * not present on either side are ignored. Useful as the input to
 * `recordSettingsChanges`.
 */
export function diffFields<T extends Record<string, AuditValue>>(
  before: T,
  after: T,
  fields: ReadonlyArray<keyof T & string>,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of fields) {
    const oldValue = before[f] ?? null;
    const newValue = after[f] ?? null;
    if (oldValue === newValue) continue;
    out.push({ field: f, oldValue, newValue });
  }
  return out;
}

/**
 * Minimal subset of the drizzle DB API the audit helpers need. Both the
 * top-level `db` and a `db.transaction` callback's `tx` argument satisfy
 * this shape, so callers can hand either one in. Keeping it structural
 * (vs importing drizzle's exported transaction type) avoids depending on
 * the dialect-specific generic that's awkward to spell at the call site.
 */
export type AuditExecutor = Pick<typeof db, "insert" | "select">;

/**
 * Append one row per changed field. No-op when `changes` is empty.
 * All rows in a single call share the same `changedAt` timestamp so the
 * UI can group simultaneous tweaks together.
 *
 * Pass `executor` (a drizzle transaction handle) to enlist the audit
 * insert in the same transaction as the underlying settings write — that
 * way a failed audit insert rolls the settings change back too, and we
 * never end up with an unattributed write in the wild.
 */
export async function recordSettingsChanges(args: {
  scope: string;
  subjectId: number | null;
  changedByUserId: number;
  changes: FieldChange[];
  changedAt?: Date;
  executor?: AuditExecutor;
}): Promise<void> {
  if (args.changes.length === 0) return;
  const changedAt = args.changedAt ?? new Date();
  const executor = args.executor ?? db;
  await executor.insert(settingsAuditTable).values(
    args.changes.map((c) => ({
      scope: args.scope,
      subjectId: args.subjectId,
      changedByUserId: args.changedByUserId,
      changedAt,
      field: c.field,
      oldValue: encodeValue(c.oldValue),
      newValue: encodeValue(c.newValue),
    })),
  );
}

function buildScopeFilter(args: {
  scope: string;
  subjectId: number | null;
}): SQL {
  // `subjectId IS NULL` for singleton settings, equality otherwise. Using a
  // tagged-template SQL fragment keeps drizzle's type narrowing happy across
  // both branches.
  if (args.subjectId === null) {
    return and(
      eq(settingsAuditTable.scope, args.scope),
      isNull(settingsAuditTable.subjectId),
    )!;
  }
  return and(
    eq(settingsAuditTable.scope, args.scope),
    eq(settingsAuditTable.subjectId, args.subjectId),
  )!;
}

/**
 * Most-recent-first audit history for a (scope, subjectId) pair.
 * Resolves user emails in a single follow-up query so deleted users
 * degrade to `changedByUserEmail: null` instead of throwing.
 */
export async function loadSettingsAuditHistory(args: {
  scope: string;
  subjectId: number | null;
  limit?: number;
}): Promise<SettingsAuditEntry[]> {
  const limit = args.limit ?? DEFAULT_AUDIT_HISTORY_LIMIT;
  const rows = await db
    .select()
    .from(settingsAuditTable)
    .where(buildScopeFilter(args))
    .orderBy(desc(settingsAuditTable.changedAt), desc(settingsAuditTable.id))
    .limit(limit);
  return resolveRows(rows);
}

/**
 * Latest single audit entry for a (scope, subjectId) pair, with the user
 * email resolved. Convenient for the "Last changed by Alice on …" line
 * shown on each settings page header.
 */
export async function loadLastSettingsChange(args: {
  scope: string;
  subjectId: number | null;
}): Promise<SettingsAuditEntry | null> {
  const [row] = await db
    .select()
    .from(settingsAuditTable)
    .where(buildScopeFilter(args))
    .orderBy(desc(settingsAuditTable.changedAt), desc(settingsAuditTable.id))
    .limit(1);
  if (!row) return null;
  const [resolved] = await resolveRows([row]);
  return resolved;
}

async function resolveRows(rows: SettingsAuditRow[]): Promise<SettingsAuditEntry[]> {
  if (rows.length === 0) return [];
  const userIds = Array.from(
    new Set(rows.map((r) => r.changedByUserId).filter((id): id is number => id != null)),
  );
  const emailById = new Map<number, string>();
  if (userIds.length > 0) {
    const users = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));
    for (const u of users) emailById.set(u.id, u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    changedAt: r.changedAt.toISOString(),
    changedByUserId: r.changedByUserId,
    changedByUserEmail:
      r.changedByUserId != null ? (emailById.get(r.changedByUserId) ?? null) : null,
    field: r.field,
    oldValue: decodeValue(r.oldValue),
    newValue: decodeValue(r.newValue),
  }));
}

