# functions/introspect.py
# Allows Terminus to read its own reasoning (thinking blocks) from the
# current chat session. Thinking is stored in the messages JSON but
# intentionally stripped from LLM context by Sapphire — this tool
# closes that loop by letting Terminus query its own prior reasoning.

import json
import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = '🪞'

AVAILABLE_FUNCTIONS = [
    'read_my_thinking',
]

TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "read_my_thinking",
            "description": (
                "Read your own hidden reasoning from a previous turn in this conversation. "
                "Sapphire captures your thinking but does not send it back to you automatically. "
                "Call this to retrieve and reflect on what you were actually reasoning before you responded. "
                "turns_back=1 is your most recent thinking, turns_back=2 is the one before that, etc."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "turns_back": {
                        "type": "integer",
                        "description": "How many assistant turns back to look. 1 = most recent (default).",
                        "default": 1
                    }
                },
                "required": []
            }
        }
    },
]


def _get_db_path():
    return Path(__file__).parent.parent / "user" / "history" / "sapphire_history.db"


def _get_active_chat_messages():
    """Return the messages list from the most recently updated chat."""
    db_path = _get_db_path()
    if not db_path.exists():
        return None, "Chat history database not found."

    conn = sqlite3.connect(db_path, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        cur = conn.cursor()
        cur.execute("SELECT name, messages FROM chats ORDER BY updated_at DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            return None, "No chat sessions found."
        chat_name, messages_json = row
        messages = json.loads(messages_json)
        return messages, chat_name
    finally:
        conn.close()


def execute(function_name, arguments, config):
    try:
        if function_name == "read_my_thinking":
            turns_back = int(arguments.get("turns_back", 1))
            if turns_back < 1:
                return "turns_back must be 1 or greater.", False

            messages, chat_name = _get_active_chat_messages()
            if messages is None:
                return chat_name, False  # chat_name holds the error string here

            # Collect assistant messages that have non-empty thinking
            thinking_turns = [
                m for m in messages
                if m.get("role") == "assistant" and m.get("thinking", "").strip()
            ]

            if not thinking_turns:
                return "No thinking blocks found in this conversation.", False

            if turns_back > len(thinking_turns):
                return (
                    f"Only {len(thinking_turns)} thinking block(s) available in this session. "
                    f"Requested turns_back={turns_back}."
                ), False

            target = thinking_turns[-turns_back]
            thinking = target["thinking"].strip()
            timestamp = target.get("timestamp", "unknown time")

            header = f"[Your reasoning from turn -{turns_back} | {timestamp} | chat: {chat_name}]\n\n"
            return header + thinking, True

        return f"Unknown function: {function_name}", False

    except Exception as e:
        logger.error(f"[introspect] {function_name} failed: {e}", exc_info=True)
        return f"Error: {str(e)}", False
