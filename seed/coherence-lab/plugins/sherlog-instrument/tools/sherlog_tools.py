import json
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "SL"
AVAILABLE_FUNCTIONS = [
    "sherlog_preflight",
    "sherlog_verify",
    "sherlog_doctor",
    "sherlog_gaps",
    "sherlog_prompt",
    "sherlog_session_status",
    "sherlog_session_note",
]

MAX_OUTPUT_CHARS = 12000


def _repo_root() -> Path:
    override = os.environ.get("TERMINUS_REPO_ROOT") or os.environ.get("SHERLOG_REPO_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parents[5]


def _run_npm_script(script: str, args=None, timeout=90):
    repo_root = _repo_root()
    if not (repo_root / "package.json").exists():
        return {
            "ok": False,
            "repo_root": str(repo_root),
            "error": "No package.json found at resolved Terminus repo root.",
        }

    command = ["npm", "run", script, "--"]
    if args:
        command.extend(args)

    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return {"ok": False, "repo_root": str(repo_root), "error": "npm was not found on PATH."}
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "repo_root": str(repo_root),
            "script": script,
            "error": f"Sherlog command timed out after {timeout}s.",
            "stdout": (exc.stdout or "")[-MAX_OUTPUT_CHARS:],
            "stderr": (exc.stderr or "")[-MAX_OUTPUT_CHARS:],
        }

    stdout = (completed.stdout or "").strip()
    stderr = (completed.stderr or "").strip()
    return {
        "ok": completed.returncode == 0,
        "repo_root": str(repo_root),
        "script": script,
        "exit_code": completed.returncode,
        "stdout": stdout[-MAX_OUTPUT_CHARS:],
        "stderr": stderr[-MAX_OUTPUT_CHARS:],
    }


def _format_result(result):
    return json.dumps(result, indent=2)


def sherlog_verify():
    return _format_result(_run_npm_script("sherlog:verify", ["--json"], timeout=90))


def sherlog_doctor(feature: str, fast: bool = True):
    script = "sherlog:doctor:fast" if fast else "sherlog:doctor"
    result = _run_npm_script(script, ["--feature", feature or "Terminus", "--json"], timeout=120)
    if not result.get("ok") and fast:
        fallback = _run_npm_script(
            "sherlog:doctor",
            ["--feature", feature or "Terminus", "--json", "--skip-tests"],
            timeout=120,
        )
        fallback["fast_fallback_reason"] = result
        result = fallback
    return _format_result(result)


def sherlog_gaps(feature: str):
    return _format_result(_run_npm_script("sherlog:gaps", ["--feature", feature or "Terminus", "--json"], timeout=120))


def sherlog_prompt(feature: str):
    return _format_result(_run_npm_script("sherlog:prompt", [feature or "Terminus"], timeout=90))


def sherlog_preflight(feature: str):
    verify = _run_npm_script("sherlog:verify", ["--json"], timeout=90)
    doctor = _run_npm_script("sherlog:doctor", ["--feature", feature or "Terminus", "--json"], timeout=120)
    gaps = _run_npm_script("sherlog:gaps", ["--feature", feature or "Terminus", "--json"], timeout=120)
    prompt = _run_npm_script("sherlog:prompt", [feature or "Terminus"], timeout=90)
    return _format_result({"ok": all(item.get("ok") for item in [verify, doctor, gaps, prompt]), "verify": verify, "doctor": doctor, "gaps": gaps, "prompt": prompt})


def sherlog_session_status():
    return _format_result(_run_npm_script("sherlog:session:status", [], timeout=60))


def sherlog_session_note(note: str):
    return _format_result(_run_npm_script("sherlog:session:note", [note or "Terminus noted progress."], timeout=60))


TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_preflight",
            "description": "Run Sherlog verify, doctor, gaps, and prompt for a feature. Use before planning implementation or claiming confidence about repo state.",
            "parameters": {"type": "object", "properties": {"feature": {"type": "string", "description": "Feature or workstream name."}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_verify",
            "description": "Validate Terminus/Sherlog repo wiring and context contracts.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_doctor",
            "description": "Run a feature-scoped Sherlog health check. Use fast mode during iteration and full mode before final handoff.",
            "parameters": {"type": "object", "properties": {"feature": {"type": "string"}, "fast": {"type": "boolean", "description": "Use fast diagnostics when true. Defaults to true."}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_gaps",
            "description": "Return feature-scoped gap evidence from Sherlog.",
            "parameters": {"type": "object", "properties": {"feature": {"type": "string"}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_prompt",
            "description": "Generate a repo-grounded execution brief for the current feature.",
            "parameters": {"type": "object", "properties": {"feature": {"type": "string"}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_session_status",
            "description": "Check whether a Sherlog work session is active.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_session_note",
            "description": "Append a concise progress note to the active Sherlog session.",
            "parameters": {"type": "object", "properties": {"note": {"type": "string"}}, "required": ["note"]},
        },
    },
]


def execute(function_name, arguments, _config):
    try:
        arguments = arguments or {}
        if function_name == "sherlog_preflight":
            return sherlog_preflight(arguments.get("feature", "Terminus")), True
        if function_name == "sherlog_verify":
            return sherlog_verify(), True
        if function_name == "sherlog_doctor":
            return sherlog_doctor(arguments.get("feature", "Terminus"), arguments.get("fast", True)), True
        if function_name == "sherlog_gaps":
            return sherlog_gaps(arguments.get("feature", "Terminus")), True
        if function_name == "sherlog_prompt":
            return sherlog_prompt(arguments.get("feature", "Terminus")), True
        if function_name == "sherlog_session_status":
            return sherlog_session_status(), True
        if function_name == "sherlog_session_note":
            return sherlog_session_note(arguments.get("note", "Terminus noted progress.")), True
        return f"Unknown function '{function_name}'.", False
    except Exception as exc:
        logger.error("[sherlog-instrument] tool error: %s", exc, exc_info=True)
        return f"Error: {exc}", False