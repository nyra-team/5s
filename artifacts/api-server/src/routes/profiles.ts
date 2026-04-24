import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, areaProfilesTable, areasTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";
import { getOrCreateProfile, TRAINING_THRESHOLD } from "../lib/learning";

const router: IRouter = Router();

function shape(p: typeof areaProfilesTable.$inferSelect) {
  return {
    areaId: p.areaId,
    status: p.status as "LEARNING" | "TRAINED",
    submissionsCount: p.submissionsCount,
    targetSubmissions: TRAINING_THRESHOLD,
    summary: p.summary,
    items: (p.itemsJson as string[]) ?? [],
    machines: (p.machinesJson as string[]) ?? [],
    layout: (p.layoutJson as string[]) ?? [],
    commonIssues: (p.commonIssuesJson as string[]) ?? [],
    updatedAt: p.updatedAt,
  };
}

// Returns true when an areas row exists. We check up-front in profile routes
// so a request for a deleted/unknown area returns a clean 404 instead of
// blowing up on the foreign-key constraint inside getOrCreateProfile().
async function areaExists(id: number): Promise<boolean> {
  const [row] = await db
    .select({ id: areasTable.id })
    .from(areasTable)
    .where(eq(areasTable.id, id));
  return !!row;
}

router.get("/areas/:id/profile", authMiddleware, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await areaExists(id))) { res.status(404).json({ error: "Area not found" }); return; }
  const profile = await getOrCreateProfile(id);
  res.json(shape(profile));
});

router.put("/areas/:id/profile", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await areaExists(id))) { res.status(404).json({ error: "Area not found" }); return; }
  await getOrCreateProfile(id);

  const body = req.body ?? {};
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.summary === "string" || body.summary === null) patch.summary = body.summary;
  if (Array.isArray(body.items)) patch.itemsJson = body.items.map(String).slice(0, 25);
  if (Array.isArray(body.machines)) patch.machinesJson = body.machines.map(String).slice(0, 15);
  if (Array.isArray(body.layout)) patch.layoutJson = body.layout.map(String).slice(0, 10);
  if (Array.isArray(body.commonIssues)) patch.commonIssuesJson = body.commonIssues.map(String).slice(0, 10);

  const [updated] = await db
    .update(areaProfilesTable)
    .set(patch)
    .where(eq(areaProfilesTable.areaId, id))
    .returning();

  res.json(shape(updated));
});

router.delete("/areas/:id/profile", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await areaExists(id))) { res.status(404).json({ error: "Area not found" }); return; }
  await getOrCreateProfile(id);
  const [reset] = await db
    .update(areaProfilesTable)
    .set({
      status: "LEARNING",
      submissionsCount: 0,
      summary: null,
      itemsJson: [],
      machinesJson: [],
      layoutJson: [],
      commonIssuesJson: [],
      updatedAt: new Date(),
    })
    .where(eq(areaProfilesTable.areaId, id))
    .returning();
  res.json(shape(reset));
});

export default router;
