#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
DEFAULT_NATIVE_DIR="/Volumes/My Passport/Sapphire-native"
DEFAULT_URL="https://localhost:8073"
STARTUP_WAIT_SECONDS="${STARTUP_WAIT_SECONDS:-60}"
SAPPHIRE_NATIVE_DIR="$DEFAULT_NATIVE_DIR"
STARTUP_PROMPT="${STARTUP_PROMPT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --prompt)
      STARTUP_PROMPT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [ -f "$ENV_FILE" ]; then
  env_native_dir="$(grep -E '^SAPPHIRE_NATIVE_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$env_native_dir" ]; then
    SAPPHIRE_NATIVE_DIR="$env_native_dir"
  fi
fi

if lsof -ti :8073 >/dev/null 2>&1; then
  echo "Terminus backend already running on :8073"
else
  if [ ! -d "$SAPPHIRE_NATIVE_DIR" ]; then
    echo "Native Terminus directory not found: $SAPPHIRE_NATIVE_DIR"
    echo "Update SAPPHIRE_NATIVE_DIR in $ENV_FILE or mount the external drive."
    exit 1
  fi

  if [ ! -x "$SAPPHIRE_NATIVE_DIR/.venv/bin/python3" ]; then
    echo "Missing Python environment: $SAPPHIRE_NATIVE_DIR/.venv/bin/python3"
    echo "Run setup first with: make setup"
    exit 1
  fi

  (
    cd "$SAPPHIRE_NATIVE_DIR"
    nohup env TERMINUS_REPO_ROOT="$REPO_ROOT" STARTUP_PROMPT="$STARTUP_PROMPT" .venv/bin/python3 main.py >/tmp/sapphire-native.log 2>&1 &
  )

  echo "Starting Terminus backend..."
  for _ in $(seq 1 "$STARTUP_WAIT_SECONDS"); do
    if lsof -ti :8073 >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if lsof -ti :8073 >/dev/null 2>&1; then
  echo "Opening $DEFAULT_URL"
  open "$DEFAULT_URL"
else
  echo "Backend did not bind :8073 within ${STARTUP_WAIT_SECONDS}s."
  echo "Check /tmp/sapphire-native.log for details."
  exit 1
fi
