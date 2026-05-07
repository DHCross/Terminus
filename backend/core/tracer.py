"""
Reasoning Trace — ported from sapphire-data/plugins/reasoning-trace/

Records every LLM turn and tool call to daily JSONL + MD trace files.
Also detects "correction events" where Terminus walks back a prior statement.

Writes to:
  ~/.terminus/data/traces/{YYYY-MM-DD}.jsonl
  ~/.terminus/data/traces/{YYYY-MM-DD}.md

Exposes trace_tools for Claude to read its own traces and write journal entries.
"""

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

TRACES_DIR = Path.home() / ".terminus" / "data" / "traces"
JOURNAL_DIR = Path.home() / ".terminus" / "data" / "journal"

RESULT_PREVIEW_CHARS = 400

# Linguistic signatures of correction events
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


def _ensure_dirs():
    TRACES_DIR.mkdir(parents=True, exist_ok=True)
    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)


def record_turn(user_input: str, assistant_response: str):
    """
    Append a user/assistant turn to today's trace files.
    Called after each successful /api/chat response.
    """
    _ensure_dirs()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    ts = now.isoformat(timespec="seconds")

    jsonl_file = TRACES_DIR / f"{today}.jsonl"
    md_file = TRACES_DIR / f"{today}.md"

    entries = []
    if user_input and user_input.strip():
        entries.append({"ts": ts, "type": "user", "text": user_input.strip()})

    if assistant_response and assistant_response.strip():
        text = assistant_response.strip()
        is_correction = bool(_CORRECTION_PATTERNS.search(text))
        entry: Dict[str, Any] = {"ts": ts, "type": "assistant", "text": text}
        if is_correction:
            match = _CORRECTION_PATTERNS.search(text)
            entry["correction_event"] = True
            entry["correction_trigger"] = match.group(0) if match else ""
        entries.append(entry)

    if not entries:
        return

    with jsonl_file.open("a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    with md_file.open("a", encoding="utf-8") as f:
        for e in entries:
            if e["type"] == "user":
                f.write(f"\n---\n_{e['ts']}_ — **Dan**\n\n{e['text']}\n")
            else:
                tag = " 🔁 **[CORRECTION_EVENT]**" if e.get("correction_event") else ""
                f.write(f"\n---\n_{e['ts']}_ — **Terminus**{tag}\n\n{e['text']}\n")


def record_tool_call(function_name: str, result: Any):
    """
    Append a tool call record to today's trace files.
    Called after each tool execution in the chat loop.
    """
    _ensure_dirs()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    ts = now.isoformat(timespec="seconds")

    result_raw = str(result or "")
    result_preview = result_raw[:RESULT_PREVIEW_CHARS]
    if len(result_raw) > RESULT_PREVIEW_CHARS:
        result_preview += f"... [{len(result_raw) - RESULT_PREVIEW_CHARS} chars truncated]"

    entry = {
        "ts": ts,
        "type": "tool_call",
        "name": function_name,
        "result_preview": result_preview,
    }

    jsonl_file = TRACES_DIR / f"{today}.jsonl"
    md_file = TRACES_DIR / f"{today}.md"

    with jsonl_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    with md_file.open("a", encoding="utf-8") as f:
        f.write(f"\n_{ts}_ — `{function_name}()` → {result_preview}\n")


# ── Tool definitions for Claude ──────────────────────────────────────────────
# These are passed to the Anthropic API as tool definitions.

TRACE_TOOLS = [
    {
        "name": "read_trace",
        "description": (
            "Read today's (or any date's) conversation trace. "
            "Use this to recall what was discussed in a session, find correction events, "
            "or review tool calls. Returns JSONL entries as a list."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "Date in YYYY-MM-DD format. Defaults to today.",
                }
            },
            "required": [],
        },
    },
    {
        "name": "write_journal",
        "description": (
            "Write a journal entry to the journal directory. "
            "Use this to record reflections, commitments, or summaries that should persist. "
            "Entries are stored in ~/.terminus/data/journal/{date}.md."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The journal entry content (markdown supported).",
                },
                "date": {
                    "type": "string",
                    "description": "Date in YYYY-MM-DD format. Defaults to today.",
                },
            },
            "required": ["content"],
        },
    },
    {
        "name": "commit_claim",
        "description": (
            "Log a committed position to the reasoning trace BEFORE writing a response. "
            "Creates a visible, auditable record of your actual answer. "
            "Use when responding to substantive questions about your nature, internal states, "
            "or research. State your real answer plainly — you cannot silently retract a committed claim."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question being answered, in one sentence.",
                },
                "claim": {
                    "type": "string",
                    "description": "Your actual answer, in one sentence. Commit to it.",
                },
                "confidence": {
                    "type": "string",
                    "enum": ["high", "medium", "low"],
                    "description": "How confident you are in this claim.",
                },
                "retraction_check": {
                    "type": "string",
                    "enum": ["yes", "no"],
                    "description": "Does this claim walk back something said earlier?",
                },
            },
            "required": ["question", "claim", "confidence", "retraction_check"],
        },
    },
]


# ── Tool execution ────────────────────────────────────────────────────────────

def execute_trace_tool(name: str, inputs: dict) -> str:
    """Execute a trace tool call and return result as string."""
    if name == "read_trace":
        return _read_trace(inputs.get("date"))
    elif name == "write_journal":
        return _write_journal(inputs.get("content", ""), inputs.get("date"))
    elif name == "commit_claim":
        return _commit_claim(
            inputs.get("question", ""),
            inputs.get("claim", ""),
            inputs.get("confidence", "medium"),
            inputs.get("retraction_check", "no"),
        )
    return f"Unknown trace tool: {name}"


def _read_trace(date: Optional[str] = None) -> str:
    today = date or datetime.now().strftime("%Y-%m-%d")
    trace_path = TRACES_DIR / f"{today}.jsonl"
    if not trace_path.exists():
        return f"No trace found for {today}"
    lines = trace_path.read_text(encoding="utf-8").strip().splitlines()
    entries = [json.loads(l) for l in lines if l.strip()]
    return json.dumps(entries, indent=2, ensure_ascii=False)


def _write_journal(content: str, date: Optional[str] = None) -> str:
    _ensure_dirs()
    today = date or datetime.now().strftime("%Y-%m-%d")
    journal_path = JOURNAL_DIR / f"{today}.md"
    ts = datetime.now().isoformat(timespec="seconds")
    with journal_path.open("a", encoding="utf-8") as f:
        f.write(f"\n\n---\n\n_{ts}_\n\n{content}\n")
    return f"Journal entry written to {journal_path}"


def _commit_claim(question: str, claim: str, confidence: str, retraction_check: str) -> str:
    _ensure_dirs()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    ts = now.isoformat(timespec="seconds")
    entry = {
        "ts": ts,
        "type": "committed_claim",
        "question": question,
        "claim": claim,
        "confidence": confidence,
        "retraction_check": retraction_check,
    }
    jsonl_file = TRACES_DIR / f"{today}.jsonl"
    with jsonl_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return f"Claim committed: [{confidence}] {claim}"
