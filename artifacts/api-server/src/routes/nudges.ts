import { Router, type IRouter } from "express";
import { and, eq, isNull, isNotNull, inArray, or, gte, sql } from "drizzle-orm";
import { db, nudgesTable, areasTable, usersTable } from "@workspace/db";
import type { NudgeDismissReason } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";

const router: IRouter = Router();

interface ShapedNudge {
  id: number;
  areaId: number;
  areaName: string;
  machine: string | null;
  shift: string;
  message: string | null;
  createdByEmail: string;
  createdAt: Date;
  dismissedAt: Date | null;
}

async function fetchByIds(ids: number[]): Promise<ShapedNudge[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: nudgesTable.id,
      areaId: nudgesTable.areaId,
      areaName: areasTable.name,
      machine: nudgesTable.machine,
      shift: nudgesTable.shift,
      message: nudgesTable.message,
      createdByEmail: usersTable.email,
      createdAt: nudgesTable.createdAt,
      dismissedAt: nudgesTable.dismissedAt,
    })
    .from(nudgesTable)
    .innerJoin(areasTable, eq(nudgesTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(nudgesTable.createdByUserId, usersTable.id))
    .where(inArray(nudgesTable.id, ids))
    .orderBy(sql`${nudgesTable.createdAt} DESC`);
  return rows;
}

// Operators pull active nudges they have not yet seen. Each request appends the
// caller's user id to seen_by_user_ids_json so the toast is not re-shown to the
// same operator on subsequent polls, while another operator on the same shift
// still sees the nudge until they have read it themselves. Restricted to the
// OPERATOR role — managers do not consume their own nudges.
router.get("/nudges", authMiddleware, requireRole("OPERATOR"), async (req, res): Promise<void> => {
  const { userId } = (req as any).user as { userId: number };

  // Postgres @> with a numeric jsonb array element. We pass the array as a
  // single-element JSON literal so the index can be used.
  const seenByMe = sql`${nudgesTable.seenByUserIdsJson} @> ${JSON.stringify([userId])}::jsonb`;

  const active = await db
    .select({ id: nudgesTable.id })
    .from(nudgesTable)
    .where(and(isNull(nudgesTable.dismissedAt), sql`NOT (${seenByMe})`));

  const ids = active.map((r) => r.id);
  if (ids.length === 0) {
    res.json([]);
    return;
  }

  const shaped = await fetchByIds(ids);

  // Append this operator's id to each unseen nudge atomically. Use jsonb_set
  // with array concatenation (||) so we don't overwrite ids added by parallel
  // operator polls. The `NOT (... @> ...)` guard makes this idempotent.
  await db
    .update(nudgesTable)
    .set({
      seenByUserIdsJson: sql`${nudgesTable.seenByUserIdsJson} || ${JSON.stringify([userId])}::jsonb`,
    })
    .where(and(inArray(nudgesTable.id, ids), sql`NOT (${seenByMe})`));

  res.json(shaped);
});

// Persistent variant: returns active (undismissed) nudges WITHOUT marking them
// seen/dismissed, so the operator UI can render a sticky badge per area card
// until the corresponding submission clears the nudge. Optionally filtered by
// shift so /operator's per-shift grid only sees relevant prompts.
router.get(
  "/nudges/active-by-area",
  authMiddleware,
  requireRole("OPERATOR"),
  async (req, res): Promise<void> => {
    const queryShift = typeof req.query.shift === "string" ? req.query.shift : undefined;
    const validShifts = ["A", "B", "C"];
    if (queryShift !== undefined && !validShifts.includes(queryShift)) {
      res.status(400).json({ error: "shift must be A, B, or C" });
      return;
    }
    const shift = queryShift ?? null;

    const conditions = [isNull(nudgesTable.dismissedAt)];
    if (shift) conditions.push(eq(nudgesTable.shift, shift));

    const rows = await db
      .select({ id: nudgesTable.id })
      .from(nudgesTable)
      .where(and(...conditions));

    const ids = rows.map((r) => r.id);
    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const shaped = await fetchByIds(ids);
    res.json(shaped);
  },
);

// Operators can dismiss a specific active nudge they've already addressed
// (e.g. handled offline, or it no longer applies because the area was already
// submitted earlier this shift). Idempotent: dismissing an already-dismissed
// nudge returns the existing row so concurrent taps don't 404. The implicit
// dismissal on submission (dismissNudgesForSubmission) still owns the
// "submitted new evidence" path.
router.post(
  "/nudges/:id/dismiss",
  authMiddleware,
  requireRole("OPERATOR"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user as { userId: number };
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [existing] = await db
      .select({ id: nudgesTable.id, dismissedAt: nudgesTable.dismissedAt })
      .from(nudgesTable)
      .where(eq(nudgesTable.id, id));

    if (!existing) {
      res.status(404).json({ error: "Nudge not found" });
      return;
    }

    if (existing.dismissedAt == null) {
      const reason: NudgeDismissReason = "OPERATOR_DISMISS";
      await db
        .update(nudgesTable)
        .set({ dismissedAt: new Date(), dismissedByUserId: userId, dismissReason: reason })
        .where(and(eq(nudgesTable.id, id), isNull(nudgesTable.dismissedAt)));
    }

    const [shaped] = await fetchByIds([id]);
    res.json(shaped);
  },
);

router.post("/nudges", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const { userId } = (req as any).user as { userId: number };
  const areaId = Number(req.body?.areaId);
  const shift = String(req.body?.shift ?? "");
  const machineRaw = req.body?.machine;
  const messageRaw = req.body?.message;

  if (!Number.isFinite(areaId) || areaId <= 0) {
    res.status(400).json({ error: "areaId is required" });
    return;
  }
  if (!["A", "B", "C"].includes(shift)) {
    res.status(400).json({ error: "shift must be A, B, or C" });
    return;
  }

  const machine = typeof machineRaw === "string" && machineRaw.trim() !== "" ? machineRaw.trim() : null;
  const message = typeof messageRaw === "string" && messageRaw.trim() !== "" ? messageRaw.trim() : null;

  const [area] = await db.select().from(areasTable).where(eq(areasTable.id, areaId));
  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  // De-dupe: if a still-undismissed nudge exists for the same area+machine+shift, reuse it
  // so spamming the button doesn't pile up identical toasts on the operator side.
  const existing = await db
    .select({ id: nudgesTable.id })
    .from(nudgesTable)
    .where(
      and(
        eq(nudgesTable.areaId, areaId),
        eq(nudgesTable.shift, shift),
        machine ? eq(nudgesTable.machine, machine) : isNull(nudgesTable.machine),
        isNull(nudgesTable.dismissedAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const [shaped] = await fetchByIds([existing[0].id]);
    res.status(201).json(shaped);
    return;
  }

  const [created] = await db
    .insert(nudgesTable)
    .values({ areaId, machine, shift, message, createdByUserId: userId })
    .returning({ id: nudgesTable.id });

  const [shaped] = await fetchByIds([created.id]);
  res.status(201).json(shaped);
});

// Implicitly dismiss any active nudges that this submission satisfies. Called
// from submissions.ts after both create and reupload so the operator's badge
// disappears and the manager's Live shift view reflects the cleared state on
// next refresh. Matching rules:
//   - area-level nudge (machine IS NULL)  → cleared by ANY submission to area+shift
//   - machine-specific nudge              → cleared only when submission's
//                                            machineTag matches that machine
export async function dismissNudgesForSubmission(args: {
  areaId: number;
  shift: string;
  machineTag: string | null;
  userId: number;
}): Promise<void> {
  const machinePredicate = args.machineTag
    ? or(isNull(nudgesTable.machine), eq(nudgesTable.machine, args.machineTag))
    : isNull(nudgesTable.machine);

  const reason: NudgeDismissReason = "SUBMISSION";
  await db
    .update(nudgesTable)
    .set({ dismissedAt: new Date(), dismissedByUserId: args.userId, dismissReason: reason })
    .where(
      and(
        eq(nudgesTable.areaId, args.areaId),
        eq(nudgesTable.shift, args.shift),
        isNull(nudgesTable.dismissedAt),
        machinePredicate,
      ),
    );
}

// Helper used by /shift/live to look up the most recent open nudge per area/machine.
export async function getLatestActiveNudgesByAreaMachine(): Promise<
  Map<string, Date>
> {
  const rows = await db
    .select({
      areaId: nudgesTable.areaId,
      machine: nudgesTable.machine,
      createdAt: nudgesTable.createdAt,
    })
    .from(nudgesTable)
    .where(isNull(nudgesTable.dismissedAt));
  const map = new Map<string, Date>();
  for (const r of rows) {
    const key = `${r.areaId}|${r.machine ?? ""}`;
    const prev = map.get(key);
    if (!prev || prev.getTime() < r.createdAt.getTime()) {
      map.set(key, r.createdAt);
    }
  }
  return map;
}

// Same but lookup by area only (for "pending area" cards which don't pin a machine).
export async function getLatestActiveNudgeByArea(): Promise<Map<number, Date>> {
  const rows = await db
    .select({
      areaId: nudgesTable.areaId,
      createdAt: nudgesTable.createdAt,
    })
    .from(nudgesTable)
    .where(isNull(nudgesTable.dismissedAt));
  const map = new Map<number, Date>();
  for (const r of rows) {
    const prev = map.get(r.areaId);
    if (!prev || prev.getTime() < r.createdAt.getTime()) {
      map.set(r.areaId, r.createdAt);
    }
  }
  return map;
}

// Helpers for /shift/live: surface nudges the operator explicitly dismissed
// without submitting fresh evidence, so managers can spot habitual
// "swipe-away" behaviour. We restrict to the current shift window so a stale
// dismissal from yesterday doesn't keep flagging the area.
const OPERATOR_DISMISS_REASON: NudgeDismissReason = "OPERATOR_DISMISS";

export interface OperatorDismissedNudgeInfo {
  dismissedAt: Date;
  dismissedByEmail: string | null;
}

export async function getOperatorDismissedNudgeByArea(
  sinceDismissedAt: Date,
): Promise<Map<number, OperatorDismissedNudgeInfo>> {
  const rows = await db
    .select({
      areaId: nudgesTable.areaId,
      dismissedAt: nudgesTable.dismissedAt,
      dismissedByEmail: usersTable.email,
    })
    .from(nudgesTable)
    .leftJoin(usersTable, eq(nudgesTable.dismissedByUserId, usersTable.id))
    .where(
      and(
        eq(nudgesTable.dismissReason, OPERATOR_DISMISS_REASON),
        isNotNull(nudgesTable.dismissedAt),
        gte(nudgesTable.dismissedAt, sinceDismissedAt),
      ),
    );
  const map = new Map<number, OperatorDismissedNudgeInfo>();
  for (const r of rows) {
    if (!r.dismissedAt) continue;
    const prev = map.get(r.areaId);
    if (!prev || prev.dismissedAt.getTime() < r.dismissedAt.getTime()) {
      map.set(r.areaId, {
        dismissedAt: r.dismissedAt,
        dismissedByEmail: r.dismissedByEmail ?? null,
      });
    }
  }
  return map;
}

export async function getOperatorDismissedNudgesByAreaMachine(
  sinceDismissedAt: Date,
): Promise<Map<string, OperatorDismissedNudgeInfo>> {
  const rows = await db
    .select({
      areaId: nudgesTable.areaId,
      machine: nudgesTable.machine,
      dismissedAt: nudgesTable.dismissedAt,
      dismissedByEmail: usersTable.email,
    })
    .from(nudgesTable)
    .leftJoin(usersTable, eq(nudgesTable.dismissedByUserId, usersTable.id))
    .where(
      and(
        eq(nudgesTable.dismissReason, OPERATOR_DISMISS_REASON),
        isNotNull(nudgesTable.dismissedAt),
        gte(nudgesTable.dismissedAt, sinceDismissedAt),
      ),
    );
  const map = new Map<string, OperatorDismissedNudgeInfo>();
  for (const r of rows) {
    if (!r.dismissedAt) continue;
    const key = `${r.areaId}|${r.machine ?? ""}`;
    const prev = map.get(key);
    if (!prev || prev.dismissedAt.getTime() < r.dismissedAt.getTime()) {
      map.set(key, {
        dismissedAt: r.dismissedAt,
        dismissedByEmail: r.dismissedByEmail ?? null,
      });
    }
  }
  return map;
}

export default router;
