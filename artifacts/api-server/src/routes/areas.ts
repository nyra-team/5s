import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, areasTable, idealPhotosTable } from "@workspace/db";
import { UploadIdealPhotoParams } from "@workspace/api-zod";
import { authMiddleware, requireRole } from "../lib/auth";
import { upload } from "../lib/upload";

const router: IRouter = Router();

router.get("/areas", authMiddleware, async (_req, res): Promise<void> => {
  const areas = await db.select().from(areasTable).orderBy(areasTable.id);
  res.json(areas);
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
