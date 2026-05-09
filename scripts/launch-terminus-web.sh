#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The web frontend is served by the backend on :8073.
# Delegate startup/wait/browser-open behavior to the existing launcher.
exec "$REPO_ROOT/scripts/launch-terminus-browser.sh" "$@"
