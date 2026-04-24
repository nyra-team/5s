import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import areasRouter from "./areas";
import profilesRouter from "./profiles";
import submissionsRouter from "./submissions";
import dashboardRouter from "./dashboard";
import labelsRouter from "./labels";
import escalationsRouter from "./escalations";
import scheduleRouter from "./schedule";
import nudgesRouter from "./nudges";
import liveRouter from "./live";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(areasRouter);
router.use(profilesRouter);
router.use(submissionsRouter);
router.use(dashboardRouter);
router.use(labelsRouter);
router.use(escalationsRouter);
router.use(scheduleRouter);
router.use(nudgesRouter);
router.use(liveRouter);

export default router;
