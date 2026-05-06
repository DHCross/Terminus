#!/usr/bin/env bash
set -euo pipefail

SAPPHIRE_NATIVE_DIR="${1:?native directory required}"
TERMINUS_REPO_ROOT_VALUE="${2:?Terminus repo root required}"
STARTUP_PROMPT_VALUE="${3:-}"

if [ ! -x "$SAPPHIRE_NATIVE_DIR/.venv/bin/python3" ]; then
  echo "Missing Python environment: $SAPPHIRE_NATIVE_DIR/.venv/bin/python3" >&2
  exit 1
fi

"$SAPPHIRE_NATIVE_DIR/.venv/bin/python3" - "$SAPPHIRE_NATIVE_DIR" "$TERMINUS_REPO_ROOT_VALUE" "$STARTUP_PROMPT_VALUE" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

native_dir = Path(sys.argv[1]).resolve()
repo_root = sys.argv[2]
startup_prompt = sys.argv[3]
python_bin = native_dir / ".venv" / "bin" / "python3"
sapphire_py = native_dir / "sapphire.py"
log_path = Path("/tmp/sapphire-native.log")

env = os.environ.copy()
env["TERMINUS_REPO_ROOT"] = repo_root
env["STARTUP_PROMPT"] = startup_prompt

log = log_path.open("ab", buffering=0)
subprocess.Popen(
    [str(python_bin), str(sapphire_py)],
    cwd=str(native_dir),
    stdin=subprocess.DEVNULL,
    stdout=log,
    stderr=subprocess.STDOUT,
    env=env,
    start_new_session=True,
    close_fds=True,
)
PY
