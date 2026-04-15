import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, areasTable, idealPhotosTable, submissionsTable } from "@workspace/db";
import { UploadIdealPhotoParams, CreateAreaBody, UpdateAreaParams, UpdateAreaBody, DeleteAreaParams } from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";
import { upload } from "../lib/upload";

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

  await db.delete(idealPhotosTable).where(eq(idealPhotosTable.areaId, params.data.id));
  await db.delete(submissionsTable).where(eq(submissionsTable.areaId, params.data.id));

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

router.get("/areas/:id/ideal-photos", authMiddleware, async (req, res): Promise<void> => {
  const params = UploadIdealPhotoParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const photos = await db
    .select()
    .from(idealPhotosTable)
    .where(eq(idealPhotosTable.areaId, params.data.id))
    .orderBy(idealPhotosTable.createdAt);

  res.json(photos);
});

router.post(
  "/areas/:id/ideal-photo",
  authMiddleware,
  requireRole("MANAGER"),
  upload.single("photo"),
  async (req, res): Promise<void> => {
    const params = UploadIdealPhotoParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Photo is required" });
      return;
    }

    const imageUrl = `/uploads/${file.filename}`;
    const [photo] = await db
      .insert(idealPhotosTable)
      .values({ areaId: params.data.id, imageUrl })
      .returning();

    res.status(201).json(photo);
  }
);

export default router;
