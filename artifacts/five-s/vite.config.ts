import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

// In dev, proxy /api/* to the api-server so same-origin URLs work without
// forcing each call site to know the api-server's absolute URL. This also
// lets the app work from other devices on the same network — the phone
// hits the dev box on :3000 and we proxy `/api/*` to the api-server
// server-side, so the browser never tries to resolve `localhost:8090`.
//
// `VITE_API_PROXY_TARGET` is server-side only (vite.config.ts runs on the
// dev machine, never shipped to the browser). It defaults to localhost
// because the api-server runs on the same host as vite. `VITE_API_URL`
// is kept as a deprecated alias so existing setups keep working.
const apiTarget =
  process.env.VITE_API_PROXY_TARGET ||
  process.env.VITE_API_URL ||
  "http://localhost:8090";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    // `vite preview` serves the production build (dist/public). It needs the
    // same `/api` proxy as the dev server so the SPA's relative `/api/*`
    // calls reach the api-server (otherwise they'd 404 against the static
    // server). Mirrors `server.proxy` above.
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
