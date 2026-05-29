#!/bin/bash
# quickstart.sh — one-shot bring-up for the 5S tracker on a fresh checkout.
#
# Takes you from a clean clone to a running app:
#   1. verifies node + pnpm are present and new enough
#   2. checks .env exists (with the keys the servers need)
#   3. installs workspace deps (pnpm install)
#   4. builds the api-server
#   5. hands off to ./start.sh, which launches api-server (:8090) + vite (:3000)
#
# It is safe to re-run: pnpm install and start.sh are both idempotent, and
# start.sh leaves already-listening services alone.
#
# Flags:
#   --force    pass through to start.sh (kill anything on :3000/:8090 first)
#   --skip-install   skip `pnpm install` (deps already present)
#   -h|--help  show this help
#
# Exit codes:
#   0  both services are listening
#   1  a prerequisite or build step failed

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

FORWARD=()
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --force)        FORWARD+=("--force") ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m[quickstart]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[quickstart] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. prerequisites ----------
command -v node >/dev/null 2>&1 || die "node not found. Install Node 20+ (see .replit: nodejs-24)."
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Install with: corepack enable && corepack prepare pnpm@latest --activate"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  die "Node $(node -v) is too old; need >= 20."
fi
say "node $(node -v), pnpm $(pnpm -v)"

# ---------- 2. environment ----------
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  die ".env not found at $REPO_ROOT/.env — the servers need DATABASE_URL, SUPABASE_URL, SESSION_SECRET, etc."
fi
say ".env present"

# ---------- 3. install ----------
if (( SKIP_INSTALL )); then
  say "skipping pnpm install (--skip-install)"
else
  say "installing workspace dependencies (pnpm install)…"
  pnpm install
fi

# ---------- 4. build api-server ----------
if [[ ! -f "$REPO_ROOT/artifacts/api-server/dist/index.mjs" ]]; then
  say "building api-server…"
  pnpm --filter @workspace/api-server build
else
  say "api-server already built (dist/index.mjs present) — skipping build"
fi

# ---------- 5. launch ----------
say "starting services via ./start.sh…"
exec "$REPO_ROOT/start.sh" "${FORWARD[@]}"
