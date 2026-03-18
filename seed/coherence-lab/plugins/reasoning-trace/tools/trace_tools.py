# tools/trace_tools.py — reasoning-trace plugin
# Exposes three tools to the LLM:
#   commit_claim(question, claim, confidence, retraction_check) — log a committed position before responding
#   read_trace(date)         — read today's (or any date's) reasoning trace
#   write_journal(content, date) — write a journal entry to the journal directory

import logging
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "\U0001f9e0"
AVAILABLE_FUNCTIONS = ["commit_claim", "read_trace", "write_journal"]

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
    # tools/trace_tools.py -> tools/ -> reasoning-trace/ -> plugins/ -> user/
    return Path(__file__).parent.parent.parent.parent


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


def execute(function_name, arguments, config):
    """Dispatcher required by Sapphire's FunctionManager."""
    try:
        if function_name == "commit_claim":
            return commit_claim(
                question=arguments.get("question", ""),
                claim=arguments.get("claim", ""),
                confidence=arguments.get("confidence", "medium"),
                retraction_check=arguments.get("retraction_check", "no"),
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
