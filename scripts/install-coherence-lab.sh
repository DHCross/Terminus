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
  "$DATA_DIR/continuity"

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
PY

cat <<EOF
Installed Coherence Lab seed into:
  $DATA_DIR

Seeded items:
  - persona: terminus
  - prompt preset: terminus_lab
  - compatibility persona: coherence_engine
  - compatibility prompt preset: logos_lab
  - toolset: coherence_lab
  - continuity task: Terminus Daily Brief (disabled)

Knowledge notes to upload manually in Sapphire:
  - $SEED_DIR/knowledge/dan-interest-profile.md
  - $SEED_DIR/knowledge/logos-theory-abstract.md
  - $SEED_DIR/knowledge/terminus-origin.md
  - $SEED_DIR/knowledge/promethean-creation.md
  - $SEED_DIR/knowledge/terminus-charter.md
  - $SEED_DIR/knowledge/pink-elephant-prompting.md
EOF
