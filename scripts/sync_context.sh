#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT_FILE="$ROOT_DIR/sherlog.context.json"
TODAY="${1:-$(TZ="${TZ:-America/Chicago}" date +%F)}"

node - "$CONTEXT_FILE" "$TODAY" <<'NODE'
const fs = require('fs');

const contextFile = process.argv[2];
const today = process.argv[3];
const payload = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
const zones = Array.isArray(payload.zones) ? payload.zones : [];

const requiredZone = {
  name: 'Velocity Artifacts',
  paths: ['velocity-artifacts/**/*'],
  belief: 'Sherlog diagnostic telemetry artifacts used as lightweight project memory for creator-mirror reads, including velocity summaries and future sherlog-runs outputs.',
  last_updated: today,
};

const existing = zones.find((zone) => zone && zone.name === requiredZone.name);
if (existing) {
  existing.paths = requiredZone.paths;
  existing.belief = requiredZone.belief;
  existing.last_updated = today;
} else {
  zones.push(requiredZone);
}

payload.zones = zones;
fs.writeFileSync(contextFile, JSON.stringify(payload, null, 2) + '\n');
NODE

echo "Synced Sherlog context map: $CONTEXT_FILE"
