import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, escalationsTable, areasTable, usersTable } from "@workspace/db";
import { authMiddleware, requireRole } from "../lib/auth";

const router: IRouter = Router();

function shape(rows: any[]) {
  return rows.map((r) => ({
    id: r.id,
    submissionId: r.submissionId,
    areaId: r.areaId,
    areaName: r.areaName,
    operatorId: r.operatorId,
    operatorEmail: r.operatorEmail,
    scoreTotal: r.scoreTotal,
    scorePercent: r.scorePercent,
    failingPillars: (r.failingPillarsJson as string[]) ?? [],
    recommendedActions: (r.recommendedActionsJson as string[]) ?? [],
    evidenceUrls: (r.evidenceUrlsJson as string[]) ?? [],
    status: r.status,
    createdAt: r.createdAt,
    ackedAt: r.ackedAt,
    resolvedAt: r.resolvedAt,
    repingCount: r.repingCount ?? 0,
    lastRepingAt: r.lastRepingAt,
  }));
}

router.get("/escalations", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const status = (req.query.status as string | undefined) ?? "OPEN";
  const conds = [];
  if (status !== "ALL") {
    conds.push(eq(escalationsTable.status, status));
  }
  const rows = await db
    .select({
      id: escalationsTable.id,
      submissionId: escalationsTable.submissionId,
      areaId: escalationsTable.areaId,
      areaName: areasTable.name,
      operatorId: escalationsTable.operatorId,
      operatorEmail: usersTable.email,
      scoreTotal: escalationsTable.scoreTotal,
      scorePercent: escalationsTable.scorePercent,
      failingPillarsJson: escalationsTable.failingPillarsJson,
      recommendedActionsJson: escalationsTable.recommendedActionsJson,
      evidenceUrlsJson: escalationsTable.evidenceUrlsJson,
      status: escalationsTable.status,
      createdAt: escalationsTable.createdAt,
      ackedAt: escalationsTable.ackedAt,
      resolvedAt: escalationsTable.resolvedAt,
      repingCount: escalationsTable.repingCount,
      lastRepingAt: escalationsTable.lastRepingAt,
    })
    .from(escalationsTable)
    .innerJoin(areasTable, eq(escalationsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(escalationsTable.operatorId, usersTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`${escalationsTable.createdAt} DESC`);

  res.json(shape(rows));
});

router.get("/escalations/count", authMiddleware, requireRole("MANAGER"), async (_req, res): Promise<void> => {
  const [row] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(escalationsTable)
    .where(eq(escalationsTable.status, "OPEN"));
  res.json({ open: row?.open ?? 0 });
});

router.post("/escalations/:id/acknowledge", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { userId } = (req as any).user;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db
    .update(escalationsTable)
    .set({ status: "ACKNOWLEDGED", ackedByUserId: userId, ackedAt: new Date() })
    .where(eq(escalationsTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  await sendOne(res, row.id);
});

router.post("/escalations/:id/resolve", authMiddleware, requireRole("MANAGER"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { userId } = (req as any).user;
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [row] = await db
    .update(escalationsTable)
    .set({ status: "RESOLVED", resolvedByUserId: userId, resolvedAt: new Date() })
    .where(eq(escalationsTable.id, id))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  await sendOne(res, row.id);
});

async function sendOne(res: any, id: number) {
  const rows = await db
    .select({
      id: escalationsTable.id,
      submissionId: escalationsTable.submissionId,
      areaId: escalationsTable.areaId,
      areaName: areasTable.name,
      operatorId: escalationsTable.operatorId,
      operatorEmail: usersTable.email,
      scoreTotal: escalationsTable.scoreTotal,
      scorePercent: escalationsTable.scorePercent,
      failingPillarsJson: escalationsTable.failingPillarsJson,
      recommendedActionsJson: escalationsTable.recommendedActionsJson,
      evidenceUrlsJson: escalationsTable.evidenceUrlsJson,
      status: escalationsTable.status,
      createdAt: escalationsTable.createdAt,
      ackedAt: escalationsTable.ackedAt,
      resolvedAt: escalationsTable.resolvedAt,
      repingCount: escalationsTable.repingCount,
      lastRepingAt: escalationsTable.lastRepingAt,
    })
    .from(escalationsTable)
    .innerJoin(areasTable, eq(escalationsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(escalationsTable.operatorId, usersTable.id))
    .where(eq(escalationsTable.id, id));
  res.json(shape(rows)[0]);
}

export default router;
