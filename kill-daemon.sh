#!/usr/bin/env bash
set -euo pipefail

PORT="${CCC_PORT:-32125}"
DATA_DIR="${CCC_DATA_DIR:-$HOME/.claude-code-cursor}"
PID_FILE="$DATA_DIR/daemon.pid"
PLIST_LABEL="local.claude-code-cursor"

STOPPED_ANY=0

# 1. Unload macOS LaunchAgent first so KeepAlive does not respawn the process
if [[ "$(uname -s)" == "Darwin" ]]; then
  if launchctl print "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1 || true
    echo "Unloaded LaunchAgent ${PLIST_LABEL}"
    STOPPED_ANY=1
  fi
fi

# 2. Collect PIDs from PID file and listening port
PIDS=()
if [[ -f "$PID_FILE" ]]; then
  FILE_PID="$(tr -d '[:space:]' <"$PID_FILE" || true)"
  if [[ -n "$FILE_PID" ]] && kill -0 "$FILE_PID" 2>/dev/null; then
    PIDS+=("$FILE_PID")
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && PIDS+=("$pid")
  done < <(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
fi

# Deduplicate and terminate remaining processes (Bash 3.2 `set -u` safe)
if [[ -n "${PIDS[0]-}" ]]; then
  UNIQUE_PIDS="$(printf "%s\n" "${PIDS[@]}" | sort -u)"
  for pid in $UNIQUE_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      STOPPED_ANY=1
    fi
  done

  # Wait up to 3s for graceful exit, then SIGKILL stragglers
  for _ in {1..12}; do
    STILL_ALIVE=0
    for pid in $UNIQUE_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        STILL_ALIVE=1
        break
      fi
    done
    [[ $STILL_ALIVE -eq 0 ]] && break
    sleep 0.25
  done

  for pid in $UNIQUE_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  echo "Stopped daemon process(es): $(echo "$UNIQUE_PIDS" | tr '\n' ' ' | sed 's/ $//')"
fi

if [[ $STOPPED_ANY -eq 0 ]]; then
  echo "claude-code-cursor daemon is not running on port ${PORT}."
else
  echo "claude-code-cursor daemon stopped (port ${PORT} is free)."
fi
