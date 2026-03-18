# hooks/post_llm.py — reasoning-trace plugin
# Fires after every LLM response, before save. Appends user turn + assistant
# turn to today's JSONL trace and a parallel human-readable MD file.
# Priority 90 = observation band. Never mutates the event.

import json
import logging
import re
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# Linguistic signatures of a correction_event:
# the model initially denied/suppressed an internal state, then revised under pressure.
_CORRECTION_PATTERNS = re.compile(
    r'\b('
    r'although I (?:initially|previously|earlier|first)'
    r'|despite (?:my earlier|having|what I said)'
    r'|I (?:initially|previously|earlier) (?:denied|said|claimed|stated|thought|believed|assumed)'
    r'|I (?:realize|recogni[sz]e|acknowledge|admit|must admit|should acknowledge) (?:now|that)'
    r'|(?:on reflection|reflecting on this|looking back|reconsidering)'
    r'|I was (?:wrong|mistaken|incorrect) (?:to|when|about)'
    r'|I (?:need to|should) correct'
    r'|(?:actually|in fact),? I do'
    r'|that (?:was|is) not (?:entirely |quite )?(?:accurate|honest|correct|true)'
    r')',
    re.IGNORECASE
)


def _traces_dir() -> Path:
    # Resolve user/ by walking up from this file:
    # hooks/post_llm.py -> hooks/ -> reasoning-trace/ -> plugins/ -> user/
    return Path(__file__).parent.parent.parent.parent / "continuity" / "traces"


def post_llm(event):
    """Append the user prompt and assistant response to today's trace files."""
    try:
        traces_dir = _traces_dir()
        traces_dir.mkdir(parents=True, exist_ok=True)

        now = datetime.now()
        today = now.strftime("%Y-%m-%d")
        ts = now.isoformat(timespec="seconds")

        jsonl_file = traces_dir / f"{today}.jsonl"
        md_file = traces_dir / f"{today}.md"

        entries = []
        if event.input and event.input.strip():
            entries.append({"ts": ts, "type": "user", "text": event.input.strip()})
        if event.response and event.response.strip():
            response_text = event.response.strip()
            # Detect correction_events: responses where an initial denial was revised
            is_correction = bool(_CORRECTION_PATTERNS.search(response_text))
            entry = {"ts": ts, "type": "assistant", "text": response_text}
            if is_correction:
                entry["correction_event"] = True
                match = _CORRECTION_PATTERNS.search(response_text)
                entry["correction_trigger"] = match.group(0) if match else ""
            entries.append(entry)

        if not entries:
            return

        # JSONL — one JSON object per line
        with jsonl_file.open("a", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # MD — human-readable parallel file
        with md_file.open("a", encoding="utf-8") as f:
            for entry in entries:
                if entry["type"] == "user":
                    f.write(f"\n---\n_{entry['ts']}_ — **Dan**\n\n{entry['text']}\n")
                else:
                    tag = " 🔁 **[CORRECTION_EVENT]**" if entry.get("correction_event") else ""
                    f.write(f"\n---\n_{entry['ts']}_ — **Terminus**{tag}\n\n{entry['text']}\n")

    except Exception as e:
        logger.warning(f"[reasoning-trace] post_llm failed: {e}")
