#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="${DESKTOP_DIR:-${HOME}/Desktop}"
APP_PATH="${DESKTOP_DIR}/Terminus.app"
CONTENTS_DIR="$APP_PATH/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

echo "Installing Terminus launcher..."

# Create directory structure
mkdir -p "$MACOS_DIR"
mkdir -p "$CONTENTS_DIR/Resources"

# Create launcher script
cat >"$MACOS_DIR/Terminus" << 'EOF'
#!/bin/bash
REPO_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../../.." && pwd )"
"$REPO_ROOT/scripts/launch-terminus-browser.sh"
EOF
chmod +x "$MACOS_DIR/Terminus"

# Create Info.plist
cat >"$CONTENTS_DIR/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>Terminus</string>
	<key>CFBundleIdentifier</key>
	<string>local.terminus.launcher</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Terminus</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.9</string>
	<key>NSHumanReadableCopyright</key>
	<string>Copyright © 2026 Terminus. All rights reserved.</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
EOF

# Create PkgInfo
echo -n "APPL????" > "$CONTENTS_DIR/PkgInfo"

# Try to add a system icon if available
for icon_source in \
  "/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns" \
  "/System/Library/CoreServices/Terminal.app/Contents/Resources/Terminal.icns" \
  "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericApplicationIcon.icns" \
  "/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns"
do
  if [ -f "$icon_source" ]; then
    cp "$icon_source" "$CONTENTS_DIR/Resources/AppIcon.icns"
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon.icns" "$CONTENTS_DIR/Info.plist" 2>/dev/null || true
    echo "✓ Added icon from: $icon_source"
    break
  fi
done

# Update Finder
touch "$APP_PATH"
rm -f "$HOME/.DS_Store" 2>/dev/null || true

echo "✅ Installed Terminus.app to: $APP_PATH"
echo "   Double-click to launch Terminus"
