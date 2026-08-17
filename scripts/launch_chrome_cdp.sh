#!/usr/bin/env bash
# launch_chrome_cdp.sh
#
# Launches your DAILY Google Chrome with remote debugging enabled on port 9222,
# so Terminus can attach to it and reuse your real logins, Bitwarden, tabs, and
# cookies. This is the "attach to daily Chrome" mode described in the README.
#
# Usage:
#   ./scripts/launch_chrome_cdp.sh            # uses your default Chrome profile
#   ./scripts/launch_chrome_cdp.sh --headless # headless (no visible window)
#
# Once this is running, Terminus's browser_open / browser_read_page will connect
# to it via CDP on port 9222 instead of launching its own isolated Chrome.
#
# To stop it: just quit Chrome normally, or `kill $(lsof -ti tcp:9222 -sTCP:LISTEN)`

set -euo pipefail

PORT=9222
HEADLESS=0
for arg in "$@"; do
  case "$arg" in
    --headless) HEADLESS=1 ;;
    --port=*) PORT="${arg#--port=}" ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
  esac
done

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME_APP" ]]; then
  echo "ERROR: Google Chrome not found at $CHROME_APP" >&2
  echo "Install Chrome or edit this script to point at your Chrome binary." >&2
  exit 1
fi

# Default user data dir = your real daily Chrome profile (so logins persist).
# On macOS this is where Chrome keeps its Default profile.
USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"

# If something is already listening on the port, Chrome will fail to bind.
if lsof -ti "tcp:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use. Terminus can attach to it directly."
  echo "If that's not Chrome, free the port first:  lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs kill"
  exit 0
fi

ARGS=(
  "--remote-debugging-port=${PORT}"
  "--user-data-dir=${USER_DATA_DIR}"
  "--no-first-run"
  "--no-default-browser-check"
)
if [[ "$HEADLESS" == "1" ]]; then
  ARGS+=("--headless=new")
fi

echo "Launching Chrome with CDP on port ${PORT}..."
echo "Profile: ${USER_DATA_DIR}"
echo "Terminus will attach via http://127.0.0.1:${PORT}"
echo
exec "$CHROME_APP" "${ARGS[@]}"
