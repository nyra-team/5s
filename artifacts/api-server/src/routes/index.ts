import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import areasRouter from "./areas";
import submissionsRouter from "./submissions";
import dashboardRouter from "./dashboard";
import labelsRouter from "./labels";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(areasRouter);
router.use(submissionsRouter);
router.use(dashboardRouter);
router.use(labelsRouter);

export default router;
