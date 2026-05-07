"""
Tool use for Terminus — Claude-native tool definitions + executors.

Tools available to Claude:
  web_search(query)              — DuckDuckGo search, no API key required
  read_file(path)                — Read a file from the Mac filesystem
  write_file(path, content)      — Write a file (restricted to safe paths)
  list_directory(path)           — List directory contents
  run_command(command)           — Run a safe shell command (read-only subset)

Security:
  - write_file restricted to ~/.terminus/ and ~/Documents/Terminus/
  - run_command allows only a safe allowlist of commands
  - Sensitive files (.env, credentials, keys) are blocked for read
"""

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

try:
    from duckduckgo_search import DDGS
    SEARCH_AVAILABLE = True
except ImportError:
    SEARCH_AVAILABLE = False
    logger.warning("duckduckgo-search not installed — web_search tool disabled")

# Paths that write_file is allowed to write into
WRITABLE_ROOTS = [
    Path.home() / ".terminus",
    Path.home() / "Documents" / "Terminus",
]

# Sensitive files that read_file must never return
BLOCKED_NAMES = {".env", ".env.local", "credentials.json", "secret_key", "cookies.txt"}
BLOCKED_FRAGMENTS = {"api_key", "api-key", "secret", "sk-", "token"}

# Allowlist for run_command
SAFE_COMMANDS = {
    "ls", "pwd", "echo", "cat", "head", "tail", "wc",
    "date", "uname", "whoami", "df", "du", "find", "grep",
    "sqlite3", "python3", "pip", "npm", "node", "git",
}


# ── Tool definitions for Anthropic API ───────────────────────────────────────

SEARCH_TOOL = {
    "name": "web_search",
    "description": (
        "Search the web using DuckDuckGo. Returns up to 5 results with title, URL, and snippet. "
        "Use this when the user asks about current events, facts you're uncertain about, "
        "or topics that benefit from a live web lookup."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query.",
            },
            "max_results": {
                "type": "integer",
                "description": "Number of results to return (1-10). Default 5.",
            },
        },
        "required": ["query"],
    },
}

READ_FILE_TOOL = {
    "name": "read_file",
    "description": (
        "Read a file from your Mac filesystem. Useful for reading notes, documents, "
        "code files, or any text file you want to reference. Sensitive files are blocked."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute or ~ path to the file.",
            },
        },
        "required": ["path"],
    },
}

WRITE_FILE_TOOL = {
    "name": "write_file",
    "description": (
        "Write content to a file. Restricted to ~/.terminus/ and ~/Documents/Terminus/. "
        "Use this to save notes, journal entries, or generated content."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path within ~/.terminus/ or ~/Documents/Terminus/.",
            },
            "content": {
                "type": "string",
                "description": "Content to write to the file.",
            },
            "append": {
                "type": "boolean",
                "description": "If true, append instead of overwriting. Default false.",
            },
        },
        "required": ["path", "content"],
    },
}

LIST_DIR_TOOL = {
    "name": "list_directory",
    "description": "List the contents of a directory on your Mac.",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute or ~ path to the directory.",
            },
        },
        "required": ["path"],
    },
}

RUN_COMMAND_TOOL = {
    "name": "run_command",
    "description": (
        "Run a read-only shell command. Restricted to a safe allowlist: "
        "ls, cat, grep, find, date, df, du, git status/log/diff, sqlite3 queries, etc. "
        "Use for quick lookups, file inspection, or checking system state."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run.",
            },
        },
        "required": ["command"],
    },
}


def all_tools(include_trace_tools: bool = True) -> list:
    """
    Return the full list of tool definitions to pass to the Anthropic API.

    Args:
        include_trace_tools: Whether to include reasoning-trace tools
    """
    from core.tracer import TRACE_TOOLS

    tools = [SEARCH_TOOL, READ_FILE_TOOL, WRITE_FILE_TOOL, LIST_DIR_TOOL, RUN_COMMAND_TOOL]
    if include_trace_tools:
        tools.extend(TRACE_TOOLS)
    return tools


# ── Tool execution ────────────────────────────────────────────────────────────

def execute_tool(name: str, inputs: dict) -> Any:
    """
    Execute a tool call from Claude and return the result.
    Routes to the appropriate handler, with error handling.
    """
    handlers = {
        "web_search": _web_search,
        "read_file": _read_file,
        "write_file": _write_file,
        "list_directory": _list_directory,
        "run_command": _run_command,
    }

    # Check trace tools
    from core.tracer import execute_trace_tool, TRACE_TOOLS
    trace_tool_names = {t["name"] for t in TRACE_TOOLS}

    if name in trace_tool_names:
        result = execute_trace_tool(name, inputs)
    elif name in handlers:
        result = handlers[name](inputs)
    else:
        result = f"Unknown tool: {name}"

    logger.info(f"[tool] {name}({list(inputs.keys())}) → {str(result)[:100]}")
    return result


def _web_search(inputs: dict) -> str:
    if not SEARCH_AVAILABLE:
        return "Web search unavailable — install duckduckgo-search"

    query = inputs.get("query", "")
    max_results = min(int(inputs.get("max_results", 5)), 10)

    if not query:
        return "No query provided"

    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))

        if not results:
            return f"No results found for: {query}"

        formatted = [f"**Search results for: {query}**\n"]
        for i, r in enumerate(results, 1):
            title = r.get("title", "No title")
            url = r.get("href", "")
            body = r.get("body", "")[:300]
            formatted.append(f"{i}. **{title}**\n   {url}\n   {body}\n")

        return "\n".join(formatted)
    except Exception as e:
        logger.error(f"[tool] web_search failed: {e}")
        return f"Search failed: {e}"


def _read_file(inputs: dict) -> str:
    path_str = inputs.get("path", "")
    if not path_str:
        return "No path provided"

    path = Path(path_str).expanduser().resolve()

    # Block sensitive files
    if path.name in BLOCKED_NAMES:
        return f"Access denied: {path.name} is a sensitive file"
    if any(frag in path.name.lower() for frag in BLOCKED_FRAGMENTS):
        return f"Access denied: {path.name} appears to be a sensitive file"

    if not path.exists():
        return f"File not found: {path}"
    if not path.is_file():
        return f"Not a file: {path}"

    try:
        content = path.read_text(encoding="utf-8", errors="replace")
        max_chars = 8000
        if len(content) > max_chars:
            content = content[:max_chars] + f"\n\n[... {len(content) - max_chars} more chars truncated]"
        return content
    except Exception as e:
        return f"Failed to read {path}: {e}"


def _write_file(inputs: dict) -> str:
    path_str = inputs.get("path", "")
    content = inputs.get("content", "")
    append = bool(inputs.get("append", False))

    if not path_str:
        return "No path provided"

    path = Path(path_str).expanduser().resolve()

    # Enforce writable root restriction
    allowed = any(
        str(path).startswith(str(root.expanduser().resolve()))
        for root in WRITABLE_ROOTS
    )
    if not allowed:
        return (
            f"Write denied: path must be inside ~/.terminus/ or ~/Documents/Terminus/. "
            f"Got: {path}"
        )

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if append else "w"
        with path.open(mode, encoding="utf-8") as f:
            f.write(content)
        action = "appended to" if append else "written to"
        return f"Content {action} {path} ({len(content)} chars)"
    except Exception as e:
        return f"Failed to write {path}: {e}"


def _list_directory(inputs: dict) -> str:
    path_str = inputs.get("path", "")
    if not path_str:
        return "No path provided"

    path = Path(path_str).expanduser().resolve()
    if not path.exists():
        return f"Directory not found: {path}"
    if not path.is_dir():
        return f"Not a directory: {path}"

    try:
        entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
        lines = []
        for entry in entries[:100]:
            kind = "📁" if entry.is_dir() else "📄"
            size = ""
            if entry.is_file():
                try:
                    size = f" ({entry.stat().st_size:,} bytes)"
                except Exception:
                    pass
            lines.append(f"{kind} {entry.name}{size}")
        result = f"Contents of {path} ({len(entries)} items):\n\n" + "\n".join(lines)
        if len(entries) > 100:
            result += f"\n\n[... {len(entries) - 100} more items]"
        return result
    except Exception as e:
        return f"Failed to list {path}: {e}"


def _run_command(inputs: dict) -> str:
    command = inputs.get("command", "").strip()
    if not command:
        return "No command provided"

    # Validate the first word is in the safe allowlist
    base_cmd = command.split()[0].split("/")[-1]
    if base_cmd not in SAFE_COMMANDS:
        return (
            f"Command '{base_cmd}' not in safe allowlist. "
            f"Allowed: {', '.join(sorted(SAFE_COMMANDS))}"
        )

    # Block obviously dangerous patterns
    dangerous = ["rm ", "rm\t", "rmdir", "dd ", "mkfs", ">", "sudo", "chmod 777", "curl", "wget"]
    for d in dangerous:
        if d in command:
            return f"Command blocked: contains unsafe pattern '{d}'"

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        output = result.stdout or ""
        if result.stderr:
            output += f"\n[stderr]: {result.stderr[:500]}"
        if not output.strip():
            return "(no output)"
        if len(output) > 4000:
            output = output[:4000] + f"\n[... {len(output) - 4000} chars truncated]"
        return output
    except subprocess.TimeoutExpired:
        return "Command timed out after 15 seconds"
    except Exception as e:
        return f"Command failed: {e}"
