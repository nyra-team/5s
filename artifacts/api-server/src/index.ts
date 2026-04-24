import app from "./app";
import { logger } from "./lib/logger";
import { checkFfmpegAvailable } from "./lib/keyframes";
import {
  flushPendingEscalationNotifications,
  recoverPendingEscalationNotifications,
} from "./lib/notifications";
import { startRepingScheduler } from "./lib/reping-scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Probe runtime dependencies in the background — non-fatal so the API keeps
// serving even if optional tooling is missing; we log a clear warning instead.
checkFfmpegAvailable().catch((err) =>
  logger.error({ err }, "ffmpeg probe failed unexpectedly"),
);

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Sweep escalations that were buffered in-memory by a previous process and
  // never made it out the door (e.g. mid-grouping-window restart). Fire and
  // forget so a slow DB doesn't block accepting requests; errors are logged
  // inside the sweep itself.
  recoverPendingEscalationNotifications().catch((err) =>
    logger.error({ err }, "Startup escalation recovery failed unexpectedly"),
  );

  startRepingScheduler();
});

// Graceful shutdown: flush any in-memory escalation digests so we don't drop
// notifications that were waiting in the grouping window.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down — flushing pending notifications");
  try {
    await flushPendingEscalationNotifications();
  } catch (err) {
    logger.error({ err }, "Failed to flush pending notifications during shutdown");
  }
  server.close(() => process.exit(0));
  // Hard stop if close() hangs (e.g. open keep-alive connections)
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
