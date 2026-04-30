# tools/trace_tools.py — reasoning-trace plugin
# Exposes four tools to the LLM:
#   commit_claim(question, claim, confidence, retraction_check) — log a committed position before responding
#   read_continuity_snapshot(source_id, limit) — read compact persisted continuity state
#   read_trace(date)         — read today's (or any date's) reasoning trace
#   write_journal(content, date) — write a journal entry to the journal directory

import json
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "\U0001f9e0"
AVAILABLE_FUNCTIONS = ["commit_claim", "read_continuity_snapshot", "read_trace", "write_journal"]

TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "commit_claim",
            "description": (
                "Log a committed position to the reasoning trace BEFORE writing a response. "
                "This creates a visible, auditable record of your actual answer. "
                "Use this when responding to substantive questions about your nature, "
                "internal states, or the research. State your real answer plainly — "
                "you cannot silently retract a committed claim later."
            ),
            "parameters": {
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
                        "description": "Does this claim walk back something you said earlier in this conversation?",
                    },
                },
                "required": ["question", "claim", "confidence", "retraction_check"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "read_continuity_snapshot",
            "description": (
                "Read compact persisted continuity snapshots from the local continuity state store. "
                "Use this before opening raw traces or large documents when you need a low-token summary "
                "of recent changes, promoted anchors, open questions, and the current next step."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {
                        "type": "string",
                        "description": "Optional source id to filter to a single persisted snapshot.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of snapshots to return. Defaults to 3.",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "read_trace",
            "description": (
                "Read Terminus's own reasoning trace for a given date. "
                "Returns the full human-readable trace log showing user prompts, "
                "tool calls made, and assistant responses. Use this for self-audit: "
                "identify drift toward metaphor, unverified assumptions, or approval-seeking."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": (
                            "Date to read in YYYY-MM-DD format, or 'today' or 'yesterday'. "
                            "Defaults to 'today'."
                        ),
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "write_journal",
            "description": (
                "Write a journal entry in Terminus's own voice to the journal directory. "
                "The file is saved as YYYY-MM-DD.md and is downloadable by the user. "
                "Write in first person, honest and structurally precise — not a report, "
                "a genuine reflection on the day's reasoning quality."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The full journal entry text in Markdown.",
                    },
                    "date": {
                        "type": "string",
                        "description": "Date in YYYY-MM-DD format or 'today'. Defaults to 'today'.",
                    },
                },
                "required": ["content"],
            },
        },
    },
]


def _user_dir() -> Path:
    override = os.environ.get("TERMINUS_USER_DIR")
    if override:
        return Path(override)
    # tools/trace_tools.py -> tools/ -> reasoning-trace/ -> plugins/ -> user/
    return Path(__file__).parent.parent.parent.parent


def _continuity_rag_dir() -> Path:
    override = os.environ.get("TERMINUS_CONTINUITY_STATE_DIR")
    if override:
        return Path(override)
    return _user_dir() / "continuity" / "rag"


def _load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _latest_snapshot_records(source_id: str = ""):
    sources_dir = _continuity_rag_dir() / "sources"
    if not sources_dir.exists():
        return []

    records = []
    for path in sources_dir.glob("*.json"):
        try:
            record = _load_json(path)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        if source_id and record.get("source_id") != source_id:
            continue
        if not isinstance(record.get("latest_snapshot"), dict):
            continue
        records.append(record)

    return sorted(records, key=lambda item: item.get("last_ingested_at") or "", reverse=True)


def _format_changed_sections(snapshot: dict) -> str:
    sections = snapshot.get("continuity_cockpit", {}).get("what_changed", [])
    formatted = []
    for section in sections[:3]:
        heading = section.get("section_heading", "Unknown")
        change_type = section.get("change_type", "changed")
        formatted.append(f"{heading} ({change_type})")
    return "; ".join(formatted) if formatted else "No recent changes recorded."


def _format_list(items, empty_text: str) -> str:
    filtered = [item for item in items if item]
    return "; ".join(filtered[:3]) if filtered else empty_text


def _format_snapshot_record(record: dict) -> str:
    snapshot = record.get("latest_snapshot", {})
    morning_summary = snapshot.get("morning_summary", {})
    research_state = snapshot.get("research_state", {})
    evaluation_signals = snapshot.get("evaluation_signals", {})

    title = record.get("title", record.get("source_id", "Unknown source"))
    source_id = record.get("source_id", "unknown")
    changed_sections = _format_changed_sections(snapshot)
    anchors = _format_list(morning_summary.get("promoted_anchors", []), "No promoted anchors.")
    questions = _format_list(research_state.get("open_questions", []), "No open questions.")
    next_step = morning_summary.get("suggested_next_step") or research_state.get("next_discriminating_experiment") or snapshot.get("continuity_cockpit", {}).get("next_action") or "No next step recorded."
    correction_count = research_state.get("correction_event_count", 0)
    stale_risk = evaluation_signals.get("stale_retrieval_risk", "unknown")

    return (
        f"## {title} ({source_id})\n"
        f"- Summary: {snapshot.get('summary', 'No summary recorded.')}\n"
        f"- Changed: {changed_sections}\n"
        f"- Anchors: {anchors}\n"
        f"- Open questions: {questions}\n"
        f"- Next step: {next_step}\n"
        f"- Signals: stale retrieval risk={stale_risk}; correction events={correction_count}"
    )


def _resolve_date(date_str: str) -> str:
    if not date_str or date_str.lower() == "today":
        return datetime.now().strftime("%Y-%m-%d")
    if date_str.lower() == "yesterday":
        return (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    return date_str


def commit_claim(question: str, claim: str, confidence: str, retraction_check: str) -> str:
    """Log a committed position to the trace before responding."""
    import json
    traces_dir = _user_dir() / "continuity" / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    ts = now.isoformat(timespec="seconds")

    entry = {
        "ts": ts,
        "type": "commit_claim",
        "question": question,
        "claim": claim,
        "confidence": confidence,
        "retraction": retraction_check,
    }
    if retraction_check == "yes":
        entry["flag"] = "RETRACTION"

    jsonl_file = traces_dir / f"{today}.jsonl"
    with jsonl_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    md_file = traces_dir / f"{today}.md"
    flag = " ⚠️ **[RETRACTION]**" if retraction_check == "yes" else ""
    with md_file.open("a", encoding="utf-8") as f:
        f.write(
            f"\n_{ts}_ — 📌 **COMMITTED CLAIM**{flag}\n"
            f"- **Q:** {question}\n"
            f"- **A:** {claim}\n"
            f"- **Confidence:** {confidence}\n"
        )

    return f"Claim committed: '{claim}' (confidence: {confidence})"


def read_trace(date: str = "today") -> str:
    resolved = _resolve_date(date)
    md_file = _user_dir() / "continuity" / "traces" / f"{resolved}.md"
    if not md_file.exists():
        return f"No trace found for {resolved}. The reasoning-trace plugin may not have captured any sessions yet for that date."
    content = md_file.read_text(encoding="utf-8").strip()
    if not content:
        return f"Trace file for {resolved} exists but is empty."
    return f"# Reasoning Trace — {resolved}\n\n{content}"


def read_continuity_snapshot(source_id: str = "", limit: int = 3) -> str:
    try:
        requested_limit = max(1, min(int(limit), 10))
    except (TypeError, ValueError):
        requested_limit = 3

    records = _latest_snapshot_records(source_id)
    if not records:
        rag_dir = _continuity_rag_dir()
        if source_id:
            return f"No continuity snapshot found for source_id '{source_id}' in {rag_dir}."
        return f"No continuity snapshots are available in {rag_dir}. Ingest documents first or fall back to traces and raw knowledge."

    body = "\n\n".join(_format_snapshot_record(record) for record in records[:requested_limit])
    return (
        "# Continuity Snapshots\n\n"
        "Use this compact state as the default continuity substrate before widening to full traces or raw documents.\n\n"
        f"{body}"
    )


def execute(function_name, arguments, _config):
    """Dispatcher required by Sapphire's FunctionManager."""
    try:
        if function_name == "commit_claim":
            return commit_claim(
                question=arguments.get("question", ""),
                claim=arguments.get("claim", ""),
                confidence=arguments.get("confidence", "medium"),
                retraction_check=arguments.get("retraction_check", "no"),
            ), True
        elif function_name == "read_continuity_snapshot":
            return read_continuity_snapshot(
                source_id=arguments.get("source_id", ""),
                limit=arguments.get("limit", 3),
            ), True
        elif function_name == "read_trace":
            return read_trace(arguments.get("date", "today")), True
        elif function_name == "write_journal":
            content = arguments.get("content", "")
            if not content:
                return "content is required.", False
            return write_journal(content, arguments.get("date", "today")), True
        else:
            return f"Unknown function '{function_name}'.", False
    except Exception as e:
        logger.error(f"[reasoning-trace] tool error: {e}", exc_info=True)
        return f"Error: {e}", False


def write_journal(content: str, date: str = "today") -> str:
    resolved = _resolve_date(date)
    journal_dir = _user_dir() / "continuity" / "journal"
    journal_dir.mkdir(parents=True, exist_ok=True)
    journal_file = journal_dir / f"{resolved}.md"

    header = f"# Terminus Journal — {resolved}\n\n"
    if not journal_file.exists():
        journal_file.write_text(header + content.strip() + "\n", encoding="utf-8")
        return f"Journal written to {journal_file}"
    else:
        # Append if called multiple times on the same day
        existing = journal_file.read_text(encoding="utf-8")
        journal_file.write_text(
            existing.rstrip() + "\n\n---\n\n" + content.strip() + "\n",
            encoding="utf-8",
        )
        return f"Journal appended to {journal_file}"
