import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getRepingSchedulerHealth } from "../lib/reping-scheduler.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Operational visibility into the re-ping scheduler. This endpoint is
 * intentionally NOT part of the public OpenAPI contract — it exists so
 * operators (or a separate uptime check) can confirm sweeps are still
 * completing without tailing logs. See `lib/reping-scheduler.ts` for
 * field semantics.
 */
router.get("/internal/reping-health", (_req, res) => {
  const h = getRepingSchedulerHealth();
  res.json({
    startedAt: h.startedAt?.toISOString() ?? null,
    ticks: h.ticks,
    sweepsStarted: h.sweepsStarted,
    sweepsCompleted: h.sweepsCompleted,
    sweepsFailed: h.sweepsFailed,
    ticksSkippedByOverlap: h.ticksSkippedByOverlap,
    watchdogWarnings: h.watchdogWarnings,
    currentSweepStartedAt: h.currentSweepStartedAt?.toISOString() ?? null,
    lastSweepStartedAt: h.lastSweepStartedAt?.toISOString() ?? null,
    lastSweepCompletedAt: h.lastSweepCompletedAt?.toISOString() ?? null,
    lastSweepDurationMs: h.lastSweepDurationMs,
    lastSweepDispatched: h.lastSweepDispatched,
    lastSweepError: h.lastSweepError
      ? { message: h.lastSweepError.message, at: h.lastSweepError.at.toISOString() }
      : null,
  });
});

export default router;
