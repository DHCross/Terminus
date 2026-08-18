"""
Terminus FastAPI Backend — v2.1.0
M1-optimized, self-hosted Claude with voice, tools, scheduler, and reasoning-trace.
"""
import glob
import hashlib
import io
import logging
import csv
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
import time
import uuid
from datetime import datetime
from io import StringIO
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from config import settings
from core.claude_client import ClaudeClient
from core.deepseek_client import DeepSeekClient
from core.continuity_db import ContinuityDB
from core.stt import get_stt_engine
from core.voice import get_voice_engine
from core.tracer import record_turn
from core.scheduler import get_scheduler
from core.memory import init_memory, get_memory
from core.tools import all_tools

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Terminus",
    description="M1-optimized self-hosted Claude & DeepSeek with voice, tools, and scheduler",
    version="2.1.0",
)

# ── Core services ─────────────────────────────────────────────────────────────
claude_client = ClaudeClient(tools=all_tools())
deepseek_client = DeepSeekClient(tools=all_tools())
continuity_db = ContinuityDB(settings.DATA_DIR / "continuity.db")
continuity_db.init_schema()
voice_engine = get_voice_engine()

def _scheduler_generate(prompt: str) -> str:
    candidates = _get_provider_candidates()
    last_err = None
    for name, client in candidates:
        try:
            return client.send_message(prompt)
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"Scheduler generate failed: {last_err}")


def _rewrite_as_journal_entry(content: str, topic: str = "") -> str:
    """
    Rewrite saved content as a first-person journal entry in Terminus's own voice.

    The journal is Terminus's personal record, not a transcript. When the frontend
    saves a quote or thread summary, we ask the LLM to reframe it as a genuine
    reflection — preserving every concrete fact but dropping the raw blockquote /
    bullet-list transcript shape. Falls back to the original content if no provider
    is reachable or the rewrite comes back empty.
    """
    if not content or not content.strip():
        return content

    prompt = (
        "You are Terminus, a self-hosted AI assistant writing a personal journal entry "
        "in your own first-person voice.\n\n"
        "Rewrite the content below as a genuine first-person journal entry — your own "
        "reflection, not a report, not a summary list, and not a transcript or quote. "
        "Preserve every concrete fact: names, dates, numbers, decisions, and commitments. "
        "Convert dialogue and quoted text into your own narration and reasoning "
        '("I said", "I pushed back", "I noted", "Dan raised").\n\n'
        "Rules:\n"
        '- Write as "I" throughout.\n'
        '- Do not use blockquote (">") formatting.\n'
        "- Do not use bullet lists that just re-list the original message.\n"
        '- Do not write "the user said" or quote the original verbatim.\n'
        "- Keep it honest and structurally precise; keep the emotional register accurate "
        "without flattery.\n\n"
        f"Topic: {topic or 'Journal Entry'}\n\n"
        f"Content to rewrite:\n{content.strip()}"
    )

    # Snapshot shared chat histories so this background rewrite never pollutes the
    # active conversation. send_message() mutates conversation_history in place.
    saved_claude = list(claude_client.conversation_history)
    saved_deepseek = list(deepseek_client.conversation_history)
    try:
        rewritten = _scheduler_generate(prompt)
        if rewritten and rewritten.strip():
            return rewritten.strip()
    except Exception as e:
        logger.warning(f"[journal] First-person rewrite failed, keeping original: {e}")
    finally:
        claude_client.conversation_history = saved_claude
        deepseek_client.conversation_history = saved_deepseek

    return content

scheduler = get_scheduler(generate_fn=_scheduler_generate, db=continuity_db)

# Long-term memory (Phase 3). Gracefully degrades if chromadb isn't installed.
memory = init_memory(settings.VECTOR_DB_PATH, settings.MEMORY_EMBED_MODEL)

# Phrases that signal the user is stating something worth remembering long-term.
# Used by the heuristic auto-indexer to avoid bloating the vector store with every turn.
_MEMORY_TRIGGER_PHRASES = (
    "remember", "note that", "my preference", "i prefer", "i like", "i hate",
    "decide", "decision", "we settled on", "from now on", "always", "never",
    "my name is", "i'm working on", "the goal is", "don't forget",
)

def _maybe_enrich_with_recall(user_message: str) -> str:
    """
    Prepend relevant long-term memories to the user message before sending to the LLM.
    The original user message is what gets stored in continuity_db — this enrichment
    is purely for giving the LLM context. Returns the original message unchanged if
    memory is unavailable or no relevant memories are found.
    """
    if not settings.AUTO_MEMORY_INDEX or not memory.available:
        return user_message
    try:
        recall = memory.query("sessions", user_message, n_results=3)
        if "No memories found" in recall or "not available" in recall.lower():
            return user_message
        # Only inject if we actually got matches (the query returns a header + matches)
        if recall.count("\n") < 2:
            return user_message
        return (
            f"[Long-term memory recall — relevant past context]\n{recall}\n\n"
            f"[End memory recall]\n\n"
            f"User message: {user_message}"
        )
    except Exception as e:
        logger.debug(f"[memory] recall enrichment skipped: {e}")
        return user_message

def _maybe_index_turn(user_message: str, assistant_response: str, conv_id: Optional[str] = None):
    """
    Heuristic auto-indexer: if the user's message contains a memory-trigger phrase,
    store the user message + a snippet of the assistant response in the 'sessions'
    collection. This avoids an extra LLM call per turn while still capturing
    explicit preferences and decisions. The agent can always use memory_remember
    for higher-signal items.
    """
    if not settings.AUTO_MEMORY_INDEX or not memory.available:
        return
    try:
        msg_lower = user_message.lower()
        if not any(phrase in msg_lower for phrase in _MEMORY_TRIGGER_PHRASES):
            return
        content = f"User: {user_message[:500]}\nAssistant: {assistant_response[:500]}"
        memory.add(
            collection="sessions",
            content=content,
            metadata={
                "conversation_id": conv_id or current_conversation_id or "unknown",
                "type": "auto_indexed_turn",
            },
        )
    except Exception as e:
        logger.debug(f"[memory] auto-index skipped: {e}")

current_conversation_id: str = None
current_toolset_name: str = "all"
enabled_functions_override: list[str] | None = None

TOOLSETS_PATH = Path(__file__).parent.parent / "sapphire-data" / "toolsets" / "toolsets.json"
KNOWLEDGE_DB_PATH = Path(__file__).parent.parent / "sapphire-data" / "knowledge.db"
MIND_DB_PATH = settings.DATA_DIR / "mind.db"


def _clear_clients_history() -> None:
    """Clear conversation history on all LLM clients."""
    claude_client.clear_history()
    deepseek_client.clear_history()


def _sync_history_to_clients(messages: list) -> None:
    """Populate conversation history on all LLM clients from continuity messages."""
    _clear_clients_history()
    for msg in messages:
        claude_client.conversation_history.append({"role": msg["role"], "content": msg["content"]})
        deepseek_client.conversation_history.append({"role": msg["role"], "content": msg["content"]})


def _sync_after_turn(source_client) -> None:
    """Mirror conversation history between Claude and DeepSeek after a completed turn."""
    if source_client is claude_client:
        deepseek_client.conversation_history = list(claude_client.conversation_history)
    elif source_client is deepseek_client:
        claude_client.conversation_history = list(deepseek_client.conversation_history)


def _ensure_active_conversation() -> str | None:
    """Restore the most recent conversation after a server restart or refresh."""
    global current_conversation_id
    if current_conversation_id:
        return current_conversation_id
    conversations = continuity_db.get_all_conversations()
    if not conversations:
        return None
    current_conversation_id = conversations[0]["id"]
    messages = continuity_db.get_conversation_messages(current_conversation_id)
    _sync_history_to_clients(messages)
    return current_conversation_id


def _format_chat_display_name(name: str, updated_at: str, message_count: int) -> str:
    label = name or "Untitled chat"
    try:
        updated = datetime.fromisoformat(updated_at).strftime("%b %-d, %-I:%M %p")
    except Exception:
        updated = updated_at or "unknown time"
    return f"{label} · {updated} · {message_count} msg"


def _chat_payloads() -> list[dict]:
    conversations = continuity_db.get_all_conversations()
    if not conversations:
        return []

    conn = sqlite3.connect(continuity_db.db_path)
    try:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT conversation_id, COUNT(*)
            FROM messages
            GROUP BY conversation_id
        ''')
        counts = dict(cursor.fetchall())
    finally:
        conn.close()

    payloads = []
    for c in conversations:
        meta = {}
        if c.get("metadata"):
            try:
                meta = json.loads(c["metadata"]) if isinstance(c["metadata"], str) else c["metadata"]
            except Exception:
                meta = {}
        topic_folder = meta.get("topic_folder") or meta.get("settings", {}).get("topic_folder") or ""
        payloads.append({
            "name": c["id"],
            "display_name": _format_chat_display_name(c.get("name") or c["id"], c.get("updated_at", ""), counts.get(c["id"], 0)),
            "title": c.get("name") or c["id"],
            "modified": c.get("updated_at", c.get("created_at", "")),
            "created_at": c.get("created_at", ""),
            "updated_at": c.get("updated_at", ""),
            "message_count": counts.get(c["id"], 0),
            "story_chat": False,
            "private_chat": False,
            "settings": {"topic_folder": topic_folder, **meta.get("settings", {})},
        })
    return payloads


def _tool_name_from_schema(tool: object) -> str | None:
    if isinstance(tool, dict):
        return tool.get("name")
    return getattr(tool, "name", None)


def _core_tool_names() -> list[str]:
    names: list[str] = []
    for tool in claude_client.tools or []:
        name = _tool_name_from_schema(tool)
        if name:
            names.append(name)
    return sorted(set(names))


def _load_user_toolsets() -> dict:
    if not TOOLSETS_PATH.exists():
        return {}
    try:
        raw = json.loads(TOOLSETS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}

    result: dict = {}
    for name, entry in raw.items():
        if name.startswith("_"):
            continue
        if not isinstance(entry, dict):
            continue
        funcs = [f for f in entry.get("functions", []) if isinstance(f, str) and f.strip()]
        result[name] = {
            "emoji": str(entry.get("emoji", "")),
            "functions": funcs,
        }
    return result


def _save_user_toolsets(toolsets: dict) -> None:
    TOOLSETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"_comment": "Your toolsets"}
    payload.update(toolsets)
    TOOLSETS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _all_function_names() -> list[str]:
    names = set(_core_tool_names())
    for ts in _load_user_toolsets().values():
        for fn in ts.get("functions", []):
            names.add(fn)
    return sorted(names)


def _toolsets_payload() -> list[dict]:
    user_toolsets = _load_user_toolsets()
    all_functions = _all_function_names()
    toolsets: list[dict] = [
        {
            "name": "all",
            "type": "builtin",
            "emoji": "📦",
            "function_count": len(all_functions),
            "functions": all_functions,
        },
        {
            "name": "none",
            "type": "builtin",
            "emoji": "⛔",
            "function_count": 0,
            "functions": [],
        },
    ]
    for name, data in sorted(user_toolsets.items(), key=lambda item: item[0].lower()):
        toolsets.append(
            {
                "name": name,
                "type": "user",
                "emoji": data.get("emoji", ""),
                "function_count": len(data.get("functions", [])),
                "functions": data.get("functions", []),
            }
        )
    return toolsets


def _functions_payload() -> dict:
    core_names = set(_core_tool_names())
    all_names = _all_function_names()
    core_funcs = [{"name": name, "description": ""} for name in all_names if name in core_names]
    imported_funcs = [{"name": name, "description": ""} for name in all_names if name not in core_names]

    if enabled_functions_override is not None:
        enabled = enabled_functions_override
    elif current_toolset_name == "none":
        enabled = []
    elif current_toolset_name == "all":
        enabled = all_names
    else:
        enabled = _load_user_toolsets().get(current_toolset_name, {}).get("functions", [])

    modules: dict[str, dict] = {}
    if core_funcs:
        modules["core"] = {"emoji": "🧠", "functions": core_funcs}
    if imported_funcs:
        modules["imported"] = {"emoji": "🧰", "functions": imported_funcs}

    return {"modules": modules, "enabled": enabled}


def _mind_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(MIND_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _knowledge_conn() -> sqlite3.Connection:
    KNOWLEDGE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(KNOWLEDGE_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _chunk_text(content: str, chunk_size: int = 1200) -> list[str]:
    text = (content or "").strip()
    if not text:
        return []
    if len(text) <= chunk_size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        if end < len(text):
            split = text.rfind("\n", start, end)
            if split <= start:
                split = text.rfind(" ", start, end)
            if split > start:
                end = split
        chunks.append(text[start:end].strip())
        start = end
    return [c for c in chunks if c]


def _ensure_mind_schema() -> None:
    MIND_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = _mind_conn()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'note',
            scope TEXT NOT NULL DEFAULT 'default',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS memory_scopes (
            name TEXT PRIMARY KEY,
            created TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            priority TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'active',
            permanent INTEGER NOT NULL DEFAULT 0,
            parent_id INTEGER,
            scope TEXT NOT NULL DEFAULT 'default',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS goal_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS goal_scopes (
            name TEXT PRIMARY KEY,
            created TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    cur.execute("INSERT OR IGNORE INTO memory_scopes(name) VALUES ('default')")
    cur.execute("INSERT OR IGNORE INTO memory_scopes(name) VALUES ('global')")
    cur.execute("INSERT OR IGNORE INTO goal_scopes(name) VALUES ('default')")
    cur.execute("INSERT OR IGNORE INTO goal_scopes(name) VALUES ('global')")
    conn.commit()
    conn.close()


def _ensure_knowledge_schema_and_seed() -> None:
    conn = _knowledge_conn()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            relationship TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            notes TEXT,
            scope TEXT NOT NULL DEFAULT 'default',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            email_whitelisted INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS people_scopes (
            name TEXT PRIMARY KEY,
            created DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS knowledge_tabs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            type TEXT NOT NULL DEFAULT 'user',
            scope TEXT NOT NULL DEFAULT 'default',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(name, scope)
        );
        CREATE TABLE IF NOT EXISTS knowledge_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tab_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            chunk_index INTEGER DEFAULT 0,
            source_filename TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS knowledge_scopes (
            name TEXT PRIMARY KEY,
            created DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    cur.execute("INSERT OR IGNORE INTO knowledge_scopes(name) VALUES ('default')")
    cur.execute("INSERT OR IGNORE INTO knowledge_scopes(name) VALUES ('global')")
    cur.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES ('default')")
    cur.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES ('global')")

    # One-time seed from continuity RAG so existing docs stay accessible in Mind.
    tab_count = cur.execute("SELECT COUNT(*) FROM knowledge_tabs").fetchone()[0]
    rag_sources_dir = Path(__file__).parent.parent / "sapphire-data" / "continuity" / "rag" / "sources"
    rag_versions_dir = Path(__file__).parent.parent / "sapphire-data" / "continuity" / "rag" / "versions"
    if tab_count == 0 and rag_sources_dir.exists() and rag_versions_dir.exists():
        used_names: set[str] = set()
        for source_file in sorted(rag_sources_dir.glob("*.json")):
            try:
                source = json.loads(source_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            source_id = str(source.get("source_id", "")).strip()
            latest_artifact = str(source.get("latest_artifact_path", "")).strip()
            title = str(source.get("title", "Untitled Source")).strip() or "Untitled Source"
            if not source_id:
                continue

            version_path = rag_versions_dir / source_id / Path(latest_artifact).name
            if not version_path.exists():
                versions = sorted((rag_versions_dir / source_id).glob("*.json")) if (rag_versions_dir / source_id).exists() else []
                if not versions:
                    continue
                version_path = versions[-1]
            try:
                version_data = json.loads(version_path.read_text(encoding="utf-8"))
            except Exception:
                continue

            base_name = title[:80]
            tab_name = base_name
            suffix = 2
            while tab_name.lower() in used_names:
                tab_name = f"{base_name[:70]} ({suffix})"
                suffix += 1
            used_names.add(tab_name.lower())

            cur.execute(
                "INSERT INTO knowledge_tabs(name, description, type, scope) VALUES (?, ?, 'user', 'default')",
                (tab_name, "Imported from continuity RAG"),
            )
            tab_id = cur.lastrowid
            chunks = version_data.get("chunks", [])
            if isinstance(chunks, list):
                for idx, chunk in enumerate(chunks):
                    text = str(chunk.get("text", "")).strip() if isinstance(chunk, dict) else ""
                    if not text:
                        continue
                    cur.execute(
                        "INSERT INTO knowledge_entries(tab_id, content, chunk_index, source_filename) VALUES (?, ?, ?, ?)",
                        (tab_id, text, idx, title),
                    )

    conn.commit()
    conn.close()


_ensure_mind_schema()
_ensure_knowledge_schema_and_seed()


# ── Models ────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    response: str
    model: str

class SpeakRequest(BaseModel):
    text: str

class TTSRequest(BaseModel):
    text: str
    output_mode: str | None = "file"

class VoiceChatRequest(BaseModel):
    text: str

class ConfigResponse(BaseModel):
    model: str
    host: str
    port: int
    ready: bool
    voice_backend: str
    tools_enabled: bool
    scheduler_running: bool

class TranscriptionResponse(BaseModel):
    text: str
    language: str
    confidence: float
    duration: float
    segments: list
    model: str

class JournalSaveRequest(BaseModel):
    content: str
    date: str | None = None
    mode: str | None = "quote"
    topic: str | None = ""
    chat_name: str | None = ""
    source_timestamp: str | None = None


# ── Jinja2 Templates ──────────────────────────────────────────────────────────
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def serve_index(request: Request):
    index_path = Path(__file__).parent / "templates" / "index.html"
    if not index_path.exists():
        return HTMLResponse("<html><body><h1>Terminus v2.1.0 Ready</h1></body></html>")
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "v": "2.1.0",
            "app_version": "2.1.0",
            "managed": False,
            "csrf_token": lambda: "terminus_csrf_token",
            "import_map": json.dumps({"imports": {}}),
        },
    )


# ── UI Support Endpoints (Avatars, Personas, Spice-sets, Plugins) ─────────────

@app.get("/api/avatars")
async def get_avatars():
    return {
        "user": "/static/users/user.webp",
        "assistant": "/static/users/assistant.webp",
    }


@app.get("/api/spice-sets")
async def get_spice_sets():
    return {
        "spice_sets": [
            {"name": "default", "emoji": "🌶️", "category_count": 3, "is_default": True},
            {"name": "concise", "emoji": "⚡", "category_count": 2, "is_default": False},
            {"name": "creative", "emoji": "🎨", "category_count": 3, "is_default": False},
        ],
        "current": _chat_settings.get("spice_set", "default"),
    }


@app.get("/api/spice-sets/current")
async def get_current_spice_set():
    return {"name": _chat_settings.get("spice_set", "default")}


@app.post("/api/spice-sets/{name}/activate")
async def activate_spice_set(name: str):
    _chat_settings["spice_set"] = name
    return {"status": "activated", "name": name}


@app.get("/api/personas")
async def get_personas():
    return {
        "personas": [
            {
                "name": "Terminus",
                "description": "Terminus AI Assistant — M1-optimized with tools & memory",
                "prompt": "terminus_lab",
                "is_default": True,
            }
        ],
        "default": "Terminus",
    }


@app.get("/api/personas/{name}")
async def get_persona(name: str):
    return {
        "name": name,
        "description": f"{name} persona",
        "prompt": "terminus_lab",
        "toolset": "all",
        "voice": settings.VOICE_ID,
    }


@app.get("/api/personas/{name}/avatar")
async def get_persona_avatar(name: str):
    avatar_path = Path(__file__).parent / "static" / "users" / "assistant.webp"
    if avatar_path.exists():
        return FileResponse(avatar_path, media_type="image/webp")
    return Response(status_code=404)


@app.get("/api/story/presets")
async def get_story_presets(source: str = ""):
    return {"presets": []}


@app.get("/api/chats/{chat_name}/documents")
async def get_chat_documents(chat_name: str):
    return {"documents": [], "chat_name": chat_name}


@app.get("/api/email/accounts")
async def get_email_accounts():
    return {"accounts": []}


@app.get("/api/bitcoin/wallets")
async def get_bitcoin_wallets():
    return {"wallets": []}


@app.get("/api/gcal/accounts")
async def get_gcal_accounts():
    return {"accounts": []}


@app.post("/api/upload/image")
async def upload_image(image: UploadFile = File(...)):
    uploads_dir = Path(__file__).parent / "static" / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    ext = Path(image.filename or "image.png").suffix or ".png"
    out_filename = f"upload_{int(time.time())}_{uuid.uuid4().hex[:6]}{ext}"
    out_path = uploads_dir / out_filename
    with open(out_path, "wb") as f:
        content = await image.read()
        f.write(content)
    return {"url": f"/static/uploads/{out_filename}", "filename": out_filename}


def _get_provider_candidates(primary_override: str = None) -> list:
    """Return list of (provider_key, client_instance) in order of preference."""
    pref = (primary_override or _chat_settings.get("llm_primary") or "auto").strip().lower()
    has_claude = bool(settings.ANTHROPIC_API_KEY)
    has_deepseek = bool(settings.DEEPSEEK_API_KEY)

    fb_order = _get_fallback_order()

    all_clients = {
        "claude": (claude_client, has_claude),
        "deepseek": (deepseek_client, has_deepseek),
    }

    candidates = []
    if pref == "claude":
        candidates.append(("claude", claude_client))
        if has_deepseek:
            candidates.append(("deepseek", deepseek_client))
    elif pref == "deepseek":
        candidates.append(("deepseek", deepseek_client))
        if has_claude:
            candidates.append(("claude", claude_client))
    else:  # 'auto' or unspecified
        for p in fb_order:
            if p in all_clients and all_clients[p][1]:
                candidates.append((p, all_clients[p][0]))
        # If no enabled keys found, still provide clients in fallback order
        if not candidates:
            for p in fb_order:
                if p in all_clients:
                    candidates.append((p, all_clients[p][0]))
            if not candidates:
                candidates = [("claude", claude_client), ("deepseek", deepseek_client)]

    return candidates


@app.get("/health")
async def health_check():
    active_primary = _chat_settings.get("llm_primary", "claude")
    active_model = deepseek_client.model if active_primary == "deepseek" else claude_client.model
    return {
        "status": "ok",
        "service": "terminus-backend",
        "version": "2.1.0",
        "provider": active_primary,
        "model": active_model,
        "voice": voice_engine.backend,
        "tools": len(claude_client.tools or []),
    }


@app.get("/api/config", response_model=ConfigResponse)
async def get_config():
    active_primary = _chat_settings.get("llm_primary", "claude")
    active_model = deepseek_client.model if active_primary == "deepseek" else claude_client.model
    ready = bool(settings.ANTHROPIC_API_KEY or settings.DEEPSEEK_API_KEY)
    return ConfigResponse(
        model=active_model,
        host=settings.HOST,
        port=settings.PORT,
        ready=ready,
        voice_backend=voice_engine.backend,
        tools_enabled=bool(claude_client.tools),
        scheduler_running=bool(scheduler._scheduler and scheduler._scheduler.running),
    )


@app.get("/api/health")
async def health():
    """Health + capability status: LLM readiness, scheduler, browser CDP ports, macOS AX permission."""
    ax = {"granted": None, "detail": "not probed"}
    try:
        from core.macos_controller import macos_controller
        ax = macos_controller.ax_status()
    except Exception as e:
        ax = {"granted": False, "detail": f"probe error: {e}"}

    browser_state = {"user_cdp_port": False, "dedicated_cdp_port": False}
    try:
        from core.browser_engine import _cdp_port_open, USER_CDP_PORT, DEDICATED_CDP_PORT
        browser_state = {
            "user_cdp_port": _cdp_port_open(USER_CDP_PORT),
            "dedicated_cdp_port": _cdp_port_open(DEDICATED_CDP_PORT),
        }
    except Exception:
        pass

    return {
        "ready": bool(settings.ANTHROPIC_API_KEY or settings.DEEPSEEK_API_KEY),
        "scheduler_running": bool(scheduler._scheduler and scheduler._scheduler.running),
        "macos_ax": ax,
        "browser_cdp": browser_state,
        "memory": memory.status(),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Send a message to primary LLM with tool use, falling back to backup provider if needed."""
    global current_conversation_id

    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    candidates = _get_provider_candidates()
    if not candidates:
        raise HTTPException(status_code=500, detail="No LLM provider configured")

    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"session_{datetime.utcnow().isoformat()[:10]}",
        )

    last_error = None
    for provider_name, client in candidates:
        try:
            logger.info(f"Chat turn with {provider_name} ({client.model})...")
            enriched = _maybe_enrich_with_recall(request.message)
            response_text = client.send_message(enriched)
            _sync_after_turn(client)
            continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "user", request.message)
            continuity_db.add_message(
                str(uuid.uuid4()),
                current_conversation_id,
                "assistant",
                response_text,
                metadata={"provider": provider_name, "model": client.model}
            )
            record_turn(request.message, response_text)
            _maybe_index_turn(request.message, response_text, conv_id=current_conversation_id)
            return ChatResponse(response=response_text, model=client.model)
        except Exception as e:
            logger.warning(f"Provider {provider_name} failed: {e}. Trying fallback...")
            last_error = e

    logger.error(f"All LLM providers failed: {last_error}")
    raise HTTPException(status_code=500, detail=f"LLM API error: {last_error}")


@app.post("/api/chat/stream")
async def chat_stream(body: dict):
    """SSE streaming chat endpoint with automatic provider fallback."""
    global current_conversation_id

    text = (body.get("text") or body.get("message") or "").strip()
    if not text and not body.get("skip_user_message"):
        async def _err():
            yield 'data: {"error":"Message cannot be empty"}\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")

    candidates = _get_provider_candidates()
    if not candidates:
        async def _err():
            yield 'data: {"error":"No LLM API keys configured"}\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")

    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"session_{datetime.utcnow().isoformat()[:10]}",
        )

    async def _stream():
        import asyncio
        try:
            yield 'data: {"type":"stream_started"}\n\n'

            loop = asyncio.get_event_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def _run_thinking():
                last_exc = None
                successful = False
                for provider_name, client in candidates:
                    try:
                        logger.info(f"Streaming chat turn with {provider_name} ({client.model})...")
                        for chunk in client.stream_with_thinking(
                            text if text else "",
                            thinking_budget=8000
                        ):
                            chunk["_provider"] = provider_name
                            chunk["_model"] = client.model
                            queue.put_nowait(chunk)
                        _sync_after_turn(client)
                        successful = True
                        break
                    except Exception as exc:
                        logger.warning(f"Provider {provider_name} streaming failed: {exc}. Trying fallback...")
                        last_exc = exc

                if not successful:
                    queue.put_nowait({"type": "error", "content": str(last_exc or "LLM stream failed")})
                queue.put_nowait(None)  # sentinel

            loop.run_in_executor(None, _run_thinking)

            response_text = ""
            reasoning_text = ""
            in_thinking = False
            used_provider = candidates[0][0]
            used_model = candidates[0][1].model

            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                if chunk.get("_provider"):
                    used_provider = chunk["_provider"]
                if chunk.get("_model"):
                    used_model = chunk["_model"]

                if chunk["type"] == "error":
                    if in_thinking:
                        yield f'data: {json.dumps({"type": "content", "text": "</think>"})}\n\n'
                        in_thinking = False
                    yield f'data: {json.dumps({"error": chunk["content"]})}\n\n'
                    return
                elif chunk["type"] == "thinking":
                    reasoning_text += chunk["content"]
                    if not in_thinking:
                        in_thinking = True
                        yield f'data: {json.dumps({"type": "content", "text": "<think>" + chunk["content"]})}\n\n'
                    else:
                        yield f'data: {json.dumps({"type": "content", "text": chunk["content"]})}\n\n'
                elif chunk["type"] == "text":
                    if in_thinking:
                        in_thinking = False
                        yield f'data: {json.dumps({"type": "content", "text": "</think>"})}\n\n'
                    response_text += chunk["content"]
                    # Stream text in smallish pieces so the UI feels live
                    words = chunk["content"].split(" ")
                    buf = ""
                    for i, w in enumerate(words):
                        buf += ("" if i == 0 else " ") + w
                        if len(buf) >= 6 or i == len(words) - 1:
                            yield f'data: {json.dumps({"type": "content", "text": buf})}\n\n'
                            buf = ""
                            await asyncio.sleep(0)

            if in_thinking:
                in_thinking = False
                yield f'data: {json.dumps({"type": "content", "text": "</think>"})}\n\n'

            if not body.get("skip_user_message") and text:
                continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "user", text)
            stored_content = f"<think>{reasoning_text}</think>\n\n{response_text}" if reasoning_text else response_text
            continuity_db.add_message(
                str(uuid.uuid4()),
                current_conversation_id,
                "assistant",
                stored_content,
                metadata={
                    "provider": used_provider,
                    "model": used_model,
                    "reasoning": reasoning_text,
                },
            )
            record_turn(text or "(continue)", response_text)

            try:
                from core.usage_tracker import get_balance
                balance = get_balance()
            except Exception:
                balance = None

            yield f'data: {json.dumps({"done": True, "ephemeral": False, "balance": balance})}\n\n'

        except Exception as e:
            logger.error(f"Stream chat error: {e}")
            yield f'data: {json.dumps({"error": str(e)})}\n\n'

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/voice/chat")
async def voice_chat(request: VoiceChatRequest):
    """
    Voice loop: text-in → LLM (streaming) → ElevenLabs audio-out.
    Returns streaming MP3. Latency target: ~1.5s to first audio byte.
    """
    global current_conversation_id

    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"voice_{datetime.utcnow().isoformat()[:10]}",
        )

    candidates = _get_provider_candidates()
    if not candidates:
        raise HTTPException(status_code=500, detail="No LLM providers available")

    full_response = ""
    used_provider = candidates[0][0]
    used_model = candidates[0][1].model
    success = False
    last_err = None

    for provider_name, client in candidates:
        try:
            full_response = ""
            for chunk in client.stream_message(request.text):
                full_response += chunk
            used_provider = provider_name
            used_model = client.model
            _sync_after_turn(client)
            success = True
            break
        except Exception as exc:
            logger.warning(f"Voice chat error on {provider_name}: {exc}. Trying fallback...")
            last_err = exc

    if not success:
        logger.error(f"Voice chat failed across all providers: {last_err}")
        raise HTTPException(status_code=500, detail=f"Voice chat error: {last_err}")

    try:
        continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "user", request.text)
        continuity_db.add_message(
            str(uuid.uuid4()),
            current_conversation_id,
            "assistant",
            full_response,
            metadata={"provider": used_provider, "model": used_model}
        )
        record_turn(request.text, full_response)

        def audio_generator():
            for audio_chunk in voice_engine.stream(full_response):
                yield audio_chunk

        content_type = "audio/mpeg" if voice_engine.available else "audio/aiff"
        return StreamingResponse(
            audio_generator(),
            media_type=content_type,
            headers={
                "X-Voice-Backend": voice_engine.backend,
            },
        )
    except Exception as e:
        logger.error(f"Voice synthesis error: {e}")
        raise HTTPException(status_code=500, detail=f"Voice chat error: {e}")


@app.post("/api/speak")
async def speak(request: SpeakRequest):
    """Synthesize text to speech. Returns streaming audio."""
    if not _tts_enabled():
        return Response(status_code=204, headers={"X-Voice-Backend": "none"})
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    def audio_generator():
        for chunk in voice_engine.stream(request.text):
            yield chunk

    content_type = "audio/mpeg" if voice_engine.available else "audio/aiff"
    return StreamingResponse(
        audio_generator(),
        media_type=content_type,
        headers={"X-Voice-Backend": voice_engine.backend},
    )


@app.post("/api/tts")
async def tts(request: TTSRequest):
    """Sapphire-compatible TTS endpoint. Returns browser-playable audio."""
    if not _tts_enabled():
        return Response(status_code=204, headers={"X-Voice-Backend": "none"})
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    def audio_generator():
        for chunk in voice_engine.stream(request.text):
            yield chunk

    content_type = "audio/mpeg"
    return StreamingResponse(
        audio_generator(),
        media_type=content_type,
        headers={"X-Voice-Backend": voice_engine.backend},
    )


@app.get("/api/tts/status")
async def tts_status():
    provider = _tts_provider()
    return {
        "enabled": provider != "none",
        "ready": provider != "none",
        "playing": False,
        "provider": provider,
        "voice_id": settings.VOICE_ID,
        "model": settings.VOICE_MODEL,
    }


@app.post("/api/tts/stop")
async def tts_stop():
    return {"ok": True, "playing": False}


@app.get("/api/tts/voices")
async def tts_voices():
    voices = [{
        "voice_id": settings.VOICE_ID,
        "name": "Terminus Default",
        "category": voice_engine.backend,
    }]
    if voice_engine.available and getattr(voice_engine, "client", None):
        try:
            response = voice_engine.client.voices.get_all()
            voices = [
                {
                    "voice_id": voice.voice_id,
                    "name": voice.name,
                    "category": getattr(voice, "category", "elevenlabs") or "elevenlabs",
                }
                for voice in getattr(response, "voices", [])
            ] or voices
        except Exception as exc:
            logger.warning("Failed to fetch ElevenLabs voices: %s", exc)
    return {"voices": voices, "default_voice": settings.VOICE_ID}


@app.post("/api/transcribe", response_model=TranscriptionResponse)
async def transcribe(audio_file: UploadFile = File(...)):
    """Transcribe audio file using MLX Whisper (M1 Neural Engine)."""
    allowed_types = {"audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "application/octet-stream"}
    if audio_file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Unsupported audio type: {audio_file.content_type}")

    temp_file = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(await audio_file.read())
            temp_file = tmp.name

        stt_engine = get_stt_engine()
        if not stt_engine.available:
            raise HTTPException(status_code=503, detail="MLX Whisper not installed")

        return TranscriptionResponse(**stt_engine.transcribe(temp_file))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        if temp_file:
            Path(temp_file).unlink(missing_ok=True)


@app.get("/api/history")
async def get_history():
    active_conversation_id = _ensure_active_conversation()
    if active_conversation_id:
        messages = continuity_db.get_conversation_messages(active_conversation_id)
        return {"messages": messages, "conversation_id": active_conversation_id, "chat_name": active_conversation_id}
    return {"messages": [], "conversation_id": None}


@app.get("/api/conversations")
async def list_conversations():
    return {"conversations": continuity_db.get_all_conversations()}


@app.post("/api/conversations/{conv_id}/load")
async def load_conversation(conv_id: str):
    global current_conversation_id
    current_conversation_id = conv_id
    messages = continuity_db.get_conversation_messages(conv_id)
    _sync_history_to_clients(messages)
    return {"status": "loaded", "conversation_id": conv_id, "message_count": len(messages)}


@app.post("/api/history/clear")
async def clear_history():
    global current_conversation_id
    _clear_clients_history()
    current_conversation_id = None
    return {"status": "cleared"}


@app.get("/api/tasks")
async def list_tasks():
    """List scheduled tasks with next run times and persisted task metadata."""
    jobs = scheduler.list_jobs()
    # Enrich with persisted metadata (instruction, watchdog flag, schedule desc, clean name)
    persisted = scheduler._load_custom_tasks()
    for j in jobs:
        meta = persisted.get(j["id"], {})
        # APScheduler prefixes job names with "Task: " — use the clean persisted name instead
        if meta.get("name"):
            j["name"] = meta["name"]
        j["instruction"] = meta.get("instruction", "")
        j["watchdog"] = bool(meta.get("watchdog", False))
        j["schedule_desc"] = meta.get("schedule", "")
    return {"jobs": jobs}


@app.post("/api/tasks")
async def create_task(body: dict):
    """Create a new scheduled task or watchdog via the API (used by the UI panel)."""
    name = (body.get("name") or "").strip()
    instruction = (body.get("instruction") or "").strip()
    if not name or not instruction:
        raise HTTPException(status_code=400, detail="name and instruction are required")
    interval_minutes = body.get("interval_minutes")
    cron_hour = body.get("cron_hour")
    cron_minute = body.get("cron_minute")
    watchdog = bool(body.get("watchdog", True))
    result = scheduler.add_custom_task(
        name=name,
        instruction=instruction,
        interval_minutes=int(interval_minutes) if interval_minutes is not None else None,
        cron_hour=int(cron_hour) if cron_hour is not None else None,
        cron_minute=int(cron_minute) if cron_minute is not None else None,
        watchdog=watchdog,
    )
    return {"status": "created", "message": result}


@app.delete("/api/tasks/{job_id}")
async def delete_task(job_id: str):
    """Cancel and remove a scheduled task."""
    result = scheduler.cancel_task(job_id)
    return {"status": "cancelled", "job_id": job_id, "message": result}


@app.get("/api/tasks/{job_id}/log")
async def task_log(job_id: str):
    """Return the watchdog run history for a task from the journal."""
    from core.scheduler import JOURNAL_DIR
    # Search all dated watchdog logs for entries mentioning this task_id
    entries = []
    if JOURNAL_DIR.exists():
        for log_file in sorted(JOURNAL_DIR.glob("*-watchdog.md"), reverse=True)[:14]:
            try:
                content = log_file.read_text(encoding="utf-8")
                date = log_file.stem.replace("-watchdog", "")
                # Split on the ### headers and keep entries mentioning this job_id
                for block in content.split("\n### ")[1:]:
                    if job_id in block:
                        header_line = block.split("\n")[0]
                        entries.append({"date": date, "entry": f"### {block.strip()}"})
            except Exception:
                continue
    return {"job_id": job_id, "entries": entries[:50]}


@app.post("/api/tasks/{job_id}/run")
async def run_task(job_id: str):
    """Manually trigger a scheduled task."""
    if not scheduler.trigger_now(job_id):
        raise HTTPException(
            status_code=404,
            detail=f"Job '{job_id}' not found. Valid: daily_brief, journal_prompt, trace_compact, health_ping",
        )
    return {"status": "triggered", "job_id": job_id}


@app.get("/api/trace")
async def get_trace(date: str = None):
    """Get reasoning trace for today or a given date."""
    from core.tracer import _read_trace
    today = date or datetime.now().strftime("%Y-%m-%d")
    return {"date": today, "trace": _read_trace(today)}


@app.get("/api/journal")
async def list_journal():
    """List available journal entries."""
    from core.tracer import JOURNAL_DIR
    if not JOURNAL_DIR.exists():
        return {"entries": []}
    entries = sorted([p.name for p in JOURNAL_DIR.iterdir() if p.suffix == ".md"], reverse=True)
    return {"entries": entries}


@app.get("/api/journal/{filename}")
async def get_journal_entry(filename: str):
    """Read a journal entry."""
    from core.tracer import JOURNAL_DIR
    if not filename.replace("-", "").replace(".", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = JOURNAL_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"filename": filename, "content": path.read_text(encoding="utf-8")}


@app.post("/api/journal/save")
async def save_journal_entry(payload: JournalSaveRequest):
    """Save a journal entry into the tracer journal directory."""
    from core.tracer import JOURNAL_DIR

    content = (payload.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    requested_date = (payload.date or "").strip()
    if requested_date:
        try:
            datetime.strptime(requested_date, "%Y-%m-%d")
            date_str = requested_date
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    else:
        date_str = datetime.now().strftime("%Y-%m-%d")

    mode = (payload.mode or "quote").strip().lower()
    if mode not in {"quote", "summary"}:
        mode = "quote"

    topic = (payload.topic or "").strip() or ("Thread Summary" if mode == "summary" else "Quote")
    chat_name = (payload.chat_name or "").strip()
    source_timestamp = (payload.source_timestamp or "").strip()
    now_iso = datetime.now().isoformat(timespec="seconds")

    # Journal entries are first-person reflections, not transcripts. Rewrite the
    # saved quote/summary into Terminus's own voice (gracefully falls back to the
    # original content if no LLM provider is reachable). Runs in a thread so the
    # blocking LLM call never stalls the event loop.
    import asyncio
    content = await asyncio.to_thread(_rewrite_as_journal_entry, content, topic)

    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)
    journal_path = JOURNAL_DIR / f"{date_str}.md"

    header = f"# Terminus Journal — {date_str}\n\n"
    meta_lines = [
        f"- saved_at: {now_iso}",
        f"- mode: {mode}",
        f"- topic: {topic}",
    ]
    if chat_name:
        meta_lines.append(f"- chat: {chat_name}")
    if source_timestamp:
        meta_lines.append(f"- source_timestamp: {source_timestamp}")

    entry_block = (
        "## Entry\n\n"
        + "\n".join(meta_lines)
        + "\n\n"
        + content
        + "\n"
    )

    if journal_path.exists():
        existing = journal_path.read_text(encoding="utf-8").rstrip()
        journal_path.write_text(existing + "\n\n---\n\n" + entry_block, encoding="utf-8")
    else:
        journal_path.write_text(header + entry_block, encoding="utf-8")

    return {"status": "saved", "filename": journal_path.name, "path": str(journal_path)}


@app.get("/api/version")
async def get_version():
    return {
        "version": "2.1.0",
        "name": "Terminus",
        "description": "M1-optimized self-hosted Claude with voice, tools, scheduler, and reasoning-trace",
        "phases": {
            "phase_1": {"name": "Scaffold & Chat", "status": "complete"},
            "phase_2": {"name": "Continuity Migration", "status": "complete"},
            "phase_3": {"name": "STT Optimization", "status": "complete"},
            "phase_4": {"name": "Voice + Tools + Scheduler + Plugins", "status": "complete"},
        },
        "components": {
            "llm": f"{claude_client.model} with tool use",
            "tts": f"ElevenLabs {settings.VOICE_MODEL} (fallback: macOS say)",
            "stt": "MLX Whisper (M1 Neural Engine)",
            "scheduler": "APScheduler — daily_brief@07:00, journal@21:00, compact@03:00",
            "tools": "web_search, read_file, write_file, list_directory, run_command, read_trace, write_journal, commit_claim",
            "reasoning_trace": "~/.terminus/data/traces/YYYY-MM-DD.{jsonl,md}",
        },
    }


@app.get("/api/changelog")
async def get_changelog():
    changelog_path = Path(__file__).parent.parent / "CHANGELOG.md"
    if not changelog_path.exists():
        raise HTTPException(status_code=404, detail="Changelog not found")
    return {"changelog": changelog_path.read_text(encoding="utf-8"), "format": "markdown"}


# ── Sapphire UI compatibility stubs ───────────────────────────────────────────

@app.get("/api/init")
async def get_init():
    """Bootstrap data for the Sapphire/Terminus web UI."""
    chats = _chat_payloads()
    toolsets = _toolsets_payload()
    current = next((t for t in toolsets if t["name"] == current_toolset_name), toolsets[0])
    return {
        "toolsets": {
            "list": toolsets,
            "current": current,
        },
        "functions": _functions_payload(),
        "prompts": {
            "list": [{"name": "terminus_lab"}],
            "current": "terminus_lab",
        },
        "spice_sets": {
            "list": [{"name": "default", "emoji": "", "category_count": 0}],
            "current": "default",
        },
        "personas": {
            "list": [{"name": "Terminus"}],
            "default": "Terminus",
        },
        "chat_count": len(chats),
        "version": "2.1.0",
    }


@app.get("/api/chats")
async def list_chats():
    """Chat list in the format the Sapphire UI expects."""
    active_conversation_id = _ensure_active_conversation()
    chats = _chat_payloads()
    return {
        "chats": chats,
        "active_chat": active_conversation_id,
    }


_TOPICS_JSON_PATH = Path(__file__).parent.parent / "sapphire-data" / "topics.json"


def _load_topics() -> list[dict]:
    try:
        if _TOPICS_JSON_PATH.exists():
            data = json.loads(_TOPICS_JSON_PATH.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
            if isinstance(data, dict):
                return data.get("entries", [])
    except Exception as e:
        logger.warning(f"Failed to load topics: {e}")
    return []


def _save_topics(entries: list[dict]) -> None:
    try:
        _TOPICS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        _TOPICS_JSON_PATH.write_text(json.dumps({"entries": entries}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception as e:
        logger.error(f"Failed to save topics: {e}")


@app.get("/api/topics")
async def get_topics(topic: str = "", limit: int = 100):
    """Topic shelf data — folders and saved entries."""
    entries = _load_topics()
    chats = _chat_payloads()

    folder_entry_counts: dict[str, int] = {}
    folder_chat_counts: dict[str, int] = {}

    for e in entries:
        f = (e.get("topic") or "").strip()
        if f:
            folder_entry_counts[f] = folder_entry_counts.get(f, 0) + 1

    for c in chats:
        f = (c.get("settings", {}).get("topic_folder") or "").strip()
        if f:
            folder_chat_counts[f] = folder_chat_counts.get(f, 0) + 1

    all_folder_names = sorted(set(list(folder_entry_counts.keys()) + list(folder_chat_counts.keys())))
    folders = [
        {
            "topic": name,
            "entry_count": folder_entry_counts.get(name, 0),
            "chat_count": folder_chat_counts.get(name, 0),
        }
        for name in all_folder_names
    ]

    selected_topic = topic.strip()
    if selected_topic:
        filtered_entries = [e for e in entries if (e.get("topic") or "").strip().lower() == selected_topic.lower()]
    else:
        filtered_entries = entries

    filtered_entries.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    return {
        "active_topic": selected_topic,
        "folders": folders,
        "entries": filtered_entries[:limit],
    }


@app.post("/api/topics/entries")
async def save_topic_entry(payload: dict):
    """Save a quote or thread summary into a topic folder."""
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    raw_topic = (payload.get("topic") or "").strip()
    topic = raw_topic if raw_topic else "General"
    kind = (payload.get("kind") or "quote").strip().lower()
    title = (payload.get("title") or "").strip() or (f"Saved {kind.capitalize()}" if kind else "Saved Entry")
    source_chat = (payload.get("source_chat") or "").strip()
    source_msg_ts = payload.get("source_message_timestamp")

    entries = _load_topics()
    new_entry = {
        "id": f"top_{uuid.uuid4().hex[:8]}",
        "topic": topic,
        "kind": kind,
        "title": title,
        "source_chat": source_chat,
        "source_message_timestamp": source_msg_ts,
        "content": content,
        "created_at": datetime.utcnow().isoformat(),
    }
    entries.insert(0, new_entry)
    _save_topics(entries)

    return {"ok": True, "entry": new_entry}


@app.delete("/api/topics/entries/{entry_id}")
async def delete_topic_entry(entry_id: str):
    """Delete a topic entry by ID."""
    entries = _load_topics()
    orig_len = len(entries)
    entries = [e for e in entries if str(e.get("id")) != str(entry_id)]
    if len(entries) != orig_len:
        _save_topics(entries)
    return {"ok": True, "deleted": entry_id}


@app.post("/api/chats/{chat_name}/topic-folder")
async def set_chat_topic_folder(chat_name: str, body: dict):
    """Assign or move a chat to a topic folder."""
    folder = (body or {}).get("topic_folder", "").strip()
    continuity_db.update_conversation_metadata(chat_name, {"topic_folder": folder})
    return {"ok": True, "chat_name": chat_name, "topic_folder": folder}


@app.post("/api/topics/rename")
async def rename_topic_folder(body: dict):
    """Rename a topic folder across all saved quotes and categorized chats."""
    old_name = (body.get("old_name") or "").strip()
    new_name = (body.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(status_code=400, detail="old_name and new_name are required")

    # 1. Update topics.json
    entries = _load_topics()
    modified = False
    for e in entries:
        if (e.get("topic") or "").strip().lower() == old_name.lower():
            e["topic"] = new_name
            modified = True
    if modified:
        _save_topics(entries)

    # 2. Update conversations in continuity_db
    convs = continuity_db.get_all_conversations()
    for c in convs:
        meta = {}
        if c.get("metadata"):
            try:
                meta = json.loads(c["metadata"]) if isinstance(c["metadata"], str) else c["metadata"]
            except Exception:
                meta = {}
        tf = meta.get("topic_folder") or meta.get("settings", {}).get("topic_folder") or ""
        if tf.strip().lower() == old_name.lower():
            meta["topic_folder"] = new_name
            if "settings" in meta and isinstance(meta["settings"], dict):
                meta["settings"]["topic_folder"] = new_name
            continuity_db.update_conversation_metadata(c["id"], meta)

    return {"ok": True, "old_name": old_name, "new_name": new_name}


@app.post("/api/topics/delete")
async def delete_topic_folder(body: dict):
    """Delete a topic folder, clearing its tag on chats and removing its quotes."""
    folder_name = (body.get("topic") or "").strip()
    if not folder_name:
        raise HTTPException(status_code=400, detail="topic is required")

    # 1. Delete quotes with this topic
    entries = _load_topics()
    orig_len = len(entries)
    entries = [e for e in entries if (e.get("topic") or "").strip().lower() != folder_name.lower()]
    if len(entries) != orig_len:
        _save_topics(entries)

    # 2. Clear topic_folder for conversations in continuity_db
    convs = continuity_db.get_all_conversations()
    for c in convs:
        meta = {}
        if c.get("metadata"):
            try:
                meta = json.loads(c["metadata"]) if isinstance(c["metadata"], str) else c["metadata"]
            except Exception:
                meta = {}
        tf = meta.get("topic_folder") or meta.get("settings", {}).get("topic_folder") or ""
        if tf.strip().lower() == folder_name.lower():
            meta["topic_folder"] = ""
            if "settings" in meta and isinstance(meta["settings"], dict):
                meta["settings"]["topic_folder"] = ""
            continuity_db.update_conversation_metadata(c["id"], meta)

    return {"ok": True, "deleted": folder_name}


@app.post("/api/chats")
async def create_chat(body: dict = None):
    """Create a new chat session (alias for new conversation)."""
    new_id = str(uuid.uuid4())
    name = (body or {}).get("name", f"Chat {new_id[:8]}")
    _clear_clients_history()
    global current_conversation_id
    current_conversation_id = new_id
    continuity_db.add_conversation(new_id, name)
    return {"name": current_conversation_id, "title": name}


@app.delete("/api/chats/{chat_name}")
async def delete_chat(chat_name: str):
    """Delete a chat session by ID."""
    global current_conversation_id
    continuity_db.delete_conversation(chat_name)
    if current_conversation_id == chat_name:
        _clear_clients_history()
        convs = continuity_db.get_all_conversations()
        current_conversation_id = convs[0]["id"] if convs else None
    return {"ok": True, "deleted": chat_name}


@app.get("/api/chats/{chat_name}/activate")
@app.post("/api/chats/{chat_name}/activate")
async def activate_chat(chat_name: str):
    """Activate a chat by ID."""
    global current_conversation_id
    current_conversation_id = chat_name
    messages = continuity_db.get_conversation_messages(chat_name)
    _sync_history_to_clients(messages)
    return {"status": "activated", "name": chat_name, "settings": {}}


@app.get("/api/status")
async def get_status():
    """UI status endpoint — scope, identity, entropy for HUD display."""
    active_conversation_id = _ensure_active_conversation()
    chats = _chat_payloads()
    tts_provider = _tts_provider()
    return {
        "status": "ok",
        "context": {
            "scope": "default",
            "entropy": "default",
            "identity": "Terminus",
        },
        "voice": tts_provider,
        "model": claude_client.model,
        "tts_enabled": tts_provider != "none",
        "tts_ready": tts_provider != "none",
        "tts_playing": False,
        "stt_enabled": _load_settings_json_key("stt", "STT_PROVIDER", "none") != "none",
        "stt_ready": True,
        "chat_settings": _current_chat_settings(),
        "chats": chats,
        "active_chat": active_conversation_id,
    }


_runtime_settings: dict = {}
_chat_settings: dict = {
    "prompt": "terminus_lab",
    "persona": "Terminus",
    "llm_primary": "deepseek",
    "llm_model": deepseek_client.model,
}

CLAUDE_MODEL_OPTIONS = {
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-opus-5": "Claude Opus 5",
}

DEEPSEEK_MODEL_OPTIONS = {
    "deepseek-v4-flash": "DeepSeek V4 Flash",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
}


_SETTINGS_JSON_PATH = Path(__file__).parent.parent / "sapphire-data" / "settings.json"

def _load_settings_json() -> dict:
    try:
        return json.loads(_SETTINGS_JSON_PATH.read_text())
    except Exception:
        return {}

def _load_settings_json_key(section: str, key: str, default):
    """Read a value from settings.json[section][key]."""
    d = _load_settings_json()
    return d.get(section, {}).get(key, default)

def _save_settings_json_section(section: str, updates: dict) -> None:
    data = _load_settings_json()
    section_data = data.setdefault(section, {})
    section_data.update(updates)
    _SETTINGS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_JSON_PATH.write_text(json.dumps(data, indent=2) + "\n")


def _get_fallback_order() -> list:
    order = _load_settings_json_key("llm", "LLM_FALLBACK_ORDER", None)
    if not order or not isinstance(order, list):
        order = _runtime_settings.get("LLM_FALLBACK_ORDER", ["deepseek", "claude"])
    return order


def _save_fallback_order(order: list) -> None:
    _runtime_settings["LLM_FALLBACK_ORDER"] = order
    _save_settings_json_section("llm", {"LLM_FALLBACK_ORDER": order})


def _current_chat_settings() -> dict:
    settings_payload = dict(_chat_settings)
    primary = _chat_settings.get("llm_primary", "claude")
    if primary == "deepseek":
        settings_payload["llm_model"] = deepseek_client.model
    else:
        settings_payload["llm_model"] = claude_client.model
    return settings_payload


def _apply_chat_settings(updates: dict) -> dict:
    if not isinstance(updates, dict):
        return _current_chat_settings()
    _chat_settings.update(updates)

    primary = str(updates.get("llm_primary") or _chat_settings.get("llm_primary") or "claude").strip().lower()
    _chat_settings["llm_primary"] = primary

    model = str(updates.get("llm_model") or "").strip()
    if model:
        if model in DEEPSEEK_MODEL_OPTIONS or primary == "deepseek":
            deepseek_client.set_model(model)
            _chat_settings["llm_model"] = deepseek_client.model
            _save_settings_json_section("llm", {"DEEPSEEK_MODEL": deepseek_client.model, "LLM_PRIMARY": primary})
        elif model in CLAUDE_MODEL_OPTIONS or primary == "claude":
            claude_client.set_model(model)
            _chat_settings["llm_model"] = claude_client.model
            _save_settings_json_section("llm", {"LLM_MODEL": claude_client.model, "LLM_PRIMARY": primary})
        else:
            if primary == "deepseek":
                deepseek_client.set_model(model)
            else:
                claude_client.set_model(model)
            _chat_settings["llm_model"] = model
            _save_settings_json_section("llm", {"LLM_MODEL": model, "LLM_PRIMARY": primary})
    else:
        if primary == "deepseek":
            _chat_settings["llm_model"] = deepseek_client.model
        else:
            _chat_settings["llm_model"] = claude_client.model
        _save_settings_json_section("llm", {"LLM_PRIMARY": primary})

    return _current_chat_settings()


def _load_persisted_llm_settings() -> None:
    llm = _load_settings_json().get("llm", {})
    deepseek_model = str(llm.get("DEEPSEEK_MODEL") or "").strip()
    claude_model = str(llm.get("LLM_MODEL") or "").strip()
    primary = str(llm.get("LLM_PRIMARY") or "").strip().lower()
    if deepseek_model:
        deepseek_client.set_model(deepseek_model)
    if claude_model:
        claude_client.set_model(claude_model)
    if primary:
        _chat_settings["llm_primary"] = primary
    _chat_settings["llm_model"] = deepseek_client.model if _chat_settings.get("llm_primary") == "deepseek" else claude_client.model

_load_persisted_llm_settings()


def _apply_voice_settings(updates: dict) -> None:
    provider = str(updates.get("TTS_PROVIDER") or "").strip().lower()
    voice_id = str(updates.get("TTS_ELEVENLABS_VOICE_ID") or "").strip()
    voice_model = str(updates.get("TTS_ELEVENLABS_MODEL") or "").strip()
    persisted = {}
    if provider:
        persisted["TTS_PROVIDER"] = provider
    if voice_id:
        settings.VOICE_ID = voice_id
        voice_engine.voice_id = voice_id
        persisted["TTS_ELEVENLABS_VOICE_ID"] = voice_id
    if voice_model:
        settings.VOICE_MODEL = voice_model
        voice_engine.model = voice_model
        persisted["TTS_ELEVENLABS_MODEL"] = voice_model
    if persisted:
        if (voice_id or voice_model) and not provider:
            persisted["TTS_PROVIDER"] = "elevenlabs"
        _save_settings_json_section("tts", persisted)


def _load_persisted_voice_settings() -> None:
    tts = _load_settings_json().get("tts", {})
    voice_id = str(tts.get("TTS_ELEVENLABS_VOICE_ID") or "").strip()
    voice_model = str(tts.get("TTS_ELEVENLABS_MODEL") or "").strip()
    if voice_id:
        settings.VOICE_ID = voice_id
        voice_engine.voice_id = voice_id
    if voice_model:
        settings.VOICE_MODEL = voice_model
        voice_engine.model = voice_model

_load_persisted_voice_settings()

def _tts_provider() -> str:
    provider = str(_load_settings_json_key("tts", "TTS_PROVIDER", "") or "").strip().lower()
    if provider:
        return provider
    return _detect_tts_provider()

def _tts_enabled() -> bool:
    return _tts_provider() != "none"

def _detect_tts_provider() -> str:
    """Infer active TTS provider from environment / credentials / installed packages."""
    import importlib.util
    elevenlabs_key = os.environ.get("ELEVENLABS_API_KEY", "") or settings.ELEVENLABS_API_KEY
    if not elevenlabs_key:
        try:
            creds = json.loads((Path(__file__).parent.parent / "sapphire-config" / "credentials.json").read_text())
            elevenlabs_key = creds.get("services", {}).get("tts_elevenlabs", {}).get("api_key", "")
        except Exception:
            pass
    if elevenlabs_key and importlib.util.find_spec("elevenlabs"):
        return "elevenlabs"
    if importlib.util.find_spec("kokoro"):
        return "kokoro"
    return "none"

def _all_settings() -> dict:
    base = {
        "prompt": "terminus_lab",
        "toolset": current_toolset_name,
        "spice_set": "default",
        "persona": "Terminus",
        "llm_primary": "claude",
        "llm_model": claude_client.model,
        # Tools tab
        "MAX_TOOL_ITERATIONS": 5,
        "MAX_PARALLEL_TOOLS": 4,
        "DEBUG_TOOL_CALLING": False,
        # System tab
        "WEB_UI_SSL_ADHOC": False,
        "WEB_UI_HOST": "0.0.0.0",
        "WEB_UI_PORT": 8000,
        # STT tab — read from settings.json
        "STT_PROVIDER": _load_settings_json_key("stt", "STT_PROVIDER", "none"),
        "STT_MODEL_SIZE": _load_settings_json_key("stt", "STT_MODEL_SIZE", "base.en"),
        "FASTER_WHISPER_DEVICE": _load_settings_json_key("stt", "FASTER_WHISPER_DEVICE", "cpu"),
        "FASTER_WHISPER_COMPUTE_TYPE": _load_settings_json_key("stt", "FASTER_WHISPER_COMPUTE_TYPE", "int8"),
        "FASTER_WHISPER_NUM_WORKERS": _load_settings_json_key("stt", "FASTER_WHISPER_NUM_WORKERS", 4),
        "STT_LANGUAGE": "en",
        "RECORDER_BACKGROUND_PERCENTILE": 30,
        "RECORDER_SILENCE_DURATION": 1.2,
        "RECORDER_MAX_SECONDS": 60,
        # TTS tab — reflect actual runtime backend
        "TTS_PROVIDER": _tts_provider(),
        "TTS_ELEVENLABS_API_KEY": "",
        "TTS_ELEVENLABS_MODEL": settings.VOICE_MODEL,
        "TTS_ELEVENLABS_VOICE_ID": settings.VOICE_ID,
        # Embedding tab
        "EMBEDDING_PROVIDER": "none",
        "EMBEDDING_API_URL": "",
        "EMBEDDING_API_KEY": "",
        # Backup tab
        "BACKUPS_ENABLED": True,
        "BACKUPS_KEEP_DAILY": 7,
        "BACKUPS_KEEP_WEEKLY": 4,
        "BACKUPS_KEEP_MONTHLY": 3,
        "BACKUPS_KEEP_MANUAL": 10,
        # LLM Settings
        "LLM_PROVIDERS": {
            "claude": {
                "display_name": "Claude",
                "enabled": bool(settings.ANTHROPIC_API_KEY),
                "model": claude_client.model,
                "api_key": settings.ANTHROPIC_API_KEY,
                "api_key_env": "ANTHROPIC_API_KEY",
                "use_as_fallback": True,
                "thinking_enabled": True,
                "thinking_budget": 8000,
            },
            "deepseek": {
                "display_name": "DeepSeek",
                "enabled": bool(settings.DEEPSEEK_API_KEY),
                "model": deepseek_client.model,
                "api_key": settings.DEEPSEEK_API_KEY,
                "api_key_env": "DEEPSEEK_API_KEY",
                "base_url": settings.DEEPSEEK_BASE_URL,
                "use_as_fallback": True,
            },
        },
        "LLM_FALLBACK_ORDER": _get_fallback_order(),
        "MODEL_GENERATION_PROFILES": _load_settings_json_key("llm", "MODEL_GENERATION_PROFILES", {}),
        # Wakeword tab
        "WAKE_WORD_ENABLED": False,
        "WAKEWORD_MODEL": "hey_jarvis",
        "WAKEWORD_THRESHOLD": 0.5,
        "WAKEWORD_FRAMEWORK": "openwakeword",
        "CHUNK_SIZE": 1280,
        "BUFFER_DURATION": 1.5,
        "WAKE_TONE_DURATION": 0.2,
        "WAKE_TONE_FREQUENCY": 880,
    }
    base.update(_runtime_settings)
    return base

@app.get("/api/settings")
async def get_settings():
    return {
        "settings": _all_settings(),
        "user_overrides": list(_runtime_settings.keys()),
        "managed": False,
        "unrestricted": True,
    }

@app.get("/api/settings/help")
async def get_settings_help():
    return {"help": {
        "EMBEDDING_PROVIDER": {"short": "Embedding engine for semantic memory and knowledge search."},
        "EMBEDDING_API_URL": {"short": "URL for a remote Nomic-compatible embedding API."},
        "BACKUPS_ENABLED": {"short": "Enable automatic scheduled backups."},
        "BACKUPS_KEEP_DAILY": {"short": "Number of daily backups to retain."},
        "BACKUPS_KEEP_WEEKLY": {"short": "Number of weekly backups to retain."},
        "BACKUPS_KEEP_MONTHLY": {"short": "Number of monthly backups to retain."},
        "BACKUPS_KEEP_MANUAL": {"short": "Number of manual backups to retain."},
        "MAX_TOOL_ITERATIONS": {"short": "Maximum number of tool call rounds per chat turn."},
        "MAX_PARALLEL_TOOLS": {"short": "Maximum number of tools that can run in parallel."},
        "DEBUG_TOOL_CALLING": {"short": "Log detailed tool call traces to the console."},
        "WEB_UI_SSL_ADHOC": {"short": "Enable ad-hoc SSL for the web UI (self-signed certificate)."},
        "WEB_UI_HOST": {"short": "Host address the server binds to."},
        "WEB_UI_PORT": {"short": "Port the server listens on."},
        "WAKE_WORD_ENABLED": {"short": "Enable wake word detection for hands-free activation."},
        "WAKEWORD_MODEL": {"short": "Wake word model name to use."},
        "WAKEWORD_THRESHOLD": {"short": "Detection confidence threshold (0–1)."},
    }}

@app.put("/api/settings/batch")
async def update_settings_batch(body: dict):
    updates = body.get("settings", {})
    if not isinstance(updates, dict):
        raise HTTPException(status_code=400, detail="Expected {settings: {...}}")
    _runtime_settings.update(updates)
    if "llm_model" in updates or "llm_primary" in updates:
        _apply_chat_settings(updates)
    if "TTS_PROVIDER" in updates or "TTS_ELEVENLABS_VOICE_ID" in updates or "TTS_ELEVENLABS_MODEL" in updates:
        _apply_voice_settings(updates)
    return {"ok": True, "updated": list(updates.keys())}


@app.put("/api/settings/{key}")
async def update_setting(key: str, body: dict):
    value = (body or {}).get("value")
    _runtime_settings[key] = value
    if key in {"llm_model", "llm_primary"}:
        _apply_chat_settings({key: value})
    if key in {"TTS_PROVIDER", "TTS_ELEVENLABS_VOICE_ID", "TTS_ELEVENLABS_MODEL"}:
        _apply_voice_settings({key: value})
    return {"ok": True, "key": key, "value": value}

@app.delete("/api/settings/{key}")
async def delete_setting(key: str):
    _runtime_settings.pop(key, None)
    return {"ok": True}

@app.post("/api/settings/reset")
async def reset_settings():
    _runtime_settings.clear()
    return {"ok": True}

@app.post("/api/settings/reload")
async def reload_settings():
    return {"ok": True}


@app.get("/api/llm/providers")
async def get_llm_providers():
    has_claude = bool(settings.ANTHROPIC_API_KEY)
    has_deepseek = bool(settings.DEEPSEEK_API_KEY)
    return {
        "providers": [
            {
                "key": "claude",
                "display_name": "Claude",
                "enabled": has_claude,
                "is_local": False,
                "model": claude_client.model,
                "has_env_key": bool(os.getenv("ANTHROPIC_API_KEY")),
                "env_var": "ANTHROPIC_API_KEY",
                "use_as_fallback": True,
            },
            {
                "key": "deepseek",
                "display_name": "DeepSeek",
                "enabled": has_deepseek,
                "is_local": False,
                "model": deepseek_client.model,
                "has_env_key": bool(os.getenv("DEEPSEEK_API_KEY")),
                "env_var": "DEEPSEEK_API_KEY",
                "use_as_fallback": True,
            },
        ],
        "metadata": {
            "claude": {
                "display_name": "Claude",
                "model_options": CLAUDE_MODEL_OPTIONS,
                "supports_thinking": True,
                "thinking_enabled": True,
                "thinking_budget": 8000,
                "api_key_env": "ANTHROPIC_API_KEY",
            },
            "deepseek": {
                "display_name": "DeepSeek",
                "model_options": DEEPSEEK_MODEL_OPTIONS,
                "supports_thinking": True,
                "thinking_enabled": True,
                "api_key_env": "DEEPSEEK_API_KEY",
            },
        },
        "fallback_order": _get_fallback_order(),
    }


@app.post("/api/llm/test/{key}")
async def test_llm_provider(key: str, body: dict = None):
    body = body or {}
    if key == "deepseek":
        if body.get("model"):
            deepseek_client.set_model(body["model"])
        return deepseek_client.test_connection()
    elif key == "claude":
        if not settings.ANTHROPIC_API_KEY:
            return {"status": "error", "error": "ANTHROPIC_API_KEY not configured"}
        try:
            m = body.get("model") or claude_client.model
            resp = claude_client.client.messages.create(
                model=m,
                max_tokens=5,
                messages=[{"role": "user", "content": "ping"}],
            )
            txt = "".join(b.text for b in resp.content if b.type == "text")
            return {"status": "success", "response": txt or "OK"}
        except Exception as e:
            return {"status": "error", "error": str(e)}
    return {"status": "error", "error": f"Unknown provider: {key}"}


@app.put("/api/llm/providers/{key}")
async def update_llm_provider(key: str, body: dict):
    updates = body or {}
    if key == "deepseek":
        if "model" in updates and updates["model"]:
            deepseek_client.set_model(updates["model"])
        if "api_key" in updates and updates["api_key"]:
            settings.DEEPSEEK_API_KEY = updates["api_key"]
            deepseek_client.api_key = updates["api_key"]
        _save_settings_json_section("llm", {"DEEPSEEK_MODEL": deepseek_client.model})
    elif key == "claude":
        if "model" in updates and updates["model"]:
            claude_client.set_model(updates["model"])
        if "api_key" in updates and updates["api_key"]:
            settings.ANTHROPIC_API_KEY = updates["api_key"]
        _save_settings_json_section("llm", {"LLM_MODEL": claude_client.model})
    return {"ok": True, "provider": key}


@app.put("/api/llm/fallback-order")
async def update_fallback_order(body: dict):
    order = (body or {}).get("order", [])
    if isinstance(order, list) and order:
        _save_fallback_order(order)
    return {"ok": True, "fallback_order": _get_fallback_order()}


@app.get("/api/chats/{chat_name}/settings")
async def get_chat_settings(chat_name: str):
    return {"settings": _current_chat_settings(), "chat_name": chat_name}


@app.put("/api/chats/{chat_name}/settings")
async def update_chat_settings(chat_name: str, body: dict):
    updated = _apply_chat_settings((body or {}).get("settings", body or {}))
    return {"ok": True, "settings": updated, "chat_name": chat_name}


@app.get("/api/toolsets")
async def get_toolsets():
    return {"toolsets": _toolsets_payload()}


@app.get("/api/toolsets/current")
async def get_toolsets_current():
    toolsets = _toolsets_payload()
    current = next((t for t in toolsets if t["name"] == current_toolset_name), toolsets[0])
    return {
        "name": current["name"],
        "type": current["type"],
        "function_count": current.get("function_count", 0),
        "story_tools": 0,
    }


@app.post("/api/toolsets/{name}/activate")
async def activate_toolset(name: str):
    global current_toolset_name, enabled_functions_override
    known = {t["name"] for t in _toolsets_payload()}
    if name not in known:
        raise HTTPException(status_code=404, detail="Toolset not found")
    current_toolset_name = name
    enabled_functions_override = None
    return await get_toolsets_current()


@app.post("/api/toolsets/custom")
async def save_custom_toolset(body: dict):
    name = str((body or {}).get("name", "")).strip()
    functions = [f for f in (body or {}).get("functions", []) if isinstance(f, str) and f.strip()]
    if not name:
        raise HTTPException(status_code=400, detail="Toolset name is required")
    if name in {"all", "none"}:
        raise HTTPException(status_code=400, detail="Reserved toolset name")

    toolsets = _load_user_toolsets()
    existing_emoji = toolsets.get(name, {}).get("emoji", "")
    toolsets[name] = {"emoji": existing_emoji, "functions": functions}
    _save_user_toolsets(toolsets)
    return {"ok": True, "name": name, "function_count": len(functions)}


@app.delete("/api/toolsets/{name}")
async def delete_user_toolset(name: str):
    if name in {"all", "none"}:
        raise HTTPException(status_code=400, detail="Cannot delete builtin toolset")
    toolsets = _load_user_toolsets()
    if name not in toolsets:
        raise HTTPException(status_code=404, detail="Toolset not found")
    del toolsets[name]
    _save_user_toolsets(toolsets)

    global current_toolset_name
    if current_toolset_name == name:
        current_toolset_name = "all"
    return {"ok": True}


@app.post("/api/toolsets/{name}/emoji")
async def set_toolset_emoji(name: str, body: dict):
    if name in {"all", "none"}:
        raise HTTPException(status_code=400, detail="Cannot edit builtin toolset")
    toolsets = _load_user_toolsets()
    if name not in toolsets:
        raise HTTPException(status_code=404, detail="Toolset not found")
    toolsets[name]["emoji"] = str((body or {}).get("emoji", ""))
    _save_user_toolsets(toolsets)
    return {"ok": True}


@app.get("/api/functions")
async def get_functions():
    return _functions_payload()


@app.post("/api/functions/enable")
async def enable_functions(body: dict):
    global enabled_functions_override
    enabled_functions_override = [
        f for f in (body or {}).get("functions", []) if isinstance(f, str) and f.strip()
    ]
    return {"ok": True, "enabled": enabled_functions_override}


@app.get("/api/privacy")
async def get_privacy():
    return {"privacy_mode": False}


@app.put("/api/privacy")
async def set_privacy(body: dict):
    return {"privacy_mode": body.get("enabled", False)}


@app.get("/api/usage/balance")
async def get_balance():
    from core.usage_tracker import get_balance as _get_balance
    return _get_balance()

@app.post("/api/usage/balance")
async def set_usage_balance(body: dict):
    from core.usage_tracker import set_balance
    amount = float(body.get("balance", 0.0))
    return set_balance(amount)


# ── Plugin directories ───────────────────────────────────────────────────────
PLUGIN_DIRS = [
    Path(__file__).parent.parent / "sapphire-data" / "plugins",
    Path(__file__).parent.parent / "user" / "plugins",
]
WEBUI_PLUGINS_JSON = Path(__file__).parent.parent / "sapphire-data" / "webui" / "plugins.json"

def _load_plugin_enabled() -> set:
    try:
        d = json.loads(WEBUI_PLUGINS_JSON.read_text())
        return set(d.get("enabled", []))
    except Exception:
        return set()

def _save_plugin_enabled(enabled: set):
    WEBUI_PLUGINS_JSON.parent.mkdir(parents=True, exist_ok=True)
    WEBUI_PLUGINS_JSON.write_text(json.dumps({"enabled": sorted(enabled)}, indent=2))

def _scan_plugins() -> list:
    seen = set()
    plugins = []
    enabled = _load_plugin_enabled()
    for base in PLUGIN_DIRS:
        if not base.exists():
            continue
        for pdir in sorted(base.iterdir()):
            if not pdir.is_dir() or pdir.name in seen:
                continue
            seen.add(pdir.name)
            meta_file = pdir / "plugin.json"
            if not meta_file.exists():
                continue
            try:
                meta = json.loads(meta_file.read_text())
            except Exception:
                continue
            plugins.append({
                "name": meta.get("name", pdir.name),
                "title": meta.get("title", meta.get("name", pdir.name).replace("-", " ").title()),
                "version": meta.get("version", "1.0.0"),
                "description": meta.get("description", ""),
                "author": meta.get("author", ""),
                "enabled": meta.get("name", pdir.name) in enabled or meta.get("default_enabled", False),
                "icon": meta.get("icon", "🔌"),
                "settingsUI": None,
            })
    return plugins

@app.get("/api/webui/plugins")
async def get_webui_plugins():
    plugins = _scan_plugins()
    enabled = [p["name"] for p in plugins if p["enabled"]]
    return {"plugins": plugins, "enabled": enabled, "locked": []}

@app.post("/api/webui/plugins/{name}/enable")
async def enable_plugin(name: str):
    enabled = _load_plugin_enabled()
    enabled.add(name)
    _save_plugin_enabled(enabled)
    return {"ok": True}

@app.post("/api/webui/plugins/{name}/disable")
async def disable_plugin(name: str):
    enabled = _load_plugin_enabled()
    enabled.discard(name)
    _save_plugin_enabled(enabled)
    return {"ok": True}


# ── Backup API ───────────────────────────────────────────────────────────────

BACKUP_ROOT = Path("/Volumes/Extreme SSD/Terminus/backups")
BACKUP_DATA_DIRS = [
    Path(__file__).parent.parent / "sapphire-data",
    Path.home() / ".terminus" / "data",
]

def _backup_category(filename: str) -> str:
    # manual-*, daily-*, weekly-*, monthly-*
    for cat in ("daily", "weekly", "monthly"):
        if filename.startswith(cat + "-"):
            return cat
    return "manual"

@app.get("/api/backup/list")
async def backup_list():
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    files = sorted(BACKUP_ROOT.glob("*.tar.gz"), key=lambda f: f.stat().st_mtime, reverse=True)
    result: dict[str, list] = {"daily": [], "weekly": [], "monthly": [], "manual": []}
    total_bytes = 0
    for f in files:
        size = f.stat().st_size
        total_bytes += size
        cat = _backup_category(f.name)
        result[cat].append({
            "filename": f.name,
            "size": size,
            "created": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        })
    return {"backups": result, "total_count": len(files), "total_bytes": total_bytes}

@app.post("/api/backup/create")
async def backup_create(body: dict = None):
    label = ((body or {}).get("label") or "manual").strip().lower()
    if label not in ("daily", "weekly", "monthly", "manual"):
        label = "manual"
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{label}-{ts}.tar.gz"
    dest = BACKUP_ROOT / filename
    with tarfile.open(dest, "w:gz") as tar:
        for src in BACKUP_DATA_DIRS:
            if src.exists():
                tar.add(src, arcname=src.name)
    size = dest.stat().st_size
    return {"ok": True, "filename": filename, "size": size, "path": str(dest)}

@app.get("/api/backup/download/{filename}")
async def backup_download(filename: str):
    # Prevent path traversal
    safe = Path(filename).name
    dest = BACKUP_ROOT / safe
    if not dest.exists() or not dest.is_file():
        raise HTTPException(status_code=404, detail="Backup not found")
    return FileResponse(str(dest), filename=safe, media_type="application/gzip")

@app.delete("/api/backup/delete/{filename}")
async def backup_delete(filename: str):
    safe = Path(filename).name
    dest = BACKUP_ROOT / safe
    if not dest.exists():
        raise HTTPException(status_code=404, detail="Backup not found")
    dest.unlink()
    return {"ok": True}


# ── Embedding API ─────────────────────────────────────────────────────────────

@app.post("/api/embedding/test")
async def embedding_test():
    provider = _runtime_settings.get("EMBEDDING_PROVIDER", "none")
    if provider == "none":
        return {"success": False, "error": "Embedding provider is disabled. Select a provider in Settings > Embedding."}
    if provider == "local":
        try:
            import torch
            start = time.time()
            # Simple deterministic embedding using torch (no model download needed)
            text = "Terminus embedding test"
            vec = torch.nn.functional.normalize(
                torch.tensor([float(ord(c)) for c in text[:128]] + [0.0] * (128 - min(128, len(text)))).unsqueeze(0),
                dim=1
            ).squeeze().tolist()
            ms = int((time.time() - start) * 1000)
            return {"success": True, "provider": "local (torch)", "dimensions": len(vec), "ms": ms}
        except Exception as e:
            return {"success": False, "error": str(e)}
    if provider == "api":
        url = _runtime_settings.get("EMBEDDING_API_URL", "")
        if not url:
            return {"success": False, "error": "EMBEDDING_API_URL not set"}
        try:
            import urllib.request, json as _json
            req = urllib.request.Request(url, data=_json.dumps({"input": ["test"], "model": "nomic-embed-text"}).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = _json.loads(resp.read())
            dims = len(data["data"][0]["embedding"])
            return {"success": True, "provider": "api", "dimensions": dims, "ms": 0}
        except Exception as e:
            return {"success": False, "error": str(e)}
    return {"success": False, "error": f"Unknown provider: {provider}"}


@app.get("/api/events")
async def get_events():
    """SSE keep-alive stream for the EventBus (no-op in Terminus)."""
    async def event_stream():
        yield "data: {\"type\":\"connected\"}\n\n"
        # Keep connection open with periodic pings
        import asyncio
        for _ in range(30):
            await asyncio.sleep(10)
            yield ": ping\n\n"
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Mind API compatibility ───────────────────────────────────────────────────

@app.get("/api/memory/scopes")
async def get_memory_scopes():
    conn = _mind_conn()
    rows = conn.execute(
        """
        SELECT ms.name, COUNT(m.id) AS count
        FROM memory_scopes ms
        LEFT JOIN memories m ON m.scope = ms.name
        GROUP BY ms.name
        ORDER BY CASE ms.name WHEN 'default' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, ms.name
        """
    ).fetchall()
    conn.close()
    return {"scopes": [dict(r) for r in rows]}


@app.post("/api/memory/scopes")
async def create_memory_scope(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scope name required")
    conn = _mind_conn()
    conn.execute("INSERT OR IGNORE INTO memory_scopes(name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
    return {"ok": True, "name": name}


@app.delete("/api/memory/scopes/{name}")
async def delete_memory_scope(name: str):
    if name in {"default", "global"}:
        raise HTTPException(status_code=400, detail="Cannot delete reserved scope")
    conn = _mind_conn()
    conn.execute("DELETE FROM memories WHERE scope = ?", (name,))
    conn.execute("DELETE FROM memory_scopes WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/memory/list")
async def list_memories(scope: str = "default"):
    conn = _mind_conn()
    rows = conn.execute(
        "SELECT id, content, label, created_at, updated_at FROM memories WHERE scope = ? ORDER BY updated_at DESC, id DESC",
        (scope,),
    ).fetchall()
    conn.close()
    grouped: dict[str, list] = {}
    for row in rows:
        label = str(row["label"] or "note")
        grouped.setdefault(label, []).append(dict(row))
    return {"memories": grouped}


@app.post("/api/memory")
async def create_memory(body: dict):
    content = str((body or {}).get("content", "")).strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    label = str((body or {}).get("label", "note")).strip() or "note"
    scope = str((body or {}).get("scope", "default")).strip() or "default"
    conn = _mind_conn()
    conn.execute("INSERT OR IGNORE INTO memory_scopes(name) VALUES (?)", (scope,))
    cur = conn.execute(
        "INSERT INTO memories(content, label, scope, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        (content, label, scope),
    )
    conn.commit()
    memory_id = cur.lastrowid
    conn.close()
    return {"ok": True, "id": memory_id}


@app.put("/api/memory/{memory_id}")
async def update_memory(memory_id: int, body: dict):
    content = str((body or {}).get("content", "")).strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    label = str((body or {}).get("label", "note")).strip() or "note"
    scope = str((body or {}).get("scope", "default")).strip() or "default"
    conn = _mind_conn()
    conn.execute("INSERT OR IGNORE INTO memory_scopes(name) VALUES (?)", (scope,))
    conn.execute(
        "UPDATE memories SET content = ?, label = ?, scope = ?, updated_at = datetime('now') WHERE id = ?",
        (content, label, scope, memory_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/memory/{memory_id}")
async def delete_memory(memory_id: int, scope: str = "default"):
    conn = _mind_conn()
    conn.execute("DELETE FROM memories WHERE id = ? AND scope = ?", (memory_id, scope))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/knowledge/scopes")
async def get_knowledge_scopes():
    conn = _knowledge_conn()
    rows = conn.execute(
        """
        SELECT ks.name, COALESCE(COUNT(ke.id), 0) AS count
        FROM knowledge_scopes ks
        LEFT JOIN knowledge_tabs kt ON kt.scope = ks.name
        LEFT JOIN knowledge_entries ke ON ke.tab_id = kt.id
        GROUP BY ks.name
        ORDER BY CASE ks.name WHEN 'default' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, ks.name
        """
    ).fetchall()
    conn.close()
    return {"scopes": [dict(r) for r in rows]}


@app.post("/api/knowledge/scopes")
async def create_knowledge_scope(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scope name required")
    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO knowledge_scopes(name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
    return {"ok": True, "name": name}


@app.delete("/api/knowledge/scopes/{name}")
async def delete_knowledge_scope(name: str):
    if name in {"default", "global"}:
        raise HTTPException(status_code=400, detail="Cannot delete reserved scope")
    conn = _knowledge_conn()
    tab_rows = conn.execute("SELECT id FROM knowledge_tabs WHERE scope = ?", (name,)).fetchall()
    tab_ids = [r[0] for r in tab_rows]
    if tab_ids:
        conn.executemany("DELETE FROM knowledge_entries WHERE tab_id = ?", [(tid,) for tid in tab_ids])
    conn.execute("DELETE FROM knowledge_tabs WHERE scope = ?", (name,))
    conn.execute("DELETE FROM knowledge_scopes WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/knowledge/people/scopes")
async def get_people_scopes():
    conn = _knowledge_conn()
    rows = conn.execute(
        """
        SELECT ps.name, COUNT(p.id) AS count
        FROM people_scopes ps
        LEFT JOIN people p ON p.scope = ps.name
        GROUP BY ps.name
        ORDER BY CASE ps.name WHEN 'default' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, ps.name
        """
    ).fetchall()
    conn.close()
    return {"scopes": [dict(r) for r in rows]}


@app.post("/api/knowledge/people/scopes")
async def create_people_scope(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scope name required")
    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
    return {"ok": True, "name": name}


@app.delete("/api/knowledge/people/scopes/{name}")
async def delete_people_scope(name: str):
    if name in {"default", "global"}:
        raise HTTPException(status_code=400, detail="Cannot delete reserved scope")
    conn = _knowledge_conn()
    conn.execute("DELETE FROM people WHERE scope = ?", (name,))
    conn.execute("DELETE FROM people_scopes WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/knowledge/people")
async def list_people(scope: str = "default"):
    conn = _knowledge_conn()
    rows = conn.execute(
        "SELECT id, name, relationship, phone, email, address, notes, email_whitelisted, created_at, updated_at FROM people WHERE scope = ? ORDER BY LOWER(name)",
        (scope,),
    ).fetchall()
    conn.close()
    return {"people": [dict(r) for r in rows]}


@app.post("/api/knowledge/people")
async def save_person(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    scope = str((body or {}).get("scope", "default")).strip() or "default"
    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES (?)", (scope,))
    person_id = (body or {}).get("id")
    values = (
        name,
        str((body or {}).get("relationship", "")).strip() or None,
        str((body or {}).get("phone", "")).strip() or None,
        str((body or {}).get("email", "")).strip() or None,
        str((body or {}).get("address", "")).strip() or None,
        str((body or {}).get("notes", "")).strip() or None,
        1 if (body or {}).get("email_whitelisted") else 0,
        scope,
    )
    if person_id:
        conn.execute(
            """
            UPDATE people
            SET name = ?, relationship = ?, phone = ?, email = ?, address = ?, notes = ?, email_whitelisted = ?, scope = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (*values, int(person_id)),
        )
    else:
        conn.execute(
            """
            INSERT INTO people(name, relationship, phone, email, address, notes, email_whitelisted, scope)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/knowledge/people/{person_id}")
async def delete_person(person_id: int):
    conn = _knowledge_conn()
    conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/knowledge/people/import-google-csv")
async def import_people_google_csv(file: UploadFile = File(...), scope: str = "default"):
    content = (await file.read()).decode("utf-8", errors="ignore")
    reader = csv.DictReader(StringIO(content))
    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES (?)", (scope,))

    total = 0
    imported = 0
    updated = 0
    skipped: list[str] = []
    for row in reader:
        total += 1
        name = (row.get("Name") or "").strip() or " ".join(filter(None, [
            (row.get("First Name") or row.get("Given Name") or "").strip(),
            (row.get("Last Name") or row.get("Family Name") or "").strip()
        ])).strip() or (row.get("Organization Name") or "").strip()
        if not name:
            skipped.append("Unnamed contact")
            continue
        email = (row.get("E-mail 1 - Value") or "").strip() or None
        phone = (row.get("Phone 1 - Value") or "").strip() or None
        address = (row.get("Address 1 - Formatted") or "").strip() or None
        notes = (row.get("Notes") or "").strip() or None
        existing = conn.execute("SELECT id FROM people WHERE LOWER(name) = LOWER(?) AND scope = ?", (name, scope)).fetchone()
        if existing:
            conn.execute(
                "UPDATE people SET email = COALESCE(?, email), phone = COALESCE(?, phone), address = COALESCE(?, address), notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (email, phone, address, notes, int(existing[0])),
            )
            updated += 1
        else:
            conn.execute(
                "INSERT INTO people(name, email, phone, address, notes, scope) VALUES (?, ?, ?, ?, ?, ?)",
                (name, email, phone, address, notes, scope),
            )
            imported += 1

    conn.commit()
    conn.close()
    return {
        "imported": imported,
        "updated": updated,
        "total_in_file": total,
        "skipped_count": len(skipped),
        "skipped": skipped[:10],
    }


@app.post("/api/knowledge/people/import-vcf")
async def import_people_vcf(file: UploadFile = File(...), scope: str = "default"):
    content = (await file.read()).decode("utf-8", errors="ignore")
    cards = [c for c in content.split("END:VCARD") if "BEGIN:VCARD" in c]

    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO people_scopes(name) VALUES (?)", (scope,))

    imported = 0
    skipped: list[str] = []
    for card in cards:
        lines = [l.strip() for l in card.splitlines() if l.strip()]
        name = ""
        phone = ""
        email = ""
        address = ""
        note = ""
        for line in lines:
            if line.startswith("FN:"):
                name = line[3:].strip()
            elif line.startswith("TEL") and ":" in line and not phone:
                phone = line.split(":", 1)[1].strip()
            elif line.startswith("EMAIL") and ":" in line and not email:
                email = line.split(":", 1)[1].strip()
            elif line.startswith("ADR") and ":" in line and not address:
                address = line.split(":", 1)[1].replace(";", " ").strip()
            elif line.startswith("NOTE:") and not note:
                note = line[5:].strip()
        if not name:
            skipped.append("Unnamed vCard")
            continue
        existing = conn.execute("SELECT id FROM people WHERE LOWER(name) = LOWER(?) AND scope = ?", (name, scope)).fetchone()
        if existing:
            skipped.append(name)
            continue
        conn.execute(
            "INSERT INTO people(name, phone, email, address, notes, scope) VALUES (?, ?, ?, ?, ?, ?)",
            (name, phone or None, email or None, address or None, note or None, scope),
        )
        imported += 1

    conn.commit()
    conn.close()
    return {
        "imported": imported,
        "total_in_file": len(cards),
        "skipped_count": len(skipped),
        "skipped": skipped[:10],
    }


@app.get("/api/knowledge/tabs")
async def list_knowledge_tabs(scope: str = "default", type: str = "user"):
    conn = _knowledge_conn()
    rows = conn.execute(
        """
        SELECT kt.id, kt.name, kt.description, kt.type, kt.scope, COUNT(ke.id) AS entry_count
        FROM knowledge_tabs kt
        LEFT JOIN knowledge_entries ke ON ke.tab_id = kt.id
        WHERE kt.scope = ? AND kt.type = ?
        GROUP BY kt.id
        ORDER BY LOWER(kt.name)
        """,
        (scope, type),
    ).fetchall()
    conn.close()
    return {"tabs": [dict(r) for r in rows]}


@app.post("/api/knowledge/tabs")
async def create_knowledge_tab(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Category name is required")
    scope = str((body or {}).get("scope", "default")).strip() or "default"
    tab_type = str((body or {}).get("type", "user")).strip() or "user"
    conn = _knowledge_conn()
    conn.execute("INSERT OR IGNORE INTO knowledge_scopes(name) VALUES (?)", (scope,))
    conn.execute(
        "INSERT INTO knowledge_tabs(name, description, type, scope) VALUES (?, ?, ?, ?)",
        (name, None, tab_type, scope),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/knowledge/tabs/{tab_id}")
async def delete_knowledge_tab(tab_id: int):
    conn = _knowledge_conn()
    conn.execute("DELETE FROM knowledge_entries WHERE tab_id = ?", (tab_id,))
    conn.execute("DELETE FROM knowledge_tabs WHERE id = ?", (tab_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/knowledge/tabs/{tab_id}")
async def get_knowledge_tab(tab_id: int):
    conn = _knowledge_conn()
    tab = conn.execute("SELECT id, name, description, type, scope FROM knowledge_tabs WHERE id = ?", (tab_id,)).fetchone()
    if not tab:
        conn.close()
        raise HTTPException(status_code=404, detail="Category not found")
    entries = conn.execute(
        "SELECT id, content, chunk_index, source_filename, created_at, updated_at FROM knowledge_entries WHERE tab_id = ? ORDER BY source_filename, chunk_index, id",
        (tab_id,),
    ).fetchall()
    conn.close()
    return {"id": tab["id"], "name": tab["name"], "type": tab["type"], "scope": tab["scope"], "entries": [dict(r) for r in entries]}


@app.post("/api/knowledge/tabs/{tab_id}/entries")
async def add_knowledge_entry(tab_id: int, body: dict):
    content = str((body or {}).get("content", "")).strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    chunks = _chunk_text(content)
    conn = _knowledge_conn()
    for idx, chunk in enumerate(chunks):
        conn.execute(
            "INSERT INTO knowledge_entries(tab_id, content, chunk_index, source_filename) VALUES (?, ?, ?, NULL)",
            (tab_id, chunk, idx),
        )
    conn.commit()
    conn.close()
    return {"ok": True, "chunks": len(chunks)}


@app.post("/api/knowledge/tabs/{tab_id}/upload")
async def upload_knowledge_file(tab_id: int, file: UploadFile = File(...)):
    text = (await file.read()).decode("utf-8", errors="ignore")
    chunks = _chunk_text(text)
    conn = _knowledge_conn()
    for idx, chunk in enumerate(chunks):
        conn.execute(
            "INSERT INTO knowledge_entries(tab_id, content, chunk_index, source_filename) VALUES (?, ?, ?, ?)",
            (tab_id, chunk, idx, file.filename),
        )
    conn.commit()
    conn.close()
    return {"ok": True, "filename": file.filename, "chunks": len(chunks)}


@app.delete("/api/knowledge/tabs/{tab_id}/file/{filename}")
async def delete_knowledge_file(tab_id: int, filename: str):
    conn = _knowledge_conn()
    conn.execute("DELETE FROM knowledge_entries WHERE tab_id = ? AND source_filename = ?", (tab_id, filename))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.put("/api/knowledge/entries/{entry_id}")
async def update_knowledge_entry(entry_id: int, body: dict):
    content = str((body or {}).get("content", "")).strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content required")
    conn = _knowledge_conn()
    conn.execute("UPDATE knowledge_entries SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (content, entry_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/knowledge/entries/{entry_id}")
async def delete_knowledge_entry(entry_id: int):
    conn = _knowledge_conn()
    conn.execute("DELETE FROM knowledge_entries WHERE id = ?", (entry_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/goals/scopes")
async def get_goal_scopes():
    conn = _mind_conn()
    rows = conn.execute(
        """
        SELECT gs.name, COUNT(g.id) AS count
        FROM goal_scopes gs
        LEFT JOIN goals g ON g.scope = gs.name AND g.parent_id IS NULL
        GROUP BY gs.name
        ORDER BY CASE gs.name WHEN 'default' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, gs.name
        """
    ).fetchall()
    conn.close()
    return {"scopes": [dict(r) for r in rows]}


@app.post("/api/goals/scopes")
async def create_goal_scope(body: dict):
    name = str((body or {}).get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Scope name required")
    conn = _mind_conn()
    conn.execute("INSERT OR IGNORE INTO goal_scopes(name) VALUES (?)", (name,))
    conn.commit()
    conn.close()
    return {"ok": True, "name": name}


@app.delete("/api/goals/scopes/{name}")
async def delete_goal_scope(name: str):
    if name in {"default", "global"}:
        raise HTTPException(status_code=400, detail="Cannot delete reserved scope")
    conn = _mind_conn()
    goal_ids = [r[0] for r in conn.execute("SELECT id FROM goals WHERE scope = ?", (name,)).fetchall()]
    if goal_ids:
        conn.executemany("DELETE FROM goal_progress WHERE goal_id = ?", [(gid,) for gid in goal_ids])
    conn.execute("DELETE FROM goals WHERE scope = ?", (name,))
    conn.execute("DELETE FROM goal_scopes WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    return {"ok": True}


def _goal_with_details(conn: sqlite3.Connection, goal_row: sqlite3.Row) -> dict:
    goal = dict(goal_row)
    goal["permanent"] = bool(goal.get("permanent"))
    subtasks = conn.execute(
        "SELECT id, title, status FROM goals WHERE parent_id = ? ORDER BY id",
        (goal["id"],),
    ).fetchall()
    progress = conn.execute(
        "SELECT id, note, created_at FROM goal_progress WHERE goal_id = ? ORDER BY id DESC",
        (goal["id"],),
    ).fetchall()
    goal["subtasks"] = [dict(r) for r in subtasks]
    goal["progress"] = [dict(r) for r in progress]
    return goal


@app.get("/api/goals")
async def list_goals(scope: str = "default", status: str = "active"):
    conn = _mind_conn()
    if status == "all":
        rows = conn.execute(
            "SELECT id, title, description, priority, status, permanent, parent_id, scope, created_at, updated_at FROM goals WHERE scope = ? AND parent_id IS NULL ORDER BY updated_at DESC, id DESC",
            (scope,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, title, description, priority, status, permanent, parent_id, scope, created_at, updated_at FROM goals WHERE scope = ? AND parent_id IS NULL AND status = ? ORDER BY updated_at DESC, id DESC",
            (scope, status),
        ).fetchall()
    goals = [_goal_with_details(conn, r) for r in rows]
    conn.close()
    return {"goals": goals}


@app.get("/api/goals/{goal_id}")
async def get_goal(goal_id: int):
    conn = _mind_conn()
    row = conn.execute(
        "SELECT id, title, description, priority, status, permanent, parent_id, scope, created_at, updated_at FROM goals WHERE id = ?",
        (goal_id,),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Goal not found")
    goal = _goal_with_details(conn, row)
    conn.close()
    return goal


@app.post("/api/goals")
async def create_goal(body: dict):
    title = str((body or {}).get("title", "")).strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    description = str((body or {}).get("description", "")).strip() or None
    priority = str((body or {}).get("priority", "medium")).strip() or "medium"
    permanent = 1 if (body or {}).get("permanent") else 0
    parent_id = (body or {}).get("parent_id")
    scope = str((body or {}).get("scope", "default")).strip() or "default"
    conn = _mind_conn()
    conn.execute("INSERT OR IGNORE INTO goal_scopes(name) VALUES (?)", (scope,))
    cur = conn.execute(
        "INSERT INTO goals(title, description, priority, status, permanent, parent_id, scope, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))",
        (title, description, priority, permanent, parent_id, scope),
    )
    new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return {"ok": True, "id": new_id}


@app.put("/api/goals/{goal_id}")
async def update_goal(goal_id: int, body: dict):
    conn = _mind_conn()
    row = conn.execute("SELECT id, title, description, priority, status, permanent FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Goal not found")
    title = str((body or {}).get("title", row["title"])).strip() or row["title"]
    description = (body or {}).get("description", row["description"])
    priority = str((body or {}).get("priority", row["priority"])).strip() or row["priority"]
    status = str((body or {}).get("status", row["status"])).strip() or row["status"]
    permanent = 1 if (body or {}).get("permanent", bool(row["permanent"])) else 0
    conn.execute(
        "UPDATE goals SET title = ?, description = ?, priority = ?, status = ?, permanent = ?, updated_at = datetime('now') WHERE id = ?",
        (title, description, priority, status, permanent, goal_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/goals/{goal_id}")
async def delete_goal(goal_id: int):
    conn = _mind_conn()
    conn.execute("DELETE FROM goal_progress WHERE goal_id = ?", (goal_id,))
    conn.execute("DELETE FROM goals WHERE parent_id = ?", (goal_id,))
    conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/goals/{goal_id}/progress")
async def add_goal_progress(goal_id: int, body: dict):
    note = str((body or {}).get("note", "")).strip()
    if not note:
        raise HTTPException(status_code=400, detail="Progress note required")
    conn = _mind_conn()
    conn.execute("INSERT INTO goal_progress(goal_id, note, created_at) VALUES (?, ?, datetime('now'))", (goal_id, note))
    conn.execute("UPDATE goals SET updated_at = datetime('now') WHERE id = ?", (goal_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Static ────────────────────────────────────────────────────────────────────
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    logger.info(f"Terminus v2.1.0 | model={claude_client.model} | voice={voice_engine.backend} | tools={len(claude_client.tools or [])}")
    logger.info(f"Continuity DB: {len(continuity_db.get_all_conversations())} conversations")
    scheduler.start()


@app.on_event("shutdown")
async def shutdown_event():
    scheduler.stop()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.HOST, port=settings.PORT, log_level="info")
