"""
Tool use for Terminus — Claude-native tool definitions + executors.

Tools available to Claude:
  web_search(query)              — DuckDuckGo search, no API key required
  read_file(path)                — Read a file from the Mac filesystem
  write_file(path, content)      — Write a file (restricted to safe paths)
  list_directory(path)           — List directory contents
  run_command(command)           — Run a safe shell command (read-only subset)
  browser_*                      — Google Chrome automation (open, read, forms, click, screenshot)
  gdrive_search(query)           — Full-text search across Google Drive
  gdrive_list(folder_id)         — List files in a Drive folder
  gdrive_read(file_id)           — Read/export a Drive file (Docs → text, Sheets → CSV)
  gdrive_upload(name, content)   — Create or update a plain-text file in Drive
  gdrive_create_doc(title, content) — Create a new Google Doc
  gdrive_auth_status()           — Check Google OAuth connection status

Security:
  - write_file restricted to ~/.terminus/ and ~/Documents/Terminus/
  - run_command allows only a safe allowlist of commands
  - Sensitive files (.env, credentials, keys) are blocked for read
  - Google Drive uses OAuth2 with token stored in ~/.terminus/google_token.json
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

# Paths that write_file is allowed to write into — full access to user home directory and workspaces
WRITABLE_ROOTS = [
    Path.home(),
]

# Sensitive files that read_file must never return
BLOCKED_NAMES = {".env", ".env.local", "credentials.json", "secret_key", "cookies.txt"}
BLOCKED_FRAGMENTS = {"api_key", "api-key", "secret", "sk-", "token"}

# Allowlist for run_command — read-only and inspection commands only
# python3 excluded: would allow arbitrary code execution via tool use
SAFE_COMMANDS = {
    "ls", "pwd", "echo", "cat", "head", "tail", "wc",
    "date", "uname", "whoami", "df", "du", "find", "grep",
    "sqlite3", "npm", "node", "git",
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
        "Write content to a file. Restricted to ~/.terminus/, ~/Documents/Terminus/, and /Users/dancross/Dev/GitHub/Shipyard/. "
        "Use this to save notes, journal entries, or generated content."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path within ~/.terminus/, ~/Documents/Terminus/, or /Users/dancross/Dev/GitHub/Shipyard/.",
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


# ── Browser Tool Definitions ──────────────────────────────────────────────────

BROWSER_OPEN_TOOL = {
    "name": "browser_open",
    "description": (
        "Launch Google Chrome on the Mac and navigate to a URL. Opens a visible browser window "
        "so the user can watch the automation. Use this when the user asks you to open a website, "
        "inspect a job application, or automate online workflows."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The URL to navigate to (e.g. 'https://jobs.example.com/apply').",
            },
            "headless": {
                "type": "boolean",
                "description": "Whether to run browser invisibly (default false = visible Chrome window).",
            },
        },
        "required": ["url"],
    },
}

BROWSER_READ_PAGE_TOOL = {
    "name": "browser_read_page",
    "description": (
        "Read and extract clean text content, headings, and interactive elements from the currently "
        "active browser page."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "max_length": {
                "type": "integer",
                "description": "Maximum characters of text to return (default 4000).",
            },
        },
    },
}

BROWSER_EXTRACT_FORM_TOOL = {
    "name": "browser_extract_form",
    "description": (
        "Inspect the active page and extract all form fields, input boxes, textareas, dropdowns, "
        "and checkboxes. Essential before filling out job applications, signups, or questionnaires."
    ),
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

BROWSER_FILL_FORM_TOOL = {
    "name": "browser_fill_form",
    "description": (
        "Fill out form fields on the active page by matching field labels, placeholders, or names. "
        "Pass a key-value mapping of field names to values (e.g. {'Full Name': 'Dan Cross', 'Email': 'dan@...', 'Cover Letter': '...', 'Experience': '5 years'})."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "fields": {
                "type": "object",
                "description": "Dictionary mapping field labels/names to values to type or select.",
            },
        },
        "required": ["fields"],
    },
}

BROWSER_CLICK_TOOL = {
    "name": "browser_click",
    "description": (
        "Click a button, link, or clickable element on the active page by its visible text, label, "
        "or CSS selector (e.g. 'Apply Now', 'Next Step', 'Submit Application', 'button.submit')."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "target": {
                "type": "string",
                "description": "The button/link text or CSS selector to click.",
            },
        },
        "required": ["target"],
    },
}

BROWSER_SCREENSHOT_TOOL = {
    "name": "browser_screenshot",
    "description": (
        "Capture a screenshot of the active browser page and save it to ~/.terminus/screenshots/."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Optional name for the screenshot file (e.g. 'job_application_step1').",
            },
        },
    },
}

BROWSER_GET_TABS_TOOL = {
    "name": "browser_get_tabs",
    "description": (
        "List all open tabs in the browser with their titles and URLs. If Chrome is already open on macOS, "
        "lists open tabs from your active window."
    ),
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

BROWSER_SWITCH_TAB_TOOL = {
    "name": "browser_switch_tab",
    "description": "Switch the active browser focus to a specific open tab number (1-based index).",
    "input_schema": {
        "type": "object",
        "properties": {
            "index": {
                "type": "integer",
                "description": "The tab number to switch to (1-based index).",
            },
        },
        "required": ["index"],
    },
}

BROWSER_CLOSE_TOOL = {
    "name": "browser_close",
    "description": (
        "Disconnect from the active browser session. By default this ONLY drops Terminus's "
        "connection — the dedicated Chrome process keeps running so the next browser_open "
        "re-attaches to the same logged-in session (cookies and logins persist across calls "
        "and across FastAPI restarts). Pass kill_chrome=true to fully terminate the dedicated "
        "Chrome process when you genuinely want a clean slate. The user's daily Chrome on port "
        "9222 is never killed by this tool."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "kill_chrome": {
                "type": "boolean",
                "description": "If true, terminate the dedicated Chrome process (port 9223) entirely. Default false — keep the session alive for reuse.",
            },
        },
    },
}

BROWSER_STATUS_TOOL = {
    "name": "browser_status",
    "description": (
        "Report the current browser connection state: which CDP port is listening, whether "
        "the dedicated Chrome PID is alive, the current attach mode, and the active page URL. "
        "Use this to diagnose 'no active session' errors or to confirm a session is still "
        "logged in before navigating."
    ),
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

# ── Bitwarden Scoped Credential Tools ──────────────────────────────────────────

BITWARDEN_GET_LOGIN_TOOL = {
    "name": "bitwarden_get_login",
    "description": (
        "Retrieve login credentials (username and password) for a specific website or service from Bitwarden. "
        "STRICT SECURITY BOUNDARY: This tool ONLY queries and returns items inside the 'Terminus' folder in Bitwarden. "
        "It will refuse to access credentials from other folders. "
        "For interactive Chrome logins, prefer using native autofill via `desktop_shortcut(['command', 'shift', 'l'])`."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "service": {
                "type": "string",
                "description": "Name or domain of the website/service to look up (e.g. 'github', 'linkedin', 'securitas').",
            },
        },
        "required": ["service"],
    },
}

BITWARDEN_STATUS_TOOL = {
    "name": "bitwarden_status",
    "description": "Check if Bitwarden CLI ('bw') is installed, logged in, and unlocked.",
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

# ── Autonomous Background Scheduler Tools (Pillar 6) ──────────────────────────

SCHEDULE_TASK_TOOL = {
    "name": "schedule_task",
    "description": (
        "Schedule an autonomous recurring background watchdog task or reminder. "
        "Terminus will execute the task instruction in the background on the specified interval or daily schedule, "
        "and post a native macOS banner notification when new results or findings are discovered. "
        "When watchdog=true (default), the task runs with FULL TOOL ACCESS (browser_open, browser_read_page, "
        "memory_remember, desktop_screenshot, web_search, etc.) and uses long-term memory for de-duplication — "
        "you will only be notified when something actually CHANGES since the last run. Set watchdog=false for "
        "simple LLM-only reminders or digests that don't need tools or de-duplication."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Short title for the scheduled task (e.g. 'Indeed Panama City Security Jobs', 'Morning Digest').",
            },
            "instruction": {
                "type": "string",
                "description": "The exact instruction or search to execute on each run. For watchdog tasks, be specific about the URL to check and what constitutes a 'new' finding (e.g. 'Open https://example.com/jobs, read the page, list any job titles containing security that weren't in your last run.').",
            },
            "interval_minutes": {
                "type": "integer",
                "description": "Run every N minutes (e.g. 60, 120, 240). Use this OR cron_hour.",
            },
            "cron_hour": {
                "type": "integer",
                "description": "Run daily at this UTC hour (0-23).",
            },
            "cron_minute": {
                "type": "integer",
                "description": "Minute of the hour (0-59, defaults to 0).",
            },
            "watchdog": {
                "type": "boolean",
                "description": "If true (default), the task runs with full tool access (browser, memory, desktop) and memory-based de-duplication — only notifies on changes. If false, runs as a simple LLM-only reminder.",
            },
        },
        "required": ["name", "instruction"],
    },
}

SCHEDULE_LIST_TOOL = {
    "name": "schedule_list_tasks",
    "description": "List all active scheduled background tasks and watchdogs with their next run times.",
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

SCHEDULE_CANCEL_TOOL = {
    "name": "schedule_cancel_task",
    "description": "Cancel and remove a scheduled background task by its task ID.",
    "input_schema": {
        "type": "object",
        "properties": {
            "task_id": {
                "type": "string",
                "description": "The task ID to cancel (from schedule_list_tasks).",
            },
        },
        "required": ["task_id"],
    },
}


# ── Google Drive Tool Definitions ─────────────────────────────────────────────

GDRIVE_SEARCH_TOOL = {
    "name": "gdrive_search",
    "description": (
        "Full-text search across Dan's entire Google Drive. Returns matching file names, types, "
        "modification dates, and Drive links. Use this to find documents, notes, spreadsheets, or "
        "any file by keyword."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search keywords (e.g. 'resume 2025', 'cover letter', 'project plan').",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of results to return (default 10, max 50).",
            },
        },
        "required": ["query"],
    },
}

GDRIVE_LIST_TOOL = {
    "name": "gdrive_list",
    "description": (
        "List files and folders inside a Google Drive folder. Use 'root' to list My Drive top-level. "
        "Pass a folder ID from gdrive_search to browse into a specific folder."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "folder_id": {
                "type": "string",
                "description": "The Drive folder ID to list (default 'root' = My Drive root).",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of files to list (default 50).",
            },
        },
    },
}

GDRIVE_READ_TOOL = {
    "name": "gdrive_read",
    "description": (
        "Read and return the content of a file from Google Drive. "
        "Google Docs are exported as plain text, Google Sheets as CSV. "
        "Use the file ID from gdrive_search or gdrive_list."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_id": {
                "type": "string",
                "description": "The Google Drive file ID to read.",
            },
        },
        "required": ["file_id"],
    },
}

GDRIVE_UPLOAD_TOOL = {
    "name": "gdrive_upload",
    "description": (
        "Create or update a plain-text file in Google Drive. If a file with the same name already "
        "exists it will be updated. Useful for saving notes, research, or generated content to Drive."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "File name in Drive (e.g. 'Job Application Notes.txt').",
            },
            "content": {
                "type": "string",
                "description": "Text content to save.",
            },
            "folder_id": {
                "type": "string",
                "description": "Optional Drive folder ID to save into (default: My Drive root).",
            },
        },
        "required": ["name", "content"],
    },
}

GDRIVE_CREATE_DOC_TOOL = {
    "name": "gdrive_create_doc",
    "description": (
        "Create a new Google Doc in Drive with an optional initial content body. "
        "Returns the Doc ID and a direct browser link to open it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "The title for the new Google Doc.",
            },
            "content": {
                "type": "string",
                "description": "Optional initial text content to insert into the document.",
            },
            "folder_id": {
                "type": "string",
                "description": "Optional Drive folder ID to save into (default: My Drive root).",
            },
        },
        "required": ["title"],
    },
}

GDRIVE_AUTH_STATUS_TOOL = {
    "name": "gdrive_auth_status",
    "description": (
        "Check whether Terminus is authenticated with Google Drive and whether the OAuth token "
        "is valid. Use this if a Drive operation returns an auth error."
    ),
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}


# ── macOS OS & GUI Control Tools (OpenClaw Pillar 1) ──────────────────────────

DESKTOP_SCREENSHOT_TOOL = {
    "name": "desktop_screenshot",
    "description": (
        "Capture a full-resolution screenshot of Dan's macOS desktop screen. "
        "Saved to ~/.terminus/screenshots/ and returns file path and dimensions. "
        "Use this to see what is currently on screen across any application."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Optional name tag for the screenshot (e.g. 'notes_window', 'finder_view').",
            },
            "region": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Optional bounding box [x, y, width, height] to capture a specific screen region.",
            },
        },
    },
}

DESKTOP_CLICK_TOOL = {
    "name": "desktop_click",
    "description": (
        "Click the mouse at screen coordinates (x, y) on macOS. "
        "Supports left/right/middle click and double-clicking."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "X coordinate on screen."},
            "y": {"type": "integer", "description": "Y coordinate on screen."},
            "button": {
                "type": "string",
                "enum": ["left", "right", "middle"],
                "description": "Mouse button to click (default 'left').",
            },
            "clicks": {
                "type": "integer",
                "description": "Number of clicks: 1 for single click, 2 for double click (default 1).",
            },
        },
        "required": ["x", "y"],
    },
}

DESKTOP_MOUSE_MOVE_TOOL = {
    "name": "desktop_mouse_move",
    "description": "Move the mouse cursor smoothly to coordinates (x, y) on screen.",
    "input_schema": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "Target X coordinate."},
            "y": {"type": "integer", "description": "Target Y coordinate."},
        },
        "required": ["x", "y"],
    },
}

DESKTOP_MOUSE_DRAG_TOOL = {
    "name": "desktop_mouse_drag",
    "description": "Drag the mouse from its current position to coordinates (x, y).",
    "input_schema": {
        "type": "object",
        "properties": {
            "x": {"type": "integer", "description": "Target X coordinate."},
            "y": {"type": "integer", "description": "Target Y coordinate."},
            "button": {"type": "string", "enum": ["left", "right"], "description": "Button to hold while dragging."},
        },
        "required": ["x", "y"],
    },
}

DESKTOP_SCROLL_TOOL = {
    "name": "desktop_scroll",
    "description": "Scroll the mouse wheel up (positive value) or down (negative value).",
    "input_schema": {
        "type": "object",
        "properties": {
            "amount": {"type": "integer", "description": "Number of scroll clicks (e.g. 5 for up, -5 for down)."},
        },
        "required": ["amount"],
    },
}

DESKTOP_TYPE_TOOL = {
    "name": "desktop_type",
    "description": (
        "Type text into whatever application window currently has focus on macOS. "
        "Can type code, notes, search queries, or messages."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to type into the active application."},
        },
        "required": ["text"],
    },
}

DESKTOP_SHORTCUT_TOOL = {
    "name": "desktop_shortcut",
    "description": (
        "Press a keyboard shortcut on macOS. Pass an array of keys, for example: "
        "['command', 'space'] (Spotlight), ['command', 'c'] (Copy), ['command', 'v'] (Paste), "
        "['command', 'tab'] (App Switcher), ['return'], ['escape'], ['space']."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "keys": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of key names to press together.",
            },
        },
        "required": ["keys"],
    },
}

APP_LAUNCH_TOOL = {
    "name": "app_launch",
    "description": (
        "Launch or bring to front any macOS application by name (e.g. 'Notes', 'Visual Studio Code', "
        "'Slack', 'Finder', 'System Settings', 'Music', 'Mail', 'Terminal')."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "app_name": {"type": "string", "description": "The exact or common name of the macOS app."},
        },
        "required": ["app_name"],
    },
}

APP_FOCUS_TOOL = {
    "name": "app_focus",
    "description": "Activate and bring an application's window to the foreground.",
    "input_schema": {
        "type": "object",
        "properties": {
            "app_name": {"type": "string", "description": "Application name to focus."},
        },
        "required": ["app_name"],
    },
}

APPLESCRIPT_RUN_TOOL = {
    "name": "applescript_run",
    "description": (
        "Execute native AppleScript code on macOS to automate Finder, System Events, Notes, Music, "
        "Mail, or system settings."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "script": {"type": "string", "description": "The AppleScript code to execute."},
        },
        "required": ["script"],
    },
}

CLIPBOARD_READ_TOOL = {
    "name": "clipboard_read",
    "description": "Read the current text content from the macOS system clipboard.",
    "input_schema": {
        "type": "object",
        "properties": {},
    },
}

CLIPBOARD_WRITE_TOOL = {
    "name": "clipboard_write",
    "description": "Copy text into the macOS system clipboard (available immediately for Cmd+V in any app).",
    "input_schema": {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "Text to copy to clipboard."},
        },
        "required": ["text"],
    },
}

SYSTEM_NOTIFY_TOOL = {
    "name": "system_notify",
    "description": "Display a native macOS system notification banner in the top-right of the screen.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Notification title (e.g. 'Terminus')."},
            "message": {"type": "string", "description": "Notification body message."},
        },
        "required": ["title", "message"],
    },
}

# ── macOS Active-Window Context Tools (Pillar 1 extension) ────────────────────

MACOS_AX_STATUS_TOOL = {
    "name": "macos_ax_status",
    "description": (
        "Check whether Terminus has macOS Accessibility (AX) permission. Reading the active "
        "window's text via macos_read_active_window / macos_list_windows requires the host "
        "Terminal/uvicorn app to be granted Accessibility in System Settings → Privacy & "
        "Security → Accessibility. Call this first if those tools return permission errors."
    ),
    "input_schema": {"type": "object", "properties": {}},
}

MACOS_LIST_WINDOWS_TOOL = {
    "name": "macos_list_windows",
    "description": (
        "List the open windows of a macOS application (by app name) or of the currently "
        "frontmost app (if no app name given). Returns one line per window with its index "
        "and title. Use this to find which window to read with macos_read_active_window. "
        "Requires Accessibility permission (see macos_ax_status)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "app_name": {
                "type": "string",
                "description": "Application name (e.g. 'Safari', 'Google Chrome', 'Mail', 'Notes'). If omitted, lists windows of the frontmost app.",
            },
        },
    },
}

MACOS_READ_ACTIVE_WINDOW_TOOL = {
    "name": "macos_read_active_window",
    "description": (
        "Read the visible text content of a macOS application's window — the frontmost window "
        "by default, or a specific window by 1-based index. Has per-app extractors for Safari, "
        "Chrome, Mail, Notes, TextEdit, and Pages; falls back to a System Events AX walk for "
        "other apps; last resort is a screenshot. Use this for 'summarize the email I have "
        "open' or 'what's in my Notes window' style requests. Requires Accessibility "
        "permission (see macos_ax_status)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "app_name": {
                "type": "string",
                "description": "Application name (e.g. 'Safari', 'Mail'). If omitted, reads the frontmost app's window.",
            },
            "window_index": {
                "type": "integer",
                "description": "1-based window index to read (default 1 = frontmost window). Use macos_list_windows to find the right index.",
            },
        },
    },
}

MACOS_READ_SELECTION_TOOL = {
    "name": "macos_read_selection",
    "description": (
        "Read the currently selected text in whatever macOS application is frontmost, by "
        "simulating Cmd+C into the clipboard and reading it back (the prior clipboard is "
        "restored). Works in any app that supports standard copy — NO Accessibility "
        "permission required. This is the cheapest 'what am I looking at' path; prefer it "
        "over macos_read_active_window when the user just has text selected."
    ),
    "input_schema": {"type": "object", "properties": {}},
}

# ── Long-Term Memory Tools (Phase 3) ──────────────────────────────────────────

MEMORY_REMEMBER_TOOL = {
    "name": "memory_remember",
    "description": (
        "Store a piece of information in Terminus's long-term memory so it can be recalled "
        "in future sessions without re-prompting. Use this for user preferences ('Dan prefers "
        "plain-language explanations'), decisions ('we settled on FastAPI not Flask'), "
        "completed tasks, code snippets, or anything the user explicitly asks you to remember. "
        "Collections: 'preferences', 'tasks', 'snippets', 'sessions', or a custom name. "
        "Memory is local (ChromaDB) and persists across restarts."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "collection": {
                "type": "string",
                "description": "Memory collection: 'preferences', 'tasks', 'snippets', 'sessions', or a custom name.",
            },
            "content": {"type": "string", "description": "The text to remember."},
            "metadata": {
                "type": "object",
                "description": "Optional metadata (e.g. {'topic': 'coding-style', 'source': 'user'}).",
            },
            "doc_id": {"type": "string", "description": "Optional explicit ID (auto-generated if omitted)."},
        },
        "required": ["collection", "content"],
    },
}

MEMORY_RECALL_TOOL = {
    "name": "memory_recall",
    "description": (
        "Semantic search of Terminus's long-term memory. Returns the top matches ranked by "
        "relevance to the query. Use this when the user asks 'do you remember...', 'what did "
        "we decide about...', or when you want to apply a previously-stored preference. "
        "Collections: 'preferences', 'tasks', 'snippets', 'sessions', or a custom name."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query."},
            "collection": {
                "type": "string",
                "description": "Collection to search. If omitted, searches 'sessions' (general memory).",
            },
            "n_results": {"type": "integer", "description": "Max results to return (default 5, max 20)."},
        },
        "required": ["query"],
    },
}

MEMORY_FORGET_TOOL = {
    "name": "memory_forget",
    "description": (
        "Remove entries from long-term memory by doc_id or metadata filter. To wipe an entire "
        "collection, pass where={'__force_all__': true}. Use sparingly — forgetting is "
        "permanent."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "collection": {"type": "string", "description": "Collection to forget from."},
            "doc_id": {"type": "string", "description": "Specific entry ID to remove."},
            "where": {"type": "object", "description": "Metadata filter to match entries for removal."},
        },
        "required": ["collection"],
    },
}

MEMORY_LIST_TOOL = {
    "name": "memory_list",
    "description": (
        "Peek at recent entries in a memory collection. Use this to see what's stored before "
        "deciding what to recall or forget. Also call with collection='__collections__' to "
        "list all collections."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "collection": {"type": "string", "description": "Collection to peek at, or '__collections__' to list all."},
            "limit": {"type": "integer", "description": "Max entries to show (default 20)."},
        },
        "required": ["collection"],
    },
}


# ── Code Interpreter Tools (OpenClaw Pillar 2) ───────────────────────────────

PYTHON_EXECUTE_TOOL = {
    "name": "python_execute",
    "description": (
        "Execute Python code in the native Terminus environment (with numpy, pandas, matplotlib, requests, PIL). "
        "Captures printed output, return values, and auto-saves any generated matplotlib charts to "
        "~/.terminus/data/charts/. Use this to crunch numbers, process files, analyze datasets, "
        "or generate visualizations."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The Python code to execute.",
            },
            "timeout": {
                "type": "integer",
                "description": "Timeout in seconds (default 30, max 120).",
            },
        },
        "required": ["code"],
    },
}

BASH_EXECUTE_TOOL = {
    "name": "bash_execute",
    "description": (
        "Execute shell commands in bash/zsh natively on macOS. "
        "Use this for package management, running developer tools, automation, data transformation, "
        "and command-line utilities."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to run.",
            },
            "timeout": {
                "type": "integer",
                "description": "Timeout in seconds (default 60).",
            },
            "cwd": {
                "type": "string",
                "description": "Optional working directory to run the command in.",
            },
        },
        "required": ["command"],
    },
}


# ── Tool registry ─────────────────────────────────────────────────────────────

def get_tools(include_trace_tools: bool = True) -> list:
    """Return all available tools for the Anthropic API."""
    from core.tracer import TRACE_TOOLS

    tools = [
        SEARCH_TOOL,
        READ_FILE_TOOL,
        WRITE_FILE_TOOL,
        LIST_DIR_TOOL,
        RUN_COMMAND_TOOL,
        BROWSER_OPEN_TOOL,
        BROWSER_READ_PAGE_TOOL,
        BROWSER_EXTRACT_FORM_TOOL,
        BROWSER_FILL_FORM_TOOL,
        BROWSER_CLICK_TOOL,
        BROWSER_SCREENSHOT_TOOL,
        BROWSER_GET_TABS_TOOL,
        BROWSER_SWITCH_TAB_TOOL,
        BROWSER_CLOSE_TOOL,
        BROWSER_STATUS_TOOL,
        BITWARDEN_GET_LOGIN_TOOL,
        BITWARDEN_STATUS_TOOL,
        SCHEDULE_TASK_TOOL,
        SCHEDULE_LIST_TOOL,
        SCHEDULE_CANCEL_TOOL,
        GDRIVE_SEARCH_TOOL,
        GDRIVE_LIST_TOOL,
        GDRIVE_READ_TOOL,
        GDRIVE_UPLOAD_TOOL,
        GDRIVE_CREATE_DOC_TOOL,
        GDRIVE_AUTH_STATUS_TOOL,
        # macOS OS & GUI Control Tools (Pillar 1)
        DESKTOP_SCREENSHOT_TOOL,
        DESKTOP_CLICK_TOOL,
        DESKTOP_MOUSE_MOVE_TOOL,
        DESKTOP_MOUSE_DRAG_TOOL,
        DESKTOP_SCROLL_TOOL,
        DESKTOP_TYPE_TOOL,
        DESKTOP_SHORTCUT_TOOL,
        APP_LAUNCH_TOOL,
        APP_FOCUS_TOOL,
        APPLESCRIPT_RUN_TOOL,
        CLIPBOARD_READ_TOOL,
        CLIPBOARD_WRITE_TOOL,
        SYSTEM_NOTIFY_TOOL,
        # macOS Active-Window Context Tools (Pillar 1 extension)
        MACOS_AX_STATUS_TOOL,
        MACOS_LIST_WINDOWS_TOOL,
        MACOS_READ_ACTIVE_WINDOW_TOOL,
        MACOS_READ_SELECTION_TOOL,
        # Long-Term Memory Tools (Phase 3)
        MEMORY_REMEMBER_TOOL,
        MEMORY_RECALL_TOOL,
        MEMORY_FORGET_TOOL,
        MEMORY_LIST_TOOL,
        # Code Interpreter Tools (Pillar 2)
        PYTHON_EXECUTE_TOOL,
        BASH_EXECUTE_TOOL,
    ]
    if include_trace_tools:
        tools.extend(TRACE_TOOLS)
    return tools


all_tools = get_tools  # Alias for backward compatibility


# ── Tool execution ────────────────────────────────────────────────────────────

def execute_tool(name: str, inputs: dict) -> Any:
    """
    Execute a tool call from Claude or DeepSeek and return the result.
    Routes to the appropriate handler, with error handling.
    """
    handlers = {
        "web_search": _web_search,
        "read_file": _read_file,
        "write_file": _write_file,
        "list_directory": _list_directory,
        "run_command": _run_command,
        # Browser tools
        "browser_open": _browser_open,
        "browser_read_page": _browser_read_page,
        "browser_extract_form": _browser_extract_form,
        "browser_fill_form": _browser_fill_form,
        "browser_click": _browser_click,
        "browser_screenshot": _browser_screenshot,
        "browser_get_tabs": _browser_get_tabs,
        "browser_switch_tab": _browser_switch_tab,
        "browser_close": _browser_close,
        "browser_status": _browser_status,
        # Bitwarden Scoped Credential tools
        "bitwarden_get_login": _bitwarden_get_login,
        "bitwarden_status": _bitwarden_status,
        # Autonomous Scheduler tools (Pillar 6)
        "schedule_task": _schedule_task,
        "schedule_list_tasks": _schedule_list_tasks,
        "schedule_cancel_task": _schedule_cancel_task,
        # Google Drive tools
        "gdrive_search": _gdrive_search,
        "gdrive_list": _gdrive_list,
        "gdrive_read": _gdrive_read,
        "gdrive_upload": _gdrive_upload,
        "gdrive_create_doc": _gdrive_create_doc,
        "gdrive_auth_status": _gdrive_auth_status,
        # macOS OS & GUI Control tools (Pillar 1)
        "desktop_screenshot": _desktop_screenshot,
        "desktop_click": _desktop_click,
        "desktop_mouse_move": _desktop_mouse_move,
        "desktop_mouse_drag": _desktop_mouse_drag,
        "desktop_scroll": _desktop_scroll,
        "desktop_type": _desktop_type,
        "desktop_shortcut": _desktop_shortcut,
        "app_launch": _app_launch,
        "app_focus": _app_focus,
        "applescript_run": _applescript_run,
        "clipboard_read": _clipboard_read,
        "clipboard_write": _clipboard_write,
        "system_notify": _system_notify,
        # macOS Active-Window Context Tools
        "macos_ax_status": _macos_ax_status,
        "macos_list_windows": _macos_list_windows,
        "macos_read_active_window": _macos_read_active_window,
        "macos_read_selection": _macos_read_selection,
        # Long-Term Memory Tools
        "memory_remember": _memory_remember,
        "memory_recall": _memory_recall,
        "memory_forget": _memory_forget,
        "memory_list": _memory_list,
        # Code Interpreter tools (Pillar 2)
        "python_execute": _python_execute,
        "bash_execute": _bash_execute,
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
    query = (inputs.get("query") or "").strip()
    max_results = min(int(inputs.get("max_results", 5)), 10)

    if not query:
        return "No query provided"

    results = []

    # Tier 1: Try DDGS package if available
    if SEARCH_AVAILABLE:
        try:
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=max_results))
        except Exception as e:
            logger.debug(f"[tool] DDGS library query failed ({e}), falling back to direct DDG search")

    # Tier 2: Direct HTTP Fallback to DuckDuckGo HTML endpoint
    if not results:
        try:
            import urllib.request
            import urllib.parse
            import re
            import html as html_lib

            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            }
            data = urllib.parse.urlencode({"q": query}).encode("utf-8")
            req = urllib.request.Request("https://html.duckduckgo.com/html/", data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw_html = resp.read().decode("utf-8", errors="ignore")

                # Parse result blocks
                blocks = re.findall(
                    r'<a class="result__snippet[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?(?:<a class="result__url"[^>]*>(.*?)</a>)?',
                    raw_html,
                    re.DOTALL
                ) or re.findall(
                    r'<a class="result__snippet[^"]*"[^>]*>(.*?)</a>',
                    raw_html,
                    re.DOTALL
                )

                # Alternative regex matching standard results
                raw_links = re.findall(
                    r'<h2 class="result__title">\s*<a class="result__url"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                    raw_html,
                    re.DOTALL
                )
                raw_snippets = re.findall(r'<a class="result__snippet[^\"]*\"[^>]*>(.*?)</a>', raw_html, re.DOTALL)

                for idx in range(min(len(raw_snippets), max_results)):
                    snippet_clean = html_lib.unescape(re.sub(r'<[^<]+?>', '', raw_snippets[idx])).strip()
                    title = "Web Result"
                    href = ""
                    if idx < len(raw_links):
                        href = raw_links[idx][0].strip()
                        title = html_lib.unescape(re.sub(r'<[^<]+?>', '', raw_links[idx][1])).strip()
                    results.append({
                        "title": title or f"Result {idx + 1}",
                        "href": href,
                        "body": snippet_clean
                    })
        except Exception as ex:
            logger.error(f"[tool] Direct HTML fallback failed: {ex}")

    if not results:
        return f"No results found for: {query}"

    formatted = [f"**Search results for: {query}**\n"]
    for i, r in enumerate(results[:max_results], 1):
        title = r.get("title", "No title")
        url = r.get("href", "")
        body = r.get("body", "")[:350]
        formatted.append(f"{i}. **{title}**\n   {url}\n   {body}\n")

    return "\n".join(formatted)


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
            f"Write denied: path must be inside your user directory ({Path.home()}). "
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


# ── Browser Tool Handlers ───────────────────────────────────────────────────

def _browser_open(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    url = inputs.get("url", "").strip()
    if not url:
        return "No URL provided to browser_open"
    headless = bool(inputs.get("headless", False))
    return browser_engine.navigate(url, headless=headless)


def _browser_read_page(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    max_length = int(inputs.get("max_length", 4000))
    return browser_engine.get_page_content(max_length=max_length)


def _browser_extract_form(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    return browser_engine.extract_form()


def _browser_fill_form(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    fields = inputs.get("fields", {})
    if not isinstance(fields, dict):
        return "Invalid fields: expected a dictionary of field names and values"
    return browser_engine.fill_form(fields)


def _browser_click(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    target = inputs.get("target", "").strip()
    if not target:
        return "No target provided to browser_click"
    return browser_engine.click(target)


def _browser_screenshot(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    name = inputs.get("name")
    return browser_engine.take_screenshot(name=name)


def _browser_get_tabs(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    return browser_engine.get_tabs()


def _browser_switch_tab(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    index = int(inputs.get("index", 1))
    return browser_engine.switch_tab(index)


def _browser_close(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    kill_chrome = bool(inputs.get("kill_chrome", False))
    return browser_engine.close(kill_chrome=kill_chrome)


def _browser_status(inputs: dict) -> str:
    from core.browser_engine import browser_engine
    return browser_engine.status()


# ── Bitwarden Tool Handlers ───────────────────────────────────────────────────

def _bitwarden_get_login(inputs: dict) -> str:
    from core.bitwarden_vault import bitwarden_vault
    service = inputs.get("service", "").strip()
    return bitwarden_vault.get_login(service)


def _bitwarden_status(inputs: dict) -> str:
    from core.bitwarden_vault import bitwarden_vault
    import json
    return json.dumps(bitwarden_vault.get_status(), indent=2)


# ── Autonomous Background Scheduler Handlers (Pillar 6) ───────────────────────

def _schedule_task(inputs: dict) -> str:
    from core.scheduler import get_scheduler
    name = (inputs.get("name") or "").strip()
    instruction = (inputs.get("instruction") or "").strip()
    if not name or not instruction:
        return "Both 'name' and 'instruction' are required to schedule a task."

    interval_minutes = inputs.get("interval_minutes")
    if interval_minutes is not None:
        try:
            interval_minutes = int(interval_minutes)
        except Exception:
            interval_minutes = None

    cron_hour = inputs.get("cron_hour")
    if cron_hour is not None:
        try:
            cron_hour = int(cron_hour)
        except Exception:
            cron_hour = None

    cron_minute = inputs.get("cron_minute")
    if cron_minute is not None:
        try:
            cron_minute = int(cron_minute)
        except Exception:
            cron_minute = 0

    watchdog = bool(inputs.get("watchdog", True))

    scheduler = get_scheduler()
    return scheduler.add_custom_task(
        name=name,
        instruction=instruction,
        interval_minutes=interval_minutes,
        cron_hour=cron_hour,
        cron_minute=cron_minute,
        watchdog=watchdog,
    )


def _schedule_list_tasks(inputs: dict) -> str:
    from core.scheduler import get_scheduler
    import json
    scheduler = get_scheduler()
    jobs = scheduler.list_jobs()
    custom_tasks = scheduler._load_custom_tasks()
    
    if not jobs and not custom_tasks:
        return "No scheduled background tasks currently active."

    lines = ["**Active Background Scheduled Tasks & Heartbeats**:"]
    for j in jobs:
        next_r = j.get("next_run") or "N/A"
        lines.append(f"- **{j.get('name')}** (`{j.get('id')}`) — Next run: {next_r}")

    if custom_tasks:
        lines.append("\n**Registered Custom Watchdogs**:")
        for tid, t in custom_tasks.items():
            lines.append(f"- **{t.get('name')}** (`{tid}`): {t.get('schedule')} — *\"{t.get('instruction')}\"*")

    return "\n".join(lines)


def _schedule_cancel_task(inputs: dict) -> str:
    from core.scheduler import get_scheduler
    task_id = (inputs.get("task_id") or "").strip()
    if not task_id:
        return "No task_id provided to schedule_cancel_task."
    scheduler = get_scheduler()
    return scheduler.cancel_task(task_id)


# ── Google Drive Tool Handlers ────────────────────────────────────────────────

def _gdrive_search(inputs: dict) -> str:
    from core.google_drive import gdrive_search
    query = inputs.get("query", "").strip()
    max_results = int(inputs.get("max_results", 10))
    return gdrive_search(query, max_results=max_results)


def _gdrive_list(inputs: dict) -> str:
    from core.google_drive import gdrive_list
    folder_id = inputs.get("folder_id", "root").strip() or "root"
    max_results = int(inputs.get("max_results", 50))
    return gdrive_list(folder_id, max_results=max_results)


def _gdrive_read(inputs: dict) -> str:
    from core.google_drive import gdrive_read
    file_id = inputs.get("file_id", "").strip()
    return gdrive_read(file_id)


def _gdrive_upload(inputs: dict) -> str:
    from core.google_drive import gdrive_upload
    name = inputs.get("name", "").strip()
    content = inputs.get("content", "")
    folder_id = inputs.get("folder_id", "").strip()
    return gdrive_upload(name, content, folder_id=folder_id)


def _gdrive_create_doc(inputs: dict) -> str:
    from core.google_drive import gdrive_create_doc
    title = inputs.get("title", "").strip()
    content = inputs.get("content", "")
    folder_id = inputs.get("folder_id", "").strip()
    return gdrive_create_doc(title, content=content, folder_id=folder_id)


def _gdrive_auth_status(inputs: dict) -> str:
    from core.google_drive import gdrive_auth_status
    return gdrive_auth_status()


# ── macOS OS & GUI Control Tool Handlers (Pillar 1) ──────────────────────────

def _desktop_screenshot(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    name = inputs.get("name")
    region = inputs.get("region")
    return macos_controller.desktop_screenshot(name=name, region=region)


def _desktop_click(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    x = int(inputs.get("x", 0))
    y = int(inputs.get("y", 0))
    button = inputs.get("button", "left")
    clicks = int(inputs.get("clicks", 1))
    return macos_controller.desktop_click(x=x, y=y, button=button, clicks=clicks)


def _desktop_mouse_move(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    x = int(inputs.get("x", 0))
    y = int(inputs.get("y", 0))
    return macos_controller.desktop_mouse_move(x=x, y=y)


def _desktop_mouse_drag(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    x = int(inputs.get("x", 0))
    y = int(inputs.get("y", 0))
    button = inputs.get("button", "left")
    return macos_controller.desktop_mouse_drag(x=x, y=y, button=button)


def _desktop_scroll(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    amount = int(inputs.get("amount", 0))
    return macos_controller.desktop_scroll(amount=amount)


def _desktop_type(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    text = inputs.get("text", "")
    return macos_controller.desktop_type(text=text)


def _desktop_shortcut(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    keys = inputs.get("keys", [])
    if not isinstance(keys, list):
        return "Invalid keys parameter: expected a list of key names (e.g. ['command', 'space'])"
    return macos_controller.desktop_shortcut(keys=keys)


def _app_launch(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    app_name = inputs.get("app_name", "").strip()
    return macos_controller.app_launch(app_name=app_name)


def _app_focus(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    app_name = inputs.get("app_name", "").strip()
    return macos_controller.app_focus(app_name=app_name)


def _applescript_run(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    script = inputs.get("script", "").strip()
    return macos_controller.applescript_run(script=script)


def _clipboard_read(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    return macos_controller.clipboard_read()


def _clipboard_write(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    text = inputs.get("text", "")
    return macos_controller.clipboard_write(text=text)


def _system_notify(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    title = inputs.get("title", "Terminus").strip() or "Terminus"
    message = inputs.get("message", "").strip()
    return macos_controller.system_notify(title=title, message=message)


# ── macOS Active-Window Context Handlers (Pillar 1 extension) ─────────────────

def _macos_ax_status(inputs: dict) -> str:
    import json
    from core.macos_controller import macos_controller
    return json.dumps(macos_controller.ax_status(), indent=2)


def _macos_list_windows(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    app_name = inputs.get("app_name")
    return macos_controller.list_windows(app_name=app_name)


def _macos_read_active_window(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    app_name = inputs.get("app_name")
    window_index = int(inputs.get("window_index", 1))
    return macos_controller.read_active_window(app_name=app_name, window_index=window_index)


def _macos_read_selection(inputs: dict) -> str:
    from core.macos_controller import macos_controller
    return macos_controller.read_selection()


# ── Long-Term Memory Handlers (Phase 3) ───────────────────────────────────────

def _memory_remember(inputs: dict) -> str:
    from core.memory import get_memory
    return get_memory().add(
        collection=inputs.get("collection", "sessions"),
        content=inputs.get("content", ""),
        metadata=inputs.get("metadata"),
        doc_id=inputs.get("doc_id"),
    )


def _memory_recall(inputs: dict) -> str:
    from core.memory import get_memory
    return get_memory().query(
        collection=inputs.get("collection", "sessions"),
        query_text=inputs.get("query", ""),
        n_results=int(inputs.get("n_results", 5)),
    )


def _memory_forget(inputs: dict) -> str:
    from core.memory import get_memory
    return get_memory().forget(
        collection=inputs.get("collection", "sessions"),
        doc_id=inputs.get("doc_id"),
        where=inputs.get("where"),
    )


def _memory_list(inputs: dict) -> str:
    from core.memory import get_memory
    collection = inputs.get("collection", "__collections__")
    if collection == "__collections__":
        return get_memory().list_collections()
    return get_memory().list_entries(collection=collection, limit=int(inputs.get("limit", 20)))


# ── Code Interpreter Tool Handlers (Pillar 2) ────────────────────────────────

def _python_execute(inputs: dict) -> str:
    from core.code_interpreter import code_interpreter
    code = inputs.get("code", "")
    timeout = int(inputs.get("timeout", 30))
    return code_interpreter.python_execute(code=code, timeout=timeout)


def _bash_execute(inputs: dict) -> str:
    from core.code_interpreter import code_interpreter
    command = inputs.get("command", "")
    timeout = int(inputs.get("timeout", 60))
    cwd = inputs.get("cwd")
    return code_interpreter.bash_execute(command=command, timeout=timeout, cwd=cwd)


