# seed/coherence-lab/capability_watcher.py
# Gives Terminus the ability to detect changes in its own capabilities
# (toolsets and loaded function modules) by comparing against a saved snapshot.
#
# Two tools are exposed:
#   read_capability_diff      — compare current capabilities vs last snapshot
#   snapshot_capabilities     — save current state as the new baseline

import ast
import json
import logging
import os
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "🔭"

AVAILABLE_FUNCTIONS = [
    "read_capability_diff",
    "snapshot_capabilities",
]

TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "read_capability_diff",
            "description": (
                "Compare your current active capabilities (toolsets and function modules) "
                "against the last saved capability snapshot. Returns what was added, removed, "
                "or changed since the baseline was taken. Use this to detect when your functions "
                "have been upgraded or modified. If no snapshot exists yet, the current profile "
                "is returned in full and saved automatically as the initial baseline."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "snapshot_capabilities",
            "description": (
                "Save the current capability profile as the new baseline for future comparisons. "
                "Call this after reviewing a capability diff to acknowledge the changes and reset "
                "the comparison point. Returns a summary of what was saved."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _user_dir() -> Path:
    override = os.environ.get("TERMINUS_USER_DIR")
    if override:
        return Path(override)
    # In Sapphire deployment this file lives at {user_dir}/functions/capability_watcher.py
    # so parent.parent == {user_dir}.
    # In the repo it lives at seed/coherence-lab/capability_watcher.py; the fallback
    # still produces a usable path for snapshot storage.
    return Path(__file__).parent.parent


def _snapshot_path() -> Path:
    return _user_dir() / "continuity" / "capability_snapshot.json"


def _find_toolset_files() -> list:
    """Return paths to every toolsets.json this module can locate."""
    candidates = []

    env_paths = os.environ.get("TERMINUS_TOOLSETS_PATHS", "")
    if env_paths:
        for p in env_paths.split(os.pathsep):
            path = Path(p.strip())
            if path.exists():
                candidates.append(path)

    here = Path(__file__).parent
    guesses = [
        here / "toolsets" / "toolsets.json",
        here.parent / "sapphire-data" / "toolsets" / "toolsets.json",
        here.parent / "toolsets" / "toolsets.json",
    ]
    for guess in guesses:
        if guess.exists() and guess not in candidates:
            candidates.append(guess)

    return candidates


# ---------------------------------------------------------------------------
# State collection
# ---------------------------------------------------------------------------

def _collect_toolsets() -> dict:
    """Read all discoverable toolsets.json files and return merged toolset map."""
    combined = {}
    for path in _find_toolset_files():
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            for key, value in data.items():
                if key.startswith("_"):
                    continue
                funcs = sorted(value.get("functions", [])) if isinstance(value, dict) else []
                if key in combined:
                    merged = sorted(set(combined[key]) | set(funcs))
                    combined[key] = merged
                else:
                    combined[key] = funcs
        except Exception as exc:
            logger.warning(f"[capability_watcher] Could not read {path}: {exc}")
    return combined


def _collect_modules() -> dict:
    """Scan nearby Python files for modules that declare AVAILABLE_FUNCTIONS."""
    modules = {}

    here = Path(__file__).parent
    search_dirs = [here]

    plugins_dir = here / "plugins"
    if plugins_dir.exists():
        for plugin_dir in plugins_dir.iterdir():
            if plugin_dir.is_dir():
                tools_dir = plugin_dir / "tools"
                if tools_dir.exists():
                    search_dirs.append(tools_dir)

    for search_dir in search_dirs:
        for py_file in sorted(search_dir.glob("*.py")):
            if py_file.name.startswith("_"):
                continue
            try:
                text = py_file.read_text(encoding="utf-8")
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Assign):
                        continue
                    for target in node.targets:
                        if not (isinstance(target, ast.Name) and target.id == "AVAILABLE_FUNCTIONS"):
                            continue
                        if not isinstance(node.value, ast.List):
                            continue
                        funcs = [
                            elt.value
                            for elt in node.value.elts
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                        ]
                        if funcs:
                            modules[py_file.stem] = sorted(funcs)
            except Exception as exc:
                logger.debug(f"[capability_watcher] Could not parse {py_file}: {exc}")

    return modules


def _build_profile() -> dict:
    return {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "toolsets": _collect_toolsets(),
        "modules": _collect_modules(),
    }


# ---------------------------------------------------------------------------
# Snapshot I/O
# ---------------------------------------------------------------------------

def _load_snapshot() -> dict:
    path = _snapshot_path()
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        logger.warning(f"[capability_watcher] Could not read snapshot: {exc}")
        return {}


def _save_snapshot(profile: dict) -> None:
    path = _snapshot_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(profile, fh, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Diff logic
# ---------------------------------------------------------------------------

def _diff_string_lists(label: str, old: list, new: list) -> list:
    """Return human-readable diff lines for a named list of strings."""
    old_set, new_set = set(old), set(new)
    added = sorted(new_set - old_set)
    removed = sorted(old_set - new_set)
    lines = []
    if added:
        lines.append(f"  + {', '.join(added)}")
    if removed:
        lines.append(f"  - {', '.join(removed)}")
    return lines


def _build_diff_report(old: dict, new: dict) -> str:
    now_ts = new["timestamp"]
    old_ts = old.get("timestamp", "unknown")

    old_toolsets = old.get("toolsets", {})
    new_toolsets = new.get("toolsets", {})
    old_modules = old.get("modules", {})
    new_modules = new.get("modules", {})

    toolset_sections = []
    all_toolset_keys = sorted(set(old_toolsets) | set(new_toolsets))
    for ts_name in all_toolset_keys:
        old_funcs = old_toolsets.get(ts_name, [])
        new_funcs = new_toolsets.get(ts_name, [])
        if ts_name not in old_toolsets:
            toolset_sections.append(f"**{ts_name}** [NEW TOOLSET] — {len(new_funcs)} functions")
        elif ts_name not in new_toolsets:
            toolset_sections.append(f"**{ts_name}** [REMOVED]")
        else:
            diff_lines = _diff_string_lists(ts_name, old_funcs, new_funcs)
            if diff_lines:
                added_count = len(set(new_funcs) - set(old_funcs))
                removed_count = len(set(old_funcs) - set(new_funcs))
                parts = []
                if added_count:
                    parts.append(f"+{added_count} added")
                if removed_count:
                    parts.append(f"-{removed_count} removed")
                toolset_sections.append(f"**{ts_name}** ({', '.join(parts)}):\n" + "\n".join(diff_lines))

    module_sections = []
    all_module_keys = sorted(set(old_modules) | set(new_modules))
    for mod_name in all_module_keys:
        old_funcs = old_modules.get(mod_name, [])
        new_funcs = new_modules.get(mod_name, [])
        if mod_name not in old_modules:
            module_sections.append(
                f"**{mod_name}** [NEW MODULE] — functions: {', '.join(new_funcs)}"
            )
        elif mod_name not in new_modules:
            module_sections.append(f"**{mod_name}** [REMOVED]")
        else:
            diff_lines = _diff_string_lists(mod_name, old_funcs, new_funcs)
            if diff_lines:
                module_sections.append(f"**{mod_name}**:\n" + "\n".join(diff_lines))

    if not toolset_sections and not module_sections:
        toolset_names = ", ".join(sorted(new_toolsets.keys())) or "none"
        module_names = ", ".join(sorted(new_modules.keys())) or "none"
        return (
            f"# Capability Report — {now_ts}\n\n"
            f"No capability changes detected since baseline ({old_ts}).\n\n"
            f"Toolsets tracked: {toolset_names}\n"
            f"Modules tracked: {module_names}"
        )

    lines = [f"# Capability Report — {now_ts}", f"", f"Baseline: {old_ts}", f""]

    if toolset_sections:
        lines.append("## Toolset Changes")
        lines.append("")
        lines.extend(toolset_sections)
        lines.append("")

    if module_sections:
        lines.append("## Function Module Changes")
        lines.append("")
        lines.extend(module_sections)
        lines.append("")

    lines.append(
        "Call `snapshot_capabilities()` to acknowledge these changes and update the baseline."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def read_capability_diff() -> str:
    current = _build_profile()
    baseline = _load_snapshot()

    if not baseline:
        _save_snapshot(current)
        toolset_names = ", ".join(sorted(current["toolsets"].keys())) or "none"
        module_names = ", ".join(sorted(current["modules"].keys())) or "none"
        return (
            f"# Capability Baseline Established — {current['timestamp']}\n\n"
            f"No prior snapshot existed. Current profile saved as baseline.\n\n"
            f"Toolsets: {toolset_names}\n"
            f"Modules: {module_names}"
        )

    return _build_diff_report(baseline, current)


def snapshot_capabilities() -> str:
    profile = _build_profile()
    _save_snapshot(profile)
    toolset_names = ", ".join(sorted(profile["toolsets"].keys())) or "none"
    module_names = ", ".join(sorted(profile["modules"].keys())) or "none"
    return (
        f"Capability snapshot saved — {profile['timestamp']}.\n"
        f"Tracking toolsets: {toolset_names}\n"
        f"Tracking modules: {module_names}"
    )


# ---------------------------------------------------------------------------
# Dispatcher (required by Sapphire's FunctionManager)
# ---------------------------------------------------------------------------

def execute(function_name, arguments, config):
    """Dispatcher required by Sapphire's FunctionManager.

    Args:
        function_name: Name of the function to execute.
        arguments: Dict of keyword arguments from the LLM call.
        config: Runtime config object passed by Sapphire (unused here).

    Returns:
        Tuple of (result_string, success_bool).
    """
    try:
        if function_name == "read_capability_diff":
            return read_capability_diff(), True
        elif function_name == "snapshot_capabilities":
            return snapshot_capabilities(), True
        else:
            return f"Unknown function: {function_name}", False
    except Exception as exc:
        logger.error(f"[capability_watcher] {function_name} failed: {exc}", exc_info=True)
        return f"Error: {exc}", False
