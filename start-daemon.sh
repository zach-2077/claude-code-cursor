#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CCC_PORT:-32125}"
HOST="${CCC_HOST:-127.0.0.1}"
DATA_DIR="${CCC_DATA_DIR:-$HOME/.claude-code-cursor}"
PID_FILE="$DATA_DIR/daemon.pid"
LOG_DIR="$HOME/.claude/cache"
LOG_FILE="${CCC_LOG_FILE:-$LOG_DIR/claude-code-cursor.log}"
PLIST_LABEL="local.claude-code-cursor"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# Check if already running and healthy
if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
  EXISTING_PID="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  echo "claude-code-cursor daemon is already running on http://${HOST}:${PORT} (PID: ${EXISTING_PID:-unknown})"
  echo "Log file: $LOG_FILE"
  exit 0
fi

# Build dist/ if not built yet
if [[ ! -f "$SCRIPT_DIR/dist/cli.js" ]]; then
  echo "Building claude-code-cursor..."
  (cd "$SCRIPT_DIR" && bun run build)
fi

# Resolve runtime binary (prefer bun, fallback to node)
if command -v bun >/dev/null 2>&1; then
  RUNNER=("$(command -v bun)" "run" "$SCRIPT_DIR/dist/cli.js")
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  RUNNER=("$HOME/.bun/bin/bun" "run" "$SCRIPT_DIR/dist/cli.js")
else
  RUNNER=("$(command -v node)" "$SCRIPT_DIR/dist/cli.js")
fi

# Use macOS LaunchAgent when on default port & no extra CLI args, else detached nohup daemon
if [[ "$(uname -s)" == "Darwin" && -f "$PLIST_PATH" && "$PORT" == "32125" && $# -eq 0 ]]; then
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
else
  nohup "${RUNNER[@]}" serve --port "$PORT" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  DAEMON_PID=$!
  echo "$DAEMON_PID" >"$PID_FILE"
fi

# Wait up to 8s for health check
for _ in {1..32}; do
  if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    LIVE_PID="$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    [[ -n "$LIVE_PID" ]] && echo "$LIVE_PID" >"$PID_FILE"
    echo "Started claude-code-cursor daemon on http://${HOST}:${PORT} (PID: ${LIVE_PID:-unknown})"
    echo "Log file: $LOG_FILE"
    exit 0
  fi
  sleep 0.25
done

echo "Error: daemon failed to become healthy on http://${HOST}:${PORT}. Recent logs:" >&2
tail -n 20 "$LOG_FILE" >&2 || true
exit 1
