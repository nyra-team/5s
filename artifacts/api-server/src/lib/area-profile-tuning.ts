import { and, asc, desc, eq, gte, isNotNull } from "drizzle-orm";
import {
  db,
  submissionsTable,
  areaProfilesTable,
  areaDetectionEventsTable,
  AREA_DETECTION_EVENT_KIND,
  type AreaDetectionEventKind,
} from "@workspace/db";
import { logger } from "./logger.js";
import type { VLMProfileExtract } from "./ai-scoring.js";

// --- Tunable thresholds (env-overridable so ops can adjust without a redeploy) ---

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function readPercent(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return Math.round(n);
}

export interface AutoRetuneConfig {
  /** How many days back to look when computing per-area agreement. */
  windowDays: number;
  /** Areas with agreement below this percent (0-100) get flagged. */
  agreementThresholdPercent: number;
  /** Don't flag based on a tiny sample — at least this many submissions
   *  with a recorded `tappedAreaId` must exist in the window. */
  minSampleSize: number;
  /** Weight applied to "correction" submissions (where the operator
   *  overrode the AI/area picker) when replaying history into the rebuilt
   *  profile. Integer >= 1. */
  correctionWeight: number;
}

export function readAutoRetuneConfig(): AutoRetuneConfig {
  return {
    windowDays: readPositiveInt(process.env.AREA_AUTO_RETUNE_WINDOW_DAYS, 30),
    agreementThresholdPercent: readPercent(
      process.env.AREA_AUTO_RETUNE_AGREEMENT_THRESHOLD,
      75,
    ),
    minSampleSize: readPositiveInt(process.env.AREA_AUTO_RETUNE_MIN_SAMPLES, 5),
    correctionWeight: readPositiveInt(
      process.env.AREA_AUTO_RETUNE_CORRECTION_WEIGHT,
      2,
    ),
  };
}

// --- Audit-table writer (replaces the previous log-only emission) ---

export async function recordAreaDetectionEvent(opts: {
  submissionId: number;
  userId: number;
  areaId: number;
  tappedAreaId: number | null;
  aiSuggestedAreaId: number | null;
  kind: AreaDetectionEventKind;
}): Promise<void> {
  try {
    await db.insert(areaDetectionEventsTable).values({
      submissionId: opts.submissionId,
      userId: opts.userId,
      areaId: opts.areaId,
      tappedAreaId: opts.tappedAreaId,
      aiSuggestedAreaId: opts.aiSuggestedAreaId,
      kind: opts.kind,
    });
  } catch (err) {
    // Audit-only writes must never wedge a submission. Log and move on so
    // the operator's submit response stays clean.
    logger.error(
      { err, submissionId: opts.submissionId, kind: opts.kind },
      "Failed to record area detection event",
    );
  }
}

// --- Per-area agreement computation (used by both flag-hook and dashboard) ---

export interface AreaAgreement {
  total: number;
  agreed: number;
  /** 0-100, integer. `null` when total is 0. */
  agreementPercent: number | null;
}

export async function computeAreaAgreement(
  areaId: number,
  windowDays: number,
): Promise<AreaAgreement> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // Match the dashboard route's bucket logic: a row counts towards an area
  // when EITHER the operator tapped it OR the chosen area was it. That way
  // a row where the operator tapped X but the system saved against Y shows
  // up as a disagreement against both X and Y, mirroring what managers see.
  const rows = await db
    .select({
      areaId: submissionsTable.areaId,
      tappedAreaId: submissionsTable.tappedAreaId,
    })
    .from(submissionsTable)
    .where(
      and(
        isNotNull(submissionsTable.tappedAreaId),
        gte(submissionsTable.createdAt, since),
      ),
    );

  let total = 0;
  let agreed = 0;
  for (const r of rows) {
    const matched = r.tappedAreaId === r.areaId;
    const touchesArea = r.areaId === areaId || r.tappedAreaId === areaId;
    if (!touchesArea) continue;
    total += 1;
    if (matched && r.areaId === areaId) agreed += 1;
  }
  return {
    total,
    agreed,
    agreementPercent: total === 0 ? null : Math.round((agreed / total) * 100),
  };
}

// --- Auto-flag hook called after each submission ---

/**
 * If the chosen area's recent agreement is below the configured threshold
 * (and the sample is large enough to be meaningful), mark its profile as
 * `needsRebuild`. Idempotent: if the profile is already flagged, this is a
 * no-op so we don't overwrite the original `flaggedAt` timestamp.
 *
 * Returns the result so callers / tests can inspect what happened without
 * re-querying.
 */
export async function flagAreaIfBelowAgreementThreshold(
  areaId: number,
  cfg: AutoRetuneConfig = readAutoRetuneConfig(),
): Promise<
  | { flagged: false; reason: "already-flagged" | "above-threshold" | "insufficient-sample"; agreement: AreaAgreement }
  | { flagged: true; agreement: AreaAgreement }
> {
  const [profile] = await db
    .select()
    .from(areaProfilesTable)
    .where(eq(areaProfilesTable.areaId, areaId));

  // No profile yet (area never received a submission scored against it
  // through the learning pipeline) — nothing to flag.
  if (!profile) {
    return {
      flagged: false,
      reason: "insufficient-sample",
      agreement: { total: 0, agreed: 0, agreementPercent: null },
    };
  }

  if (profile.needsRebuild) {
    return {
      flagged: false,
      reason: "already-flagged",
      agreement: await computeAreaAgreement(areaId, cfg.windowDays),
    };
  }

  const agreement = await computeAreaAgreement(areaId, cfg.windowDays);
  if (agreement.total < cfg.minSampleSize) {
    return { flagged: false, reason: "insufficient-sample", agreement };
  }
  if (
    agreement.agreementPercent === null ||
    agreement.agreementPercent >= cfg.agreementThresholdPercent
  ) {
    return { flagged: false, reason: "above-threshold", agreement };
  }

  await db
    .update(areaProfilesTable)
    .set({
      needsRebuild: true,
      flagReason: "low-agreement",
      flaggedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(areaProfilesTable.areaId, areaId));

  logger.info(
    {
      areaId,
      agreementPercent: agreement.agreementPercent,
      sample: agreement.total,
      threshold: cfg.agreementThresholdPercent,
      kind: "area-profile-flagged",
    },
    "Area flagged for profile rebuild due to low auto-detect agreement",
  );

  return { flagged: true, agreement };
}

// --- Profile rebuild from corrected history ---

interface ReplayRow {
  id: number;
  areaId: number;
  tappedAreaId: number | null;
  profileExtractJson: unknown;
  createdAt: Date;
}

function isProfileExtract(x: unknown): x is VLMProfileExtract {
  return (
    typeof x === "object" &&
    x !== null &&
    "items" in x &&
    "machines" in x &&
    "layout" in x
  );
}

function dedupeAndCap(values: string[], cap: number): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    const norm = String(v).trim();
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (!seen.has(key)) seen.set(key, norm);
  }
  return Array.from(seen.values()).slice(0, cap);
}

export interface RebuildProfileResult {
  areaId: number;
  replayed: number;
  correctionsWeighted: number;
  status: "LEARNING" | "TRAINED";
  itemCount: number;
  machineCount: number;
}

/**
 * Rebuild the per-area learned profile from the historical submissions of
 * that area, replaying their stored VLM `profileExtractJson` snapshots in
 * chronological order.
 *
 * Corrections (rows where `tappedAreaId !== areaId`, i.e. the operator's
 * intent disagreed with the saved area) are treated as the highest-signal
 * ground truth and replayed `correctionWeight` times so their items /
 * machines / layout / summary push harder against the merged profile.
 *
 * After replay we clear the `needsRebuild` flag and stamp `lastRebuildAt`
 * so the dashboard CTA goes away.
 */
export async function rebuildAreaProfile(
  areaId: number,
  cfg: AutoRetuneConfig = readAutoRetuneConfig(),
): Promise<RebuildProfileResult> {
  // Look back over the same window the flagging logic uses — going further
  // back doesn't add signal because the AI's identification has likely
  // already drifted significantly.
  const since = new Date(Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000);

  const rows: ReplayRow[] = await db
    .select({
      id: submissionsTable.id,
      areaId: submissionsTable.areaId,
      tappedAreaId: submissionsTable.tappedAreaId,
      profileExtractJson: submissionsTable.profileExtractJson,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .where(
      and(
        eq(submissionsTable.areaId, areaId),
        gte(submissionsTable.createdAt, since),
      ),
    )
    .orderBy(asc(submissionsTable.createdAt));

  // Merge buckets independent of the existing profile so the rebuild starts
  // from a clean slate. We weight each row by 1 (baseline) or
  // `cfg.correctionWeight` (operator override) — duplicate the row in the
  // merge stream by repeating its strings, which is enough because the
  // dedupe step preserves only the first occurrence and ordering only
  // affects what wins on the cap (correction-only items therefore get
  // priority equal to baseline items that appeared the same number of
  // times).
  const itemBuckets: string[] = [];
  const machineBuckets: string[] = [];
  const layoutBuckets: string[] = [];
  const issueBuckets: string[] = [];
  let lastSummary: string | null = null;

  let replayed = 0;
  let correctionsWeighted = 0;

  for (const row of rows) {
    if (!isProfileExtract(row.profileExtractJson)) continue;
    const extract = row.profileExtractJson;
    const isCorrection =
      row.tappedAreaId != null && row.tappedAreaId !== row.areaId;
    const weight = isCorrection ? cfg.correctionWeight : 1;
    if (isCorrection) correctionsWeighted += 1;
    replayed += 1;

    for (let i = 0; i < weight; i++) {
      // Corrections are pushed to the FRONT so they survive the cap-trim
      // step in dedupeAndCap (which keeps first-seen entries).
      if (isCorrection) {
        itemBuckets.unshift(...extract.items.map(String));
        machineBuckets.unshift(...extract.machines.map(String));
        layoutBuckets.unshift(...extract.layout.map(String));
        issueBuckets.unshift(...extract.observedIssues.map(String));
      } else {
        itemBuckets.push(...extract.items.map(String));
        machineBuckets.push(...extract.machines.map(String));
        layoutBuckets.push(...extract.layout.map(String));
        issueBuckets.push(...extract.observedIssues.map(String));
      }
    }
    if (extract.summary && extract.summary.trim().length > 0) {
      lastSummary = extract.summary;
    }
  }

  const items = dedupeAndCap(itemBuckets, 25);
  const machines = dedupeAndCap(machineBuckets, 15);
  const layout = dedupeAndCap(layoutBuckets, 10);
  const issues = dedupeAndCap(issueBuckets, 10);

  // We deliberately recompute submissionsCount from the replay so a partial
  // history (e.g. extracts missing from very old rows) doesn't leave the
  // profile stuck at LEARNING forever.
  const TRAINING_THRESHOLD = 5;
  const status: "LEARNING" | "TRAINED" =
    replayed >= TRAINING_THRESHOLD ? "TRAINED" : "LEARNING";

  const now = new Date();
  await db
    .update(areaProfilesTable)
    .set({
      status,
      submissionsCount: replayed,
      itemsJson: items,
      machinesJson: machines,
      layoutJson: layout,
      commonIssuesJson: issues,
      summary: lastSummary,
      // We intentionally do NOT touch trainedAt here: the original
      // graduation date is still the right thing to display.
      needsRebuild: false,
      flaggedAt: null,
      flagReason: null,
      lastRebuildAt: now,
      updatedAt: now,
    })
    .where(eq(areaProfilesTable.areaId, areaId));

  logger.info(
    {
      areaId,
      replayed,
      correctionsWeighted,
      itemCount: items.length,
      machineCount: machines.length,
      kind: "area-profile-rebuilt",
    },
    "Area profile rebuilt from corrected history",
  );

  return {
    areaId,
    replayed,
    correctionsWeighted,
    status,
    itemCount: items.length,
    machineCount: machines.length,
  };
}

// --- Audit-table query for the dashboard / debugging ---

export interface AreaDetectionEventQuery {
  areaId?: number;
  kind?: AreaDetectionEventKind;
  days: number;
  limit: number;
}

export async function listAreaDetectionEvents(query: AreaDetectionEventQuery) {
  const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
  const conds = [gte(areaDetectionEventsTable.createdAt, since)];
  if (query.areaId != null) conds.push(eq(areaDetectionEventsTable.areaId, query.areaId));
  if (query.kind != null) conds.push(eq(areaDetectionEventsTable.kind, query.kind));

  return db
    .select({
      id: areaDetectionEventsTable.id,
      submissionId: areaDetectionEventsTable.submissionId,
      userId: areaDetectionEventsTable.userId,
      areaId: areaDetectionEventsTable.areaId,
      tappedAreaId: areaDetectionEventsTable.tappedAreaId,
      aiSuggestedAreaId: areaDetectionEventsTable.aiSuggestedAreaId,
      kind: areaDetectionEventsTable.kind,
      createdAt: areaDetectionEventsTable.createdAt,
    })
    .from(areaDetectionEventsTable)
    .where(and(...conds))
    .orderBy(desc(areaDetectionEventsTable.createdAt))
    .limit(query.limit);
}

// Re-export so callers don't need to dig into @workspace/db
export { AREA_DETECTION_EVENT_KIND };
