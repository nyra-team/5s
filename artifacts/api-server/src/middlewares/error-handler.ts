import type { ErrorRequestHandler } from "express";
import { logger, serializePgCause } from "../lib/logger";

/**
 * Central Express error middleware. Until Task 127 we had no error handler,
 * so a thrown DB error fell through to Express's built-in handler — which
 * printed the wrapper "Failed query: ..." but never the underlying Postgres
 * `code` / `detail` / `hint`. That meant on-call had to copy the SQL out and
 * replay it against psql to learn what Postgres actually objected to (Task 81
 * is the canonical example: `column submissions.created_at must appear in
 * the GROUP BY clause`, code `42803`).
 *
 * We log via `req.log` so the line is correlated with the request id and the
 * structured `cause` block (added by `errSerializer` in `lib/logger.ts`)
 * shows up alongside it. The 500 response includes the same diagnostic info
 * in development; production responses are intentionally generic so we don't
 * leak SQL or schema details to callers.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // pino-http augments Request with a per-request child logger. When the
  // middleware isn't wired (e.g. in unit tests that mount this handler on a
  // bare Express app) we fall back to the root logger so the error still
  // makes it somewhere visible.
  const log = (req as { log?: typeof logger }).log ?? logger;
  log.error({ err }, "request handler failed");

  if (res.headersSent) {
    // Express docs are explicit: once the response has started, delegate
    // back to the default handler so the connection is closed cleanly.
    return _next(err);
  }

  const body: Record<string, unknown> = { error: "internal_error" };
  if (!isProduction()) {
    const e = err as { message?: unknown; query?: unknown; cause?: unknown };
    if (typeof e.message === "string") body.message = e.message;
    if (typeof e.query === "string") body.query = e.query;
    const pg = serializePgCause(e.cause);
    if (pg) body.cause = pg;
  }
  res.status(500).json(body);
};
