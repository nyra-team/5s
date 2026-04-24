import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  areasTable,
  submissionsTable,
  areaProfilesTable,
  escalationsTable,
  areaSchedulesTable,
} from "@workspace/db";
import {
  CreateAreaBody,
  UpdateAreaParams,
  UpdateAreaBody,
  DeleteAreaParams,
} from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";

const router: IRouter = Router();

router.get("/areas", authMiddleware, async (_req, res): Promise<void> => {
  const areas = await db.select().from(areasTable).orderBy(areasTable.id);
  // Surface the per-area walk-through hint override under its API name
  // (`walkthroughHintsOverride`) so the manager UI can read/edit it. NULL
  // in the column means "no override" — the operator UI falls back to the
  // default list for this area's environmentType.
  res.json(
    areas.map((a) => ({
      id: a.id,
      name: a.name,
      environmentType: a.environmentType,
      walkthroughHintsOverride: a.walkthroughHintsOverrideJson ?? null,
    })),
  );
});

router.post("/areas", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const parsed = CreateAreaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const values: { name: string; environmentType?: string } = { name: parsed.data.name };
  if (parsed.data.environmentType) values.environmentType = parsed.data.environmentType;

  const [area] = await db.insert(areasTable).values(values).returning();
  res.status(201).json({
    id: area.id,
    name: area.name,
    environmentType: area.environmentType,
    walkthroughHintsOverride: area.walkthroughHintsOverrideJson ?? null,
  });
});

router.patch("/areas/:id", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = UpdateAreaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAreaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const patch: {
    name?: string;
    environmentType?: string;
    walkthroughHintsOverrideJson?: string[] | null;
  } = { name: parsed.data.name };
  if (parsed.data.environmentType) patch.environmentType = parsed.data.environmentType;
  // The override field is `nullish()` in the spec, so:
  //   - undefined  → key omitted, leave the existing override untouched
  //   - null       → manager wants to reset to the environmentType default
  //   - string[]   → manager wants to set/replace the override
  // An empty array is normalized to `null` (clear) so the contract stays
  // consistent with the render rule (only non-empty overrides are applied)
  // and managers can't accidentally store an "invisible" override.
  if (parsed.data.walkthroughHintsOverride !== undefined) {
    const incoming = parsed.data.walkthroughHintsOverride;
    patch.walkthroughHintsOverrideJson =
      Array.isArray(incoming) && incoming.length === 0 ? null : incoming;
  }

  const [area] = await db
    .update(areasTable)
    .set(patch)
    .where(eq(areasTable.id, params.data.id))
    .returning();

  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  res.json({
    id: area.id,
    name: area.name,
    environmentType: area.environmentType,
    walkthroughHintsOverride: area.walkthroughHintsOverrideJson ?? null,
  });
});

router.delete("/areas/:id", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const params = DeleteAreaParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(escalationsTable).where(eq(escalationsTable.areaId, params.data.id));
  await db.delete(submissionsTable).where(eq(submissionsTable.areaId, params.data.id));
  await db.delete(areaProfilesTable).where(eq(areaProfilesTable.areaId, params.data.id));
  await db.delete(areaSchedulesTable).where(eq(areaSchedulesTable.areaId, params.data.id));

  const [area] = await db
    .delete(areasTable)
    .where(eq(areasTable.id, params.data.id))
    .returning();

  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
