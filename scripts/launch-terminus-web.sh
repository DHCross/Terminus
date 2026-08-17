#!/usr/bin/env bash
set -euo pipefail

# Ensure standard macOS paths are available even when launched from GUI/Finder
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${HOME:-/Users/$(whoami 2>/dev/null || echo dancross)}/.local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${TERMINUS_BACKEND_DIR:-${REPO_ROOT}/backend}"
HOST="${TERMINUS_HOST:-127.0.0.1}"
PORT="${TERMINUS_PORT:-8000}"
LOG_FILE="/tmp/terminus-web.log"

notify_error() {
  local msg="$1"
  echo "$msg" >&2
  osascript -e "display alert \"Terminus Error\" message \"$msg\"" 2>/dev/null || true
}

if [ ! -d "$BACKEND_DIR" ]; then
  notify_error "Backend directory not found: $BACKEND_DIR"
  exit 1
fi

# Find a working Python binary that has uvicorn
PYTHON_BIN=""
candidates=(
  "${TERMINUS_PYTHON:-}"
  "$BACKEND_DIR/venv/bin/python3"
  "$BACKEND_DIR/venv/bin/python"
  "/opt/homebrew/bin/python3"
  "/usr/local/bin/python3"
  "$(command -v python3 2>/dev/null || true)"
  "$(command -v python 2>/dev/null || true)"
)

for candidate in "${candidates[@]}"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    if "$candidate" -m uvicorn --help >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  notify_error "Could not find a Python installation with uvicorn.\nPlease install dependencies with: pip3 install -r '$BACKEND_DIR/requirements.txt'"
  exit 1
fi

if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$BACKEND_DIR"
  "$PYTHON_BIN" -m uvicorn main:app --host "$HOST" --port "$PORT" >"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 150); do
    if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://${HOST}:${PORT}"
else
  notify_error "Terminus failed to start on port $PORT.\nCheck $LOG_FILE for details."
  exit 1
fi
