# E2E tests

Lightweight Puppeteer-driven smoke tests that drive a real browser against
a *running* api-server + vite dev server. Unlike the api-server's Vitest
suite, these don't mock the DB or the api — they exercise the same code
paths a real operator/manager would.

## Prerequisites

The dev environment must already be up:

```bash
./start.sh
```

Specs assume:

- frontend on `http://localhost:3000/`
- api-server on `http://localhost:8090/api`
- the `puppeteer-core` package is available in `node_modules` of any
  workspace package — we don't install a copy per-app
- `/usr/bin/chromium-browser` (or set `PUPPETEER_EXECUTABLE`)

## Running

From the repo root:

```bash
pnpm --filter @workspace/five-s e2e
```

Or run a single spec:

```bash
node artifacts/five-s/e2e/auth-flow.mjs
```

## What's covered

- **auth-flow.mjs** — Signup → forgot-password → set new password → login.
  The forgot-password flow uses dev-mode reset URLs that the api-server
  surfaces in the response body when `NODE_ENV !== production`.

## What's deliberately not covered

- File uploads (operator photo / video submission). Requires fixture
  media; left as a follow-up.
- Manager-only screens beyond login (dashboard, submissions). These pull
  data that depends on prior operator activity; the auth-flow spec is the
  bedrock everything else builds on.
