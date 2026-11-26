#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
INITIAL_BACKUP="$CLAUDE_DIR/settings.json.bak.20261126-before-cursor"
LAST_SWITCH_BACKUP="$CLAUDE_DIR/settings.json.last-switch.bak"

DATA_DIR="${CCC_DATA_DIR:-$HOME/.claude-code-cursor}"
PROFILES_DIR="$DATA_DIR/profiles"
ORIGINAL_PROFILE="$PROFILES_DIR/original.json"
CURSOR_PORT="${CCC_PORT:-32125}"
CURSOR_BASE_URL="http://127.0.0.1:${CURSOR_PORT}"

mkdir -p "$PROFILES_DIR"
chmod 700 "$DATA_DIR" "$PROFILES_DIR" 2>/dev/null || true

usage() {
  cat <<EOF
Usage: $(basename "$0") [cursor | original | toggle | status] [--kill-daemon]

Commands:
  cursor      Switch ~/.claude/settings.json to Cursor models (${CURSOR_BASE_URL}) and ensure daemon is running
  original    Restore ~/.claude/settings.json to your original gateway profile (e.g. LiteLLM :8787)
              (aliases: restore, litellm, off)
  toggle      Toggle between 'cursor' and 'original' (default when no command is given)
  status      Show active Claude Code profile and backend port status

Options:
  --kill-daemon   When switching to 'original', also stop the claude-code-cursor daemon
EOF
}

ACTION="toggle"
KILL_DAEMON=0

for arg in "$@"; do
  case "$arg" in
    cursor|on)
      ACTION="cursor"
      ;;
    original|restore|litellm|off)
      ACTION="original"
      ;;
    toggle)
      ACTION="toggle"
      ;;
    status)
      ACTION="status"
      ;;
    --kill-daemon)
      KILL_DAEMON=1
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# Seed original profile from the initial pre-Cursor backup if not yet saved
if [[ ! -f "$ORIGINAL_PROFILE" && -f "$INITIAL_BACKUP" ]]; then
  python3 - "$INITIAL_BACKUP" "$ORIGINAL_PROFILE" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, "r", encoding="utf-8") as f:
    data = json.load(f)
snapshot = {
    "env": data.get("env", {}),
    "model": data.get("model"),
}
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as out:
    json.dump(snapshot, out, indent=2)
    out.write("\n")
PY
fi

detect_current_mode() {
  if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo "none"
    return
  fi
  python3 - "$SETTINGS_FILE" "$CURSOR_PORT" <<'PY'
import json, sys
path, cursor_port = sys.argv[1], sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    base = str(data.get("env", {}).get("ANTHROPIC_BASE_URL", ""))
    token = str(data.get("env", {}).get("ANTHROPIC_AUTH_TOKEN", ""))
    if f":{cursor_port}" in base or token == "cursor-bridge":
        print("cursor")
    else:
        print("original")
except Exception:
    print("unknown")
PY
}

show_status() {
  local mode
  mode="$(detect_current_mode)"
  python3 - "$SETTINGS_FILE" "$mode" <<'PY'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    data = {}
env = data.get("env", {})
base = env.get("ANTHROPIC_BASE_URL", "(anthropic default)")
model = data.get("model") or env.get("ANTHROPIC_MODEL") or "(default)"
sonnet = env.get("ANTHROPIC_DEFAULT_SONNET_MODEL", "-")
opus = env.get("ANTHROPIC_DEFAULT_OPUS_MODEL", "-")
haiku = env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "-")
print(f"Active profile : {mode}")
print(f"Base URL       : {base}")
print(f"Session model  : {model}")
print(f"Sonnet ->      : {sonnet}")
print(f"Opus   ->      : {opus}")
print(f"Haiku  ->      : {haiku}")
PY
  if lsof -iTCP:"${CURSOR_PORT}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
    echo "Cursor daemon  : running (127.0.0.1:${CURSOR_PORT})"
  else
    echo "Cursor daemon  : stopped"
  fi
}

CURRENT_MODE="$(detect_current_mode)"

if [[ "$ACTION" == "status" ]]; then
  show_status
  exit 0
fi

if [[ "$ACTION" == "toggle" ]]; then
  if [[ "$CURRENT_MODE" == "cursor" ]]; then
    ACTION="original"
  else
    ACTION="cursor"
  fi
fi

# Save a safety backup before modifying ~/.claude/settings.json
if [[ -f "$SETTINGS_FILE" ]]; then
  cp -p "$SETTINGS_FILE" "$LAST_SWITCH_BACKUP"
fi

# If currently on non-cursor mode, refresh saved `original.json` snapshot so latest user edits aren't lost
if [[ "$CURRENT_MODE" == "original" && -f "$SETTINGS_FILE" ]]; then
  python3 - "$SETTINGS_FILE" "$ORIGINAL_PROFILE" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, "r", encoding="utf-8") as f:
    data = json.load(f)
snapshot = {
    "env": data.get("env", {}),
    "model": data.get("model"),
}
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as out:
    json.dump(snapshot, out, indent=2)
    out.write("\n")
PY
fi

if [[ "$ACTION" == "cursor" ]]; then
  python3 - "$SETTINGS_FILE" "$CURSOR_BASE_URL" <<'PY'
import json, os, sys
settings_path, base_url = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(settings_path):
    with open(settings_path, "r", encoding="utf-8") as f:
        data = json.load(f)

all_caps = "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking"
mid_caps = "effort,thinking,adaptive_thinking,interleaved_thinking"

data["env"] = {
    "ANTHROPIC_BASE_URL": base_url,
    "ANTHROPIC_AUTH_TOKEN": "cursor-bridge",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "composer-2.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Composer 2.5 (Cursor 200k)",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION": "Cursor Composer 2.5 (200k context)",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES": all_caps,
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "grok-4.7-500k",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "Grok 4.7 Max (Cursor 500k)",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION": "Cursor Grok 4.7 with 500k Max Mode context",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES": all_caps,
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "gemini-4-neon-1m[1m]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "Gemini 4 Neon Max (Cursor 1M)",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION": "Cursor Gemini 4 Neon with 1M Max Mode context",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES": all_caps,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "Gemini 3.8 Flash (Cursor 1M)",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION": "Fast Cursor model for Haiku & background tasks",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES": mid_caps,
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "gemini-4-carbon-1m[1m]",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Gemini 4 Carbon Max (Cursor 1M)",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Cursor Gemini 4 Carbon with 1M Max Mode context",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES": mid_caps,
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "200000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}
data["model"] = "sonnet"

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  echo "Switched ~/.claude/settings.json -> [cursor]"
  "$SCRIPT_DIR/start-daemon.sh"
  echo ""
  show_status
  exit 0
fi

if [[ "$ACTION" == "original" ]]; then
  if [[ ! -f "$ORIGINAL_PROFILE" ]]; then
    echo "Error: No saved original profile found at $ORIGINAL_PROFILE" >&2
    exit 1
  fi
  python3 - "$SETTINGS_FILE" "$ORIGINAL_PROFILE" <<'PY'
import json, os, sys
settings_path, orig_path = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(settings_path):
    with open(settings_path, "r", encoding="utf-8") as f:
        data = json.load(f)
with open(orig_path, "r", encoding="utf-8") as f:
    orig = json.load(f)

if orig.get("env"):
    data["env"] = orig["env"]
else:
    data.pop("env", None)

if orig.get("model") is not None:
    data["model"] = orig["model"]
else:
    data.pop("model", None)

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  echo "Switched ~/.claude/settings.json -> [original]"
  if [[ $KILL_DAEMON -eq 1 ]]; then
    "$SCRIPT_DIR/kill-daemon.sh"
  fi
  echo ""
  show_status
  exit 0
fi
