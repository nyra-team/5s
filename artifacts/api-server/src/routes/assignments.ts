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

export default router;
