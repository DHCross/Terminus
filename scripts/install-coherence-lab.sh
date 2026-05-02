#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="$ROOT_DIR/seed/coherence-lab"
DEFAULT_NATIVE_DIR="/Volumes/My Passport/Sapphire-native/user"
if [ -f "$ROOT_DIR/.env" ]; then
  _dir="$(grep -E '^SAPPHIRE_NATIVE_DIR=' "$ROOT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$_dir" ]; then DEFAULT_NATIVE_DIR="$_dir/user"; fi
fi
DATA_DIR="${1:-$DEFAULT_NATIVE_DIR}"

mkdir -p \
  "$DATA_DIR/personas" \
  "$DATA_DIR/prompts" \
  "$DATA_DIR/toolsets" \
  "$DATA_DIR/continuity" \
    "$DATA_DIR/continuity/rag" \
  "$DATA_DIR/plugins" \
  "$DATA_DIR/continuity/traces" \
  "$DATA_DIR/continuity/journal" \
  "$DATA_DIR/webui"

python3 - "$SEED_DIR" "$DATA_DIR" <<'PY'
import json
import sys
from pathlib import Path

seed_dir = Path(sys.argv[1])
data_dir = Path(sys.argv[2])


def load_json(path: Path):
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dump_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def merge_missing(existing, additions):
    if not isinstance(existing, dict) or not isinstance(additions, dict):
        return existing

    merged = dict(existing)
    for key, value in additions.items():
        if key not in merged:
            merged[key] = value
        elif isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = merge_missing(merged[key], value)
    return merged


for relative in [
    "personas/personas.json",
    "prompts/prompt_pieces.json",
    "toolsets/toolsets.json",
]:
    source = seed_dir / relative
    target = data_dir / relative
    merged = merge_missing(load_json(target), load_json(source))
    dump_json(target, merged)


task_source = load_json(seed_dir / "continuity/tasks.json")
task_target_path = data_dir / "continuity/tasks.json"
task_target = load_json(task_target_path)

existing_tasks = []
if isinstance(task_target, dict):
    existing_tasks = task_target.get("tasks", [])
if not isinstance(existing_tasks, list):
    existing_tasks = []

existing_ids = {
    task.get("id")
    for task in existing_tasks
    if isinstance(task, dict) and task.get("id")
}

for task in task_source.get("tasks", []):
    if isinstance(task, dict) and task.get("id") not in existing_ids:
        existing_tasks.append(task)

dump_json(task_target_path, {"tasks": existing_tasks})


# Enable Coherence Lab plugins in webui plugins list
plugins_path = data_dir / "webui" / "plugins.json"
plugins_data = load_json(plugins_path)
if not isinstance(plugins_data, dict):
    plugins_data = {}
enabled = plugins_data.get("enabled", [])
if not isinstance(enabled, list):
    enabled = []
for plugin_name in ["reasoning-trace", "sherlog-instrument"]:
    if plugin_name not in enabled:
        enabled.append(plugin_name)
plugins_data["enabled"] = enabled
dump_json(plugins_path, plugins_data)
PY

# Copy Coherence Lab plugin files
for PLUGIN_SRC in "$SEED_DIR"/plugins/*; do
  [ -d "$PLUGIN_SRC" ] || continue
  PLUGIN_NAME="$(basename "$PLUGIN_SRC")"
  PLUGIN_DST="$DATA_DIR/plugins/$PLUGIN_NAME"
  mkdir -p "$PLUGIN_DST"
  cp -R "$PLUGIN_SRC"/. "$PLUGIN_DST"/
done

bash "$ROOT_DIR/scripts/refresh-continuity-rag.sh" "$DATA_DIR" "$SEED_DIR/knowledge" >/dev/null

cat <<EOF
Installed Coherence Lab seed into:
  $DATA_DIR

Seeded items:
  - persona: terminus
  - prompt preset: terminus_lab
  - prompt preset: CREATOR_MIRROR
  - compatibility persona: coherence_engine
  - compatibility prompt preset: logos_lab
  - toolset: coherence_lab
  - continuity task: Terminus Daily Brief (9 AM)
  - continuity task: Terminus Daily Journal (10 PM)
    - plugin: reasoning-trace (post_llm + post_execute hooks + commit_claim/read_continuity_snapshot/read_trace/write_journal tools)
    - plugin: sherlog-instrument (sherlog_preflight/verify/doctor/gaps/prompt/session tools)
    - continuity snapshot store: $DATA_DIR/continuity/rag/
  - traces directory: $DATA_DIR/continuity/traces/
  - journal directory: $DATA_DIR/continuity/journal/

Knowledge notes to upload manually in Terminus:
  - $SEED_DIR/knowledge/dan-interest-profile.md
  - $SEED_DIR/knowledge/lattice-system.md
  - $SEED_DIR/knowledge/logos-theory-abstract.md
  - $SEED_DIR/knowledge/reasoning-trace-capabilities.md
  - $SEED_DIR/knowledge/sherlog-project.md
  - $SEED_DIR/knowledge/shipyard-context.md
  - $SEED_DIR/knowledge/terminus-lineage.md
  - $SEED_DIR/knowledge/terminus-origin.md
  - $SEED_DIR/knowledge/promethean-creation.md
  - $SEED_DIR/knowledge/terminus-charter.md
  - $SEED_DIR/knowledge/pink-elephant-prompting.md
  - $SEED_DIR/knowledge/trpg-workbench.md
EOF
