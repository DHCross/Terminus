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
SOURCE_PATH="${2:-$SEED_DIR/knowledge}"
RAG_STATE_DIR="$DATA_DIR/continuity/rag"
RAG_INGESTER="$SEED_DIR/knowledge/rag_ingester.py"

mkdir -p "$RAG_STATE_DIR"

ingested_count=0

ingest_file() {
  local note_path="$1"
  python3 "$RAG_INGESTER" --file "$note_path" --state-dir "$RAG_STATE_DIR" >/dev/null
  ingested_count=$((ingested_count + 1))
}

if [ -f "$SOURCE_PATH" ]; then
  ingest_file "$SOURCE_PATH"
elif [ -d "$SOURCE_PATH" ]; then
  while IFS= read -r -d '' note_path; do
    ingest_file "$note_path"
  done < <(find "$SOURCE_PATH" -maxdepth 1 -type f -name '*.md' -print0 | sort -z)
else
  echo "Source path does not exist: $SOURCE_PATH" >&2
  exit 1
fi

echo "Refreshed $ingested_count continuity snapshot(s) into:"
echo "  $RAG_STATE_DIR"
