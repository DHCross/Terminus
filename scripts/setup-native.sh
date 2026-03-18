#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve SAPPHIRE_NATIVE_DIR from .env or fall back to default
SAPPHIRE_NATIVE_DIR="/Volumes/My Passport/Sapphire-native"
if [ -f "$REPO_ROOT/.env" ]; then
  _dir="$(grep -E '^SAPPHIRE_NATIVE_DIR=' "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$_dir" ]; then SAPPHIRE_NATIVE_DIR="$_dir"; fi
fi

ERRORS=0

check() {
  local label="$1" ok="$2"
  if [ "$ok" = "1" ]; then
    printf "  %-30s OK\n" "$label"
  else
    printf "  %-30s MISSING\n" "$label"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "Checking prerequisites..."
echo ""

# Python 3.11+
if command -v python3 >/dev/null 2>&1; then
  PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  check "Python ($PY_VER)" 1
else
  check "Python 3.11+" 0
fi

# Node.js
if command -v node >/dev/null 2>&1 || [ -x /usr/local/bin/node ]; then
  NODE_VER="$(node --version 2>/dev/null || /usr/local/bin/node --version 2>/dev/null)"
  check "Node.js ($NODE_VER)" 1
else
  check "Node.js" 0
fi

# Task CLI
if command -v task >/dev/null 2>&1 || [ -x /opt/homebrew/bin/task ] || [ -x /usr/local/bin/task ]; then
  TASK_VER="$(task --version 2>/dev/null || /opt/homebrew/bin/task --version 2>/dev/null | head -1)"
  check "Task CLI ($TASK_VER)" 1
else
  check "Task CLI" 0
  echo "         Install: brew install go-task/tap/go-task"
fi

# uv
if command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ] || [ -x /opt/homebrew/bin/uv ]; then
  check "uv" 1
else
  check "uv" 0
  echo "         Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

# External drive
if [ -d "$SAPPHIRE_NATIVE_DIR" ]; then
  check "Sapphire-native directory" 1
else
  check "Sapphire-native directory" 0
  echo "         Expected: $SAPPHIRE_NATIVE_DIR"
  echo "         Is your external drive mounted?"
fi

echo ""

if [ "$ERRORS" -gt 0 ]; then
  echo "Fix the $ERRORS issue(s) above before continuing."
  exit 1
fi

# Create .env if missing
if [ ! -f "$REPO_ROOT/.env" ]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  echo "Created .env from .env.example — edit it to add your API keys."
fi

# Ensure .env.path in Sapphire-native points to our .env
ENV_PATH_FILE="$SAPPHIRE_NATIVE_DIR/.env.path"
EXPECTED_ENV_PATH="$REPO_ROOT/.env"
if [ -f "$ENV_PATH_FILE" ]; then
  CURRENT="$(head -1 "$ENV_PATH_FILE")"
  if [ "$CURRENT" != "$EXPECTED_ENV_PATH" ]; then
    echo "$EXPECTED_ENV_PATH" > "$ENV_PATH_FILE"
    echo "Updated .env.path to point to $EXPECTED_ENV_PATH"
  fi
else
  echo "$EXPECTED_ENV_PATH" > "$ENV_PATH_FILE"
  echo "Created .env.path pointing to $EXPECTED_ENV_PATH"
fi

# Refresh Python venv if needed
VENV_DIR="$SAPPHIRE_NATIVE_DIR/.venv"
REQ_FILE="$SAPPHIRE_NATIVE_DIR/requirements.txt"
if [ -d "$VENV_DIR" ] && [ -f "$REQ_FILE" ]; then
  echo "Syncing Python dependencies..."
  UV="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
  UV_LINK_MODE=copy "$UV" pip install -r "$REQ_FILE" --python "$VENV_DIR/bin/python3" 2>&1 | tail -3
fi

# Install Electron dependencies if needed
ELECTRON_DIR="$SAPPHIRE_NATIVE_DIR/electron-shell"
if [ -d "$ELECTRON_DIR" ] && [ ! -d "$ELECTRON_DIR/node_modules" ]; then
  echo "Installing Electron dependencies..."
  (cd "$ELECTRON_DIR" && npm install)
fi

cat <<'EOF'

Setup complete. Next steps:

  make launch              Start Sapphire natively
  make seed-coherence-lab  Install the Coherence Lab seed pack
  make logs                Tail runtime logs
  make stop                Stop Sapphire

EOF
