#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${DESKTOP_DIR:-${HOME}/Desktop}"
LAUNCHER_PATH="${DESKTOP_DIR}/Launch Terminus.command"
TARGET_SCRIPT="${REPO_ROOT}/scripts/launch-terminus-browser.sh"

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "Desktop directory not found: $DESKTOP_DIR"
  exit 1
fi

if [ ! -x "$TARGET_SCRIPT" ]; then
  echo "Launcher script is missing or not executable: $TARGET_SCRIPT"
  exit 1
fi

cat >"$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
exec "$TARGET_SCRIPT"
EOF

chmod +x "$LAUNCHER_PATH"

echo "Installed desktop launcher:"
echo "  $LAUNCHER_PATH"
echo ""
echo "Double-click it to start Terminus and open https://localhost:8073 in your browser."
