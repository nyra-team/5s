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
  res.json(areas);
});

router.post("/areas", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const parsed = CreateAreaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [area] = await db.insert(areasTable).values({ name: parsed.data.name }).returning();
  res.status(201).json(area);
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

  const [area] = await db
    .update(areasTable)
    .set({ name: parsed.data.name })
    .where(eq(areasTable.id, params.data.id))
    .returning();

  if (!area) {
    res.status(404).json({ error: "Area not found" });
    return;
  }

  res.json(area);
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
