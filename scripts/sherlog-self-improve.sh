#!/usr/bin/env bash
set -euo pipefail

FEATURE="${1:-Sherlog Native Index}"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUT_DIR="velocity-artifacts/self-improve/${STAMP}"

mkdir -p "${OUT_DIR}"

echo "== Sherlog Self-Improve =="
echo "Feature: ${FEATURE}"
echo "Artifacts: ${OUT_DIR}"
echo

if [[ "${SHERLOG_REFRESH_CONTEXT:-0}" == "1" ]]; then
  echo "[1/9] Refreshing context map"
  npm run -s sherlog:init-context -- --force \
    --source-root scripts \
    --source-root sherlog-velocity/src | tee "${OUT_DIR}/init-context.log"
else
  echo "[1/9] Skipping context refresh (set SHERLOG_REFRESH_CONTEXT=1 to enable)"
  printf "skipped\n" | tee "${OUT_DIR}/init-context.log" >/dev/null
fi

echo "[2/9] Re-applying sherlog-map mode and tuned roots"
node -e '
const fs = require("fs");
const p = "sherlog-velocity/config/sherlog.config.json";
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
const mapFile = cfg?.context?.map_file || cfg?.paths?.context_map || "sherlog.context.json";
cfg.context = { ...(cfg.context || {}), mode: "sherlog-map", map_file: mapFile };
cfg.paths = {
  ...(cfg.paths || {}),
  context_map: mapFile,
  source_roots: ["scripts", "sherlog-velocity/src"]
};
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' | tee "${OUT_DIR}/config-normalize.log"

echo "[3/9] Seeding velocity snapshot"
npm run -s velocity:run | tee "${OUT_DIR}/velocity-run.log"

echo "[4/9] Updating velocity report"
npm run -s velocity:report | tee "${OUT_DIR}/velocity-report.log"

echo "[5/9] Verifying Sherlog install"
npm run -s sherlog:verify -- --json | tee "${OUT_DIR}/verify.json"

echo "[6/9] Running doctor"
npm run -s sherlog:doctor -- --feature "${FEATURE}" --json | tee "${OUT_DIR}/doctor.json"

echo "[7/9] Running gap scan"
npm run -s sherlog:gaps -- --feature "${FEATURE}" --json | tee "${OUT_DIR}/gaps.json"

echo "[8/9] Running hygiene scan"
npm run -s sherlog:hygiene -- --json | tee "${OUT_DIR}/hygiene.json"

echo "[9/9] Generating prompt"
npm run -s sherlog:prompt -- "${FEATURE}" | tee "${OUT_DIR}/prompt.txt"

echo
echo "Done. Outputs saved to ${OUT_DIR}"
