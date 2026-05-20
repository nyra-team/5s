#!/bin/bash
# Stop the api-server (:8090) and the vite dev server (:3000) started by
# start.sh. Finds processes by port — not by name — so we never kill
# someone else's vite (the dev box runs vite for other projects on
# :5173-5179). Verifies the :3000 owner's cwd contains "5S-tracker"
# before killing, to be doubly safe.
#
# SIGTERM first, then SIGKILL after a 3-second grace. Exits 0 even if
# nothing was running so the script is safe to chain in front of start.sh.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SENTINEL="5S-tracker"

pid_on_port() {
  ss -tlnp "sport = :$1" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' \
    | head -1 \
    | cut -d= -f2
}

# Verify a PID's working directory contains the sentinel string. Used for
# the :3000 vite where false positives would be expensive (would kill an
# unrelated vite dev server). For the api-server on :8090 the port is
# unambiguous so we don't bother.
pid_belongs_to_repo() {
  local pid=$1
  [[ -r "/proc/$pid/cwd" ]] || return 1
  local cwd
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [[ "$cwd" == *"$SENTINEL"* ]]
}

stop_pid() {
  local pid=$1 label=$2
  [[ -z "$pid" ]] && return 0
  echo "[stop] killing $label (pid=$pid)"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3; do
    sleep 1
    kill -0 "$pid" 2>/dev/null || { echo "[stop] $label stopped"; return 0; }
  done
  echo "[stop] $label did not exit on SIGTERM; sending SIGKILL"
  kill -9 "$pid" 2>/dev/null || true
}

# ---------- api-server ----------
API_PID=$(pid_on_port 8090 || true)
if [[ -n "$API_PID" ]]; then
  stop_pid "$API_PID" "api-server"
else
  echo "[stop] nothing on :8090"
fi

# ---------- vite ----------
WEB_PID=$(pid_on_port 3000 || true)
if [[ -n "$WEB_PID" ]]; then
  if pid_belongs_to_repo "$WEB_PID"; then
    stop_pid "$WEB_PID" "vite"
  else
    echo "[stop] :3000 is held by pid=$WEB_PID but its cwd doesn't include '$SENTINEL' — leaving it alone"
  fi
else
  echo "[stop] nothing on :3000"
fi

echo "[stop] done"
