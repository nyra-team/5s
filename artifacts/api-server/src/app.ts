import express, { type Express, type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/error-handler";
import { signedUrlForStorage, isStorageEnabled, storagePathForFilename } from "./lib/supabase-storage";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Dev: allow any origin so the SPA running on http://localhost:3000 and
// from LAN IPs (e.g. http://172.30.101.2:3000 from a phone) can call us.
// Prod: lock the allow-list to APP_ALLOWED_ORIGINS (comma-separated) so a
// hostile site can't replay an authenticated user's JWT.
const isDevEnv = process.env["NODE_ENV"] !== "production";
const allowed = (process.env["APP_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: isDevEnv
      ? true
      : (origin, cb) => {
          // No origin (server-to-server, curl): allow.
          if (!origin) return cb(null, true);
          if (allowed.includes(origin)) return cb(null, true);
          return cb(new Error(`Origin ${origin} not allowed by CORS`));
        },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Media serving — local-first with a Supabase Storage fallback. The
// fallback only kicks in when:
//   1. the requested filename ISN'T on local disk (e.g. the api-server
//      was redeployed on a fresh box that doesn't have the old uploads),
//   2. Storage is configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
// On miss we mint a 60-second signed URL and 302 to it. The signed URL
// has no auth requirement of its own (it's a one-shot capability link),
// which is fine because reaching this route in the first place required
// the operator-aware JWT-protected SPA to render the `<img src>`.
const uploadsDir = path.resolve(process.cwd(), "uploads");
app.use("/api/uploads", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Strip leading slash; reject any path that tries to escape uploadsDir.
  const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
  if (!rel || rel.includes("..") || rel.startsWith("/")) {
    res.status(400).end();
    return;
  }
  const local = path.join(uploadsDir, rel);
  if (fs.existsSync(local) && fs.statSync(local).isFile()) {
    res.sendFile(local);
    return;
  }
  if (!isStorageEnabled()) {
    res.status(404).end();
    return;
  }
  const signed = await signedUrlForStorage(storagePathForFilename(rel), 60);
  if (!signed) {
    res.status(404).end();
    return;
  }
  res.redirect(302, signed);
});

app.use("/api", router);

// Error middleware MUST be registered after the routes — Express only
// considers (err, req, res, next) handlers that come after the throwing
// route. See `middlewares/error-handler.ts` for what it does and why.
app.use(errorHandler);

export default app;
