import json
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "SL"
AVAILABLE_FUNCTIONS = [
    "sherlog_run",
    "sherlog_preflight",
    "sherlog_verify",
    "sherlog_doctor",
    "sherlog_gaps",
    "sherlog_prompt",
    "sherlog_session_status",
    "sherlog_session_note",
]

MAX_OUTPUT_CHARS = 12000
DEFAULT_SHERLOG_REPO = os.environ.get("SHERLOG_DEFAULT_REPO", "shipyard")
KNOWN_REPOS = {
    "shipyard": "/Users/dancross/Dev/GitHub/Shipyard",
    "sherlog": "/Users/dancross/Dev/GitHub/SHERLOG_starter",
    "terminus": "/Users/dancross/Dev/GitHub/Terminus",
}

ALLOWED_SCRIPT_PREFIXES = ("sherlog:",)
MAX_EXTRA_ARGS = 16


def _repo_root(repo: str = DEFAULT_SHERLOG_REPO) -> Path:
    repo_key = (repo or DEFAULT_SHERLOG_REPO).strip().lower()
    env_name = {
        "shipyard": "SHIPYARD_REPO_ROOT",
        "sherlog": "SHERLOG_STARTER_REPO_ROOT",
        "terminus": "TERMINUS_REPO_ROOT",
    }.get(repo_key)
    override = os.environ.get(env_name or "") or os.environ.get("SHERLOG_REPO_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    if repo_key in KNOWN_REPOS:
        return Path(KNOWN_REPOS[repo_key]).expanduser().resolve()
    raise ValueError("Unknown Sherlog repo. Use 'shipyard', 'sherlog', or 'terminus'.")


def _load_package_scripts(repo_root: Path):
    package_path = repo_root / "package.json"
    if not package_path.exists():
        return None, {
            "ok": False,
            "repo_root": str(repo_root),
            "error": "No package.json found at resolved Sherlog repo root.",
        }
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, {
            "ok": False,
            "repo_root": str(repo_root),
            "error": f"Failed to read package.json: {exc}",
        }
    return package.get("scripts", {}) or {}, None


def _sanitize_args(args):
    if not args:
        return []
    if not isinstance(args, list):
        return [str(args)]
    return [str(item) for item in args[:MAX_EXTRA_ARGS]]


def _run_npm_script(script: str, args=None, timeout=90, repo: str = DEFAULT_SHERLOG_REPO):
    try:
        repo_root = _repo_root(repo)
    except ValueError as exc:
        return {"ok": False, "repo": repo, "error": str(exc)}

    scripts, error = _load_package_scripts(repo_root)
    if error:
        error["repo"] = repo
        return error

    if not any(script.startswith(prefix) for prefix in ALLOWED_SCRIPT_PREFIXES):
        return {
            "ok": False,
            "repo": repo,
            "repo_root": str(repo_root),
            "script": script,
            "error": "Only sherlog:* npm scripts are allowed.",
        }

    if script not in scripts:
        return {
            "ok": False,
            "repo": repo,
            "repo_root": str(repo_root),
            "script": script,
            "error": f"Script '{script}' is not defined in package.json.",
            "available_sherlog_scripts": sorted(name for name in scripts if name.startswith("sherlog:")),
        }

    command = ["npm", "run", script, "--"]
    if args:
        command.extend(_sanitize_args(args))

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
        "repo": repo,
        "repo_root": str(repo_root),
        "script": script,
        "exit_code": completed.returncode,
        "stdout": stdout[-MAX_OUTPUT_CHARS:],
        "stderr": stderr[-MAX_OUTPUT_CHARS:],
    }


def _format_result(result):
    return json.dumps(result, indent=2)


def sherlog_run(script: str, args=None, repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script(script or "sherlog:verify", args or [], timeout=180, repo=repo))


def sherlog_verify(repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script("sherlog:verify", ["--json"], timeout=90, repo=repo))


def sherlog_doctor(feature: str, fast: bool = True, repo: str = DEFAULT_SHERLOG_REPO):
    script = "sherlog:doctor:fast" if fast else "sherlog:doctor"
    result = _run_npm_script(script, ["--feature", feature or "Current Task", "--json"], timeout=120, repo=repo)
    if not result.get("ok") and fast:
        fallback = _run_npm_script(
            "sherlog:doctor",
            ["--feature", feature or "Current Task", "--json", "--skip-tests"],
            timeout=120,
            repo=repo,
        )
        fallback["fast_fallback_reason"] = result
        result = fallback
    return _format_result(result)


def sherlog_gaps(feature: str, repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script("sherlog:gaps", ["--feature", feature or "Current Task", "--json"], timeout=120, repo=repo))


def sherlog_prompt(feature: str, repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script("sherlog:prompt", [feature or "Current Task"], timeout=90, repo=repo))


def sherlog_preflight(feature: str, repo: str = DEFAULT_SHERLOG_REPO):
    verify = _run_npm_script("sherlog:verify", ["--json"], timeout=90, repo=repo)
    doctor = _run_npm_script("sherlog:doctor", ["--feature", feature or "Current Task", "--json"], timeout=120, repo=repo)
    gaps = _run_npm_script("sherlog:gaps", ["--feature", feature or "Current Task", "--json"], timeout=120, repo=repo)
    prompt = _run_npm_script("sherlog:prompt", [feature or "Current Task"], timeout=90, repo=repo)
    return _format_result({"ok": all(item.get("ok") for item in [verify, doctor, gaps, prompt]), "verify": verify, "doctor": doctor, "gaps": gaps, "prompt": prompt})


def sherlog_session_status(repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script("sherlog:session:status", [], timeout=60, repo=repo))


def sherlog_session_note(note: str, repo: str = DEFAULT_SHERLOG_REPO):
    return _format_result(_run_npm_script("sherlog:session:note", [note or "Terminus noted progress."], timeout=60, repo=repo))


TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_run",
            "description": "Run an allowlisted Sherlog npm script in an allowed repo. Use for specific Sherlog commands not covered by the convenience tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo whose package.json defines the Sherlog script. Defaults to shipyard."},
                    "script": {"type": "string", "description": "Sherlog npm script name, such as sherlog:verify or sherlog:contracts."},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "Optional arguments passed after npm run <script> -- ."},
                },
                "required": ["script"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_preflight",
            "description": "Run Sherlog verify, doctor, gaps, and prompt for a feature. Defaults to Shipyard. Use before planning implementation or claiming confidence about repo state.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}, "feature": {"type": "string", "description": "Feature or workstream name."}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_verify",
            "description": "Validate Sherlog repo wiring and context contracts. Defaults to Shipyard.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}}, "required": []},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_doctor",
            "description": "Run a feature-scoped Sherlog health check. Use fast mode during iteration and full mode before final handoff.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}, "feature": {"type": "string"}, "fast": {"type": "boolean", "description": "Use fast diagnostics when true. Defaults to true."}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_gaps",
            "description": "Return feature-scoped gap evidence from Sherlog.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}, "feature": {"type": "string"}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_prompt",
            "description": "Generate a repo-grounded execution brief for the current feature.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}, "feature": {"type": "string"}}, "required": ["feature"]},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_session_status",
            "description": "Check whether a Sherlog work session is active.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}}, "required": []},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "sherlog_session_note",
            "description": "Append a concise progress note to the active Sherlog session.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": ["shipyard", "sherlog", "terminus"], "description": "Repo to run Sherlog in. Defaults to shipyard."}, "note": {"type": "string"}}, "required": ["note"]},
        },
    },
]


def execute(function_name, arguments, _config):
    try:
        arguments = arguments or {}
        repo = arguments.get("repo", DEFAULT_SHERLOG_REPO)
        if function_name == "sherlog_run":
            return sherlog_run(arguments.get("script", "sherlog:verify"), arguments.get("args", []), repo), True
        if function_name == "sherlog_preflight":
            return sherlog_preflight(arguments.get("feature", "Current Task"), repo), True
        if function_name == "sherlog_verify":
            return sherlog_verify(repo), True
        if function_name == "sherlog_doctor":
            return sherlog_doctor(arguments.get("feature", "Current Task"), arguments.get("fast", True), repo), True
        if function_name == "sherlog_gaps":
            return sherlog_gaps(arguments.get("feature", "Current Task"), repo), True
        if function_name == "sherlog_prompt":
            return sherlog_prompt(arguments.get("feature", "Current Task"), repo), True
        if function_name == "sherlog_session_status":
            return sherlog_session_status(repo), True
        if function_name == "sherlog_session_note":
            return sherlog_session_note(arguments.get("note", "Terminus noted progress."), repo), True
        return f"Unknown function '{function_name}'.", False
    except Exception as exc:
        logger.error("[sherlog-instrument] tool error: %s", exc, exc_info=True)
        return f"Error: {exc}", False
