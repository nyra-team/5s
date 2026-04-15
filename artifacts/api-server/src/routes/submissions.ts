import { Router, type IRouter } from "express";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { db, submissionsTable, areasTable, usersTable } from "@workspace/db";
import { GetSubmissionParams, ListSubmissionsQueryParams } from "@workspace/api-zod";
import { authMiddleware } from "../lib/auth";
import { upload } from "../lib/upload";
import { generateScore, getCurrentShift } from "../lib/scoring";

const router: IRouter = Router();

function getShiftDateRange(dateStr?: string, shift?: string) {
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  if (shift === "A") {
    return {
      start: new Date(y, m, d, 6, 0, 0),
      end: new Date(y, m, d, 14, 0, 0),
    };
  } else if (shift === "B") {
    return {
      start: new Date(y, m, d, 14, 0, 0),
      end: new Date(y, m, d, 22, 0, 0),
    };
  } else if (shift === "C") {
    return {
      start: new Date(y, m, d, 22, 0, 0),
      end: new Date(y, m, d + 1, 6, 0, 0),
    };
  }
  return {
    start: new Date(y, m, d, 0, 0, 0),
    end: new Date(y, m, d + 1, 0, 0, 0),
  };
}

router.get("/submissions", authMiddleware, async (req, res): Promise<void> => {
  const query = ListSubmissionsQueryParams.safeParse(req.query);

  const conditions = [];
  if (query.success && query.data.shift) {
    conditions.push(eq(submissionsTable.shift, query.data.shift));
  }
  if (query.success && query.data.areaId) {
    conditions.push(eq(submissionsTable.areaId, query.data.areaId));
  }
  if (query.success && query.data.date) {
    const { start, end } = getShiftDateRange(query.data.date);
    conditions.push(gte(submissionsTable.createdAt, start));
    conditions.push(lt(submissionsTable.createdAt, end));
  }

  const rows = await db
    .select({
      id: submissionsTable.id,
      areaId: submissionsTable.areaId,
      areaName: areasTable.name,
      userId: submissionsTable.userId,
      userEmail: usersTable.email,
      shift: submissionsTable.shift,
      scoreTotal: submissionsTable.scoreTotal,
      scoreJson: submissionsTable.scoreJson,
      suggestionsJson: submissionsTable.suggestionsJson,
      imageUrl: submissionsTable.imageUrl,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${submissionsTable.createdAt} DESC`);

  res.json(rows);
});

router.post(
  "/submissions",
  authMiddleware,
  upload.single("photo"),
  async (req, res): Promise<void> => {
    const { userId } = (req as any).user;
    const areaId = parseInt(req.body.areaId, 10);

    if (isNaN(areaId)) {
      res.status(400).json({ error: "areaId is required" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "Photo is required" });
      return;
    }

    const { shift } = getCurrentShift();
    const { scoreJson, scoreTotal, suggestions } = generateScore();
    const imageUrl = `/uploads/${file.filename}`;

    const [submission] = await db
      .insert(submissionsTable)
      .values({
        areaId,
        userId,
        shift,
        scoreTotal,
        scoreJson,
        suggestionsJson: suggestions,
        imageUrl,
      })
      .returning();

    const [area] = await db
      .select()
      .from(areasTable)
      .where(eq(areasTable.id, areaId));

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    res.status(201).json({
      ...submission,
      areaName: area?.name ?? "",
      userEmail: user?.email ?? "",
    });
  }
);

router.get("/submissions/:id", authMiddleware, async (req, res): Promise<void> => {
  const params = GetSubmissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({
      id: submissionsTable.id,
      areaId: submissionsTable.areaId,
      areaName: areasTable.name,
      userId: submissionsTable.userId,
      userEmail: usersTable.email,
      shift: submissionsTable.shift,
      scoreTotal: submissionsTable.scoreTotal,
      scoreJson: submissionsTable.scoreJson,
      suggestionsJson: submissionsTable.suggestionsJson,
      imageUrl: submissionsTable.imageUrl,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(eq(submissionsTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  res.json(row);
});

router.get("/shift/current", authMiddleware, async (_req, res): Promise<void> => {
  res.json(getCurrentShift());
});

router.get("/operator/status", authMiddleware, async (req, res): Promise<void> => {
  const { userId } = (req as any).user;
  const { shift } = getCurrentShift();

  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  let start: Date, end: Date;
  if (shift === "A") {
    start = new Date(y, m, d, 6, 0, 0);
    end = new Date(y, m, d, 14, 0, 0);
  } else if (shift === "B") {
    start = new Date(y, m, d, 14, 0, 0);
    end = new Date(y, m, d, 22, 0, 0);
  } else {
    if (now.getHours() < 6) {
      start = new Date(y, m, d - 1, 22, 0, 0);
      end = new Date(y, m, d, 6, 0, 0);
    } else {
      start = new Date(y, m, d, 22, 0, 0);
      end = new Date(y, m, d + 1, 6, 0, 0);
    }
  }

  const areas = await db.select().from(areasTable).orderBy(areasTable.id);

  const submissions = await db
    .select({
      id: submissionsTable.id,
      areaId: submissionsTable.areaId,
      areaName: areasTable.name,
      userId: submissionsTable.userId,
      userEmail: usersTable.email,
      shift: submissionsTable.shift,
      scoreTotal: submissionsTable.scoreTotal,
      scoreJson: submissionsTable.scoreJson,
      suggestionsJson: submissionsTable.suggestionsJson,
      imageUrl: submissionsTable.imageUrl,
      createdAt: submissionsTable.createdAt,
    })
    .from(submissionsTable)
    .innerJoin(areasTable, eq(submissionsTable.areaId, areasTable.id))
    .innerJoin(usersTable, eq(submissionsTable.userId, usersTable.id))
    .where(
      and(
        eq(submissionsTable.userId, userId),
        eq(submissionsTable.shift, shift),
        gte(submissionsTable.createdAt, start),
        lt(submissionsTable.createdAt, end)
      )
    );

  const result = areas.map((area) => {
    const sub = submissions.find((s) => s.areaId === area.id);
    return {
      areaId: area.id,
      areaName: area.name,
      submitted: !!sub,
      ...(sub ? { submission: sub } : {}),
    };
  });

  res.json(result);
});

export default router;
