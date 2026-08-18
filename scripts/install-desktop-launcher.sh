#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${DESKTOP_DIR:-${HOME}/Desktop}"
APP_BUNDLE="${DESKTOP_DIR}/Terminus.app"
LAUNCHER_PATH="${DESKTOP_DIR}/Launch Terminus.command"
TARGET_SCRIPT="${REPO_ROOT}/scripts/launch-terminus-web.sh"
ICNS_SOURCE="${REPO_ROOT}/backend/static/Terminus.icns"

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "Desktop directory not found: $DESKTOP_DIR"
  exit 1
fi

if [ ! -x "$TARGET_SCRIPT" ]; then
  echo "Launcher script is missing or not executable: $TARGET_SCRIPT"
  exit 1
fi

# 1. Create native macOS Terminus.app bundle with custom icon
mkdir -p "${APP_BUNDLE}/Contents/MacOS"
mkdir -p "${APP_BUNDLE}/Contents/Resources"

cat >"${APP_BUNDLE}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Terminus</string>
    <key>CFBundleIconFile</key>
    <string>Terminus</string>
    <key>CFBundleIdentifier</key>
    <string>com.terminus.app</string>
    <key>CFBundleName</key>
    <string>Terminus</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
</dict>
</plist>
EOF

cat >"${APP_BUNDLE}/Contents/MacOS/Terminus" <<EOF
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:\${HOME:-\$HOME}/.local/bin:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
exec "${TARGET_SCRIPT}"
EOF
chmod +x "${APP_BUNDLE}/Contents/MacOS/Terminus"

if [ -f "$ICNS_SOURCE" ]; then
  cp "$ICNS_SOURCE" "${APP_BUNDLE}/Contents/Resources/Terminus.icns"
fi

# Refresh Finder touch
touch "${APP_BUNDLE}"

# 2. Also keep Launch Terminus.command for convenience
cat >"$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:\${HOME:-\$HOME}/.local/bin:\${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
exec "$TARGET_SCRIPT"
EOF
chmod +x "$LAUNCHER_PATH"

echo "Installed native macOS desktop app and launcher:"
echo "  App:      $APP_BUNDLE (with modern Neural Nexus icon)"
echo "  Command:  $LAUNCHER_PATH"
echo ""
echo "Double-click Terminus on your Desktop to launch!"
