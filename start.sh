#!/bin/bash
# Bring up the api-server and the vite dev server for local development.
#
# Idempotent — if a service is already listening on its port, the script
# leaves it alone instead of double-starting. Each child detaches via
# nohup + disown so it survives this shell exiting. Stdout/stderr land in
# logs/{api,web}.log under the repo root (gitignored).
#
# Flags:
#   --rebuild      Run `pnpm --filter @workspace/api-server build` before
#                  starting the api-server. Use after editing TypeScript
#                  under artifacts/api-server/src.
#   --force        Kill anything already bound to :3000/:8090 first (calls
#                  stop.sh). Useful when the prior session left a zombie.
#   --prod         Serve the frontend as an optimized PRODUCTION build via
#                  `vite preview` (builds artifacts/five-s/dist/public first)
#                  instead of the hot-reloading dev server. The api-server is
#                  always the built dist regardless of this flag. Use for
#                  deployments; omit for local development (HMR).
#
# Exit codes:
#   0  both services are listening (started by us or already up)
#   1  one or more services failed to bind within the timeout

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"

REBUILD=0
FORCE=0
PROD=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --force)   FORCE=1 ;;
    --prod)    PROD=1 ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "FATAL: $REPO_ROOT/.env not found. Copy .env.example or set DATABASE_URL etc." >&2
  exit 1
fi

# Load .env into this shell so child processes inherit DATABASE_URL,
# AI_INTEGRATIONS_*, SESSION_SECRET, VITE_*, etc. `set -a` exports
# everything assigned; `set +a` restores normal behavior right after.
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a

if [[ "$FORCE" == "1" ]]; then
  echo "[start] --force: tearing down anything on :3000/:8090 first"
  "$REPO_ROOT/stop.sh" || true
  sleep 1
fi

# ---------- helpers ----------
port_listening() {
  ss -tln "sport = :$1" 2>/dev/null | tail -n +2 | grep -q .
}

wait_for_port() {
  local port=$1 label=$2 timeout=${3:-15}
  local elapsed=0
  while (( elapsed < timeout )); do
    if port_listening "$port"; then
      echo "[start] $label up on :$port"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "[start] $label did NOT bind :$port within ${timeout}s — see $LOG_DIR" >&2
  return 1
}

# ---------- api-server ----------
if port_listening 8090; then
  echo "[start] api-server already on :8090 — skipping"
else
  if [[ "$REBUILD" == "1" ]]; then
    echo "[start] --rebuild: building api-server"
    pnpm --filter @workspace/api-server build >/dev/null
  fi

  if [[ ! -f "$REPO_ROOT/artifacts/api-server/dist/index.mjs" ]]; then
    echo "[start] api-server dist missing — building"
    pnpm --filter @workspace/api-server build >/dev/null
  fi

  : > "$API_LOG"
  # setsid + nohup so the child fully escapes this shell's session group.
  # Without setsid systemd-logind reaps orphaned user processes when the
  # parent terminal closes (KillUserProcesses=yes on many distros),
  # which is what made vite die silently a few minutes after start.
  (
    cd "$REPO_ROOT/artifacts/api-server"
    PORT=8090 setsid nohup node --enable-source-maps ./dist/index.mjs \
      > "$API_LOG" 2>&1 < /dev/null &
    disown
  )
  wait_for_port 8090 "api-server"
fi

# ---------- frontend (vite) ----------
# Default: hot-reloading dev server. With --prod: build once and serve the
# optimized production bundle via `vite preview` (which honors preview.proxy
# in vite.config.ts so relative /api/* calls still reach :8090).
if [[ "$PROD" == "1" ]]; then
  VITE_MODE="preview (production build)"
else
  VITE_MODE="dev (HMR)"
fi

if port_listening 3000; then
  echo "[start] vite already on :3000 — skipping"
else
  if [[ "$PROD" == "1" ]]; then
    # Always rebuild so the served bundle matches the current source. The
    # build inlines VITE_* env at this point, so .env must already be loaded
    # (it is — see `set -a; . .env` above).
    echo "[start] --prod: building frontend production bundle"
    PORT=3000 BASE_PATH=/ pnpm --filter @workspace/five-s build >/dev/null
  fi

  : > "$WEB_LOG"
  # setsid + nohup so vite survives this shell exiting. PORT and BASE_PATH
  # are required by vite.config.ts; VITE_API_URL is already exported from
  # .env (empty by default → relative API paths so the app works from
  # devices on the same network).
  (
    cd "$REPO_ROOT/artifacts/five-s"
    if [[ "$PROD" == "1" ]]; then
      PORT=3000 BASE_PATH=/ setsid nohup node ./node_modules/vite/bin/vite.js \
        preview --config vite.config.ts --host 0.0.0.0 \
        > "$WEB_LOG" 2>&1 < /dev/null &
    else
      PORT=3000 BASE_PATH=/ setsid nohup node ./node_modules/vite/bin/vite.js \
        --config vite.config.ts --host 0.0.0.0 \
        > "$WEB_LOG" 2>&1 < /dev/null &
    fi
    disown
  )
  wait_for_port 3000 "vite"
  echo "[start] frontend mode: $VITE_MODE"
fi

# ---------- status ----------
LAN_IP=$(ip -o -4 addr show 2>/dev/null \
  | awk '$2 !~ /^(lo|docker|br-|veth)/ {split($4,a,"/"); print a[1]; exit}')
echo
echo "  Frontend     : http://localhost:3000/"
[[ -n "$LAN_IP" ]] && echo "  Frontend (LAN): http://$LAN_IP:3000/  (same-network devices)"
echo "  API          : http://localhost:8090/api"
echo "  Logs         : tail -f $API_LOG  /  tail -f $WEB_LOG"
echo
