import app from "./app";
import { logger } from "./lib/logger";
import { checkFfmpegAvailable } from "./lib/keyframes";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
