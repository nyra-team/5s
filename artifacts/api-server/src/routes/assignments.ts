import { Router, type IRouter } from "express";
import { eq, and, inArray, asc } from "drizzle-orm";
import {
  db,
  areasTable,
  usersTable,
  areaAssignmentsTable,
} from "@workspace/db";
import {
  GetAreaAssignmentsParams,
  SetAreaAssignmentsParams,
  SetAreaAssignmentsBody,
  GetUserAreaAssignmentsParams,
  SetUserAreaAssignmentsParams,
  SetUserAreaAssignmentsBody,
} from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";

const router: IRouter = Router();

// Manager-only operator directory used by the area-assignment picker. Kept
// minimal on purpose: the picker only needs an id + email to render a
// checkbox list, and we don't want to leak password hashes or notification
// preferences through this endpoint.
router.get("/users/operators", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.role, "OPERATOR"))
    .orderBy(asc(usersTable.email));
  res.json(rows);
});

router.get("/areas/:id/assignments", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = GetAreaAssignmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const areaId = params.data.id;

  const [area] = await db.select({ id: areasTable.id }).from(areasTable).where(eq(areasTable.id, areaId));
  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  const rows = await db
    .select({ userId: areaAssignmentsTable.userId })
    .from(areaAssignmentsTable)
    .where(eq(areaAssignmentsTable.areaId, areaId));

  res.json({ areaId, operatorIds: rows.map((r) => r.userId) });
});

router.put("/areas/:id/assignments", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = SetAreaAssignmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetAreaAssignmentsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const areaId = params.data.id;
  // Dedupe so a sloppy client (e.g. a checkbox list re-emitting the same id
  // twice) doesn't cause an insert conflict on the (user_id, area_id) PK.
  const operatorIds = Array.from(new Set(body.data.operatorIds));

  const [area] = await db.select({ id: areasTable.id }).from(areasTable).where(eq(areasTable.id, areaId));
  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  // Validate every supplied id is an actual OPERATOR before we touch the
  // assignment rows. If any id is unknown or belongs to a manager, reject the
  // whole request — partially applying it would silently drop members from
  // the manager's intended list.
  if (operatorIds.length > 0) {
    const validUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(inArray(usersTable.id, operatorIds), eq(usersTable.role, "OPERATOR")));
    if (validUsers.length !== operatorIds.length) {
      res.status(400).json({ error: "One or more operator ids are invalid" });
      return;
    }
  }

  // Replace-style update. Two separate statements are fine here because
  // assignments aren't on a hot path and we accept a brief window where a
  // GET sees the new (or empty) set even if a concurrent writer was in
  // flight — the PUT contract is "this is the final list".
  await db.delete(areaAssignmentsTable).where(eq(areaAssignmentsTable.areaId, areaId));
  if (operatorIds.length > 0) {
    await db.insert(areaAssignmentsTable).values(
      operatorIds.map((userId) => ({ userId, areaId })),
    );
  }

  res.json({ areaId, operatorIds });
});

// "By operator" view — counterpart of the per-area picker. Lets the manager
// pick one operator and toggle the full set of areas they're assigned to in a
// single screen instead of clicking through every area card. The data model
// is symmetric (a row in `area_assignments` is just a user/area pair) so both
// views read and write the same table; the only difference is which axis the
// caller pins. Both endpoints below preserve the "no rows for this user → see
// every area" backward-compat rule because clearing an operator's full list
// just deletes their rows.
router.get("/users/:userId/assignments", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = GetUserAreaAssignmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const userId = params.data.userId;

  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user || user.role !== "OPERATOR") {
    res.status(404).json({ error: "Operator not found" });
    return;
  }

  const rows = await db
    .select({ areaId: areaAssignmentsTable.areaId })
    .from(areaAssignmentsTable)
    .where(eq(areaAssignmentsTable.userId, userId));

  res.json({ userId, areaIds: rows.map((r) => r.areaId) });
});

router.put("/users/:userId/assignments", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = SetUserAreaAssignmentsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SetUserAreaAssignmentsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const userId = params.data.userId;
  // Mirror the per-area handler: dedupe so a sloppy client doesn't trip the
  // (user_id, area_id) PK on insert.
  const areaIds = Array.from(new Set(body.data.areaIds));

  const [user] = await db
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user || user.role !== "OPERATOR") {
    res.status(404).json({ error: "Operator not found" });
    return;
  }

  // Validate every area id exists before touching anything. Same rationale as
  // the per-area validator: partial application would silently drop areas
  // from the manager's intended list.
  if (areaIds.length > 0) {
    const validAreas = await db
      .select({ id: areasTable.id })
      .from(areasTable)
      .where(inArray(areasTable.id, areaIds));
    if (validAreas.length !== areaIds.length) {
      res.status(400).json({ error: "One or more area ids are invalid" });
      return;
    }
  }

  // Replace-style update, scoped to this user. Mirrors the per-area PUT —
  // two statements are fine because assignments aren't on a hot path.
  await db.delete(areaAssignmentsTable).where(eq(areaAssignmentsTable.userId, userId));
  if (areaIds.length > 0) {
    await db.insert(areaAssignmentsTable).values(
      areaIds.map((areaId) => ({ userId, areaId })),
    );
  }

  res.json({ userId, areaIds });
});

export default router;
