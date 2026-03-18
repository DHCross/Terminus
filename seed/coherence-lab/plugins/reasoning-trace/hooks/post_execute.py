# hooks/post_execute.py — reasoning-trace plugin
# Fires after every tool call. Records function name + truncated result
# to today's JSONL trace so self-audit can see what actions were taken.

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

RESULT_PREVIEW_CHARS = 400


def _traces_dir() -> Path:
    return Path(__file__).parent.parent.parent.parent / "continuity" / "traces"


def post_execute(event):
    """Append tool call record to today's trace files."""
    try:
        traces_dir = _traces_dir()
        traces_dir.mkdir(parents=True, exist_ok=True)

        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        ts = now.isoformat(timespec="seconds")

        fn = event.function_name or "unknown"
        result_raw = str(event.result or "")
        result_preview = result_raw[:RESULT_PREVIEW_CHARS]
        if len(result_raw) > RESULT_PREVIEW_CHARS:
            result_preview += f"... [{len(result_raw) - RESULT_PREVIEW_CHARS} chars truncated]"

        entry = {
            "ts": ts,
            "type": "tool_call",
            "name": fn,
            "result_preview": result_preview,
        }

        jsonl_file = traces_dir / f"{today}.jsonl"
        with jsonl_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        md_file = traces_dir / f"{today}.md"
        with md_file.open("a", encoding="utf-8") as f:
            f.write(f"\n_{ts}_ — `{fn}()` → {result_preview}\n")

    except Exception as e:
        logger.warning(f"[reasoning-trace] post_execute failed: {e}")
