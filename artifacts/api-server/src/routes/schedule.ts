import { Router, type IRouter } from "express";
import { authMiddleware } from "../lib/auth";
import { getNextChecks } from "../lib/schedule";

const router: IRouter = Router();

router.get("/operator/next-checks", authMiddleware, async (_req, res): Promise<void> => {
  const items = await getNextChecks();
  res.json(items);
});

export default router;
