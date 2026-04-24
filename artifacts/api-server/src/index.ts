import type { Server } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { checkFfmpegAvailable } from "./lib/keyframes";
import {
  flushPendingEscalationNotifications,
  recoverPendingEscalationNotifications,
} from "./lib/notifications";
import { startRepingScheduler } from "./lib/reping-scheduler";
import { startMetricsRetentionScheduler } from "./lib/metrics-retention";
import { startAiReliabilityMonitor } from "./lib/ai-reliability";

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

// In dev, a previous server process can momentarily linger on the port (e.g.
// pnpm-script signal forwarding can orphan a node child during workflow
// restarts). Briefly retry EADDRINUSE so a normal restart succeeds without
// manual intervention. In production we fail fast — a port collision there
// signals a real misconfiguration that should not be silently masked.
const isDev = process.env["NODE_ENV"] !== "production";
const MAX_LISTEN_RETRIES = isDev ? 25 : 0;
const LISTEN_RETRY_DELAY_MS = 200;

function listenWithRetry(attempt = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port);
    const onError = (err: NodeJS.ErrnoException): void => {
      srv.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" && attempt < MAX_LISTEN_RETRIES) {
        logger.warn(
          { port, attempt: attempt + 1, maxRetries: MAX_LISTEN_RETRIES },
          "Port in use — likely a previous dev process still shutting down; retrying",
        );
        setTimeout(() => {
          listenWithRetry(attempt + 1).then(resolve, reject);
        }, LISTEN_RETRY_DELAY_MS);
        return;
      }
      if (err.code === "EADDRINUSE") {
        logger.error(
          { port },
          "Port still in use after retries — another process is holding it. Free the port and try again.",
        );
      }
      reject(err);
    };
    const onListening = (): void => {
      srv.removeListener("error", onError);
      resolve(srv);
    };
    srv.once("error", onError);
    srv.once("listening", onListening);
  });
}

let server: Server;
try {
  server = await listenWithRetry();
} catch (err) {
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
startMetricsRetentionScheduler();
startAiReliabilityMonitor();

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
  // Forcibly drop keep-alive connections so server.close() doesn't hang on
  // idle clients holding the socket open across a restart.
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
  // Hard stop if close() still hangs for any reason.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
