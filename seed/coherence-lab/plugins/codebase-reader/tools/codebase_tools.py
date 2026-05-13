import json
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = "CB"
AVAILABLE_FUNCTIONS = [
    "repo_tree",
    "repo_search",
    "ripgrep_search",
    "repo_read_file",
    "repo_write_file",
    "repo_append_file",
    "notebook_read",
    "notebook_validate",
    "notebook_create",
    "notebook_update_cell",
    "notebook_append_cell",
    "repo_git_status",
    "repo_git_diff",
]

MAX_READ_CHARS = 24000
MAX_SEARCH_RESULTS = 80
MAX_TREE_ENTRIES = 500
MAX_DIFF_CHARS = 24000
MAX_WRITE_CHARS = 120000

DEFAULT_REPO = "terminus"
KNOWN_REPOS = {
    "terminus": "/Users/dancross/Dev/GitHub/Terminus",
    "shipyard": "/Users/dancross/Dev/GitHub/Shipyard",
    "terminus_rpg": "/Users/dancross/Dev/GitHub/Terminus RPG",
    "raven_corpus": "/Users/dancross/Dev/GitHub/RavenCalder_Corpus",
}
WRITABLE_REPOS = {"raven_corpus", "terminus_rpg"}
REPO_ENUM = ["terminus", "shipyard", "terminus_rpg", "raven_corpus"]
WRITABLE_REPO_ENUM = ["terminus_rpg", "raven_corpus"]
WRITABLE_REPO_DESCRIPTION = "Writable repository. Use terminus_rpg or raven_corpus."

EXCLUDED_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".task",
    ".venv",
    ".vercel",
    "__pycache__",
    "node_modules",
    "sapphire-backups",
}

SENSITIVE_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".vercel_env_ls.txt",
    "cookies.txt",
    "key.pem",
    "cert.pem",
}

SENSITIVE_NAME_FRAGMENTS = {
    "api_key",
    "api-key",
    "apikey",
    "auth_token",
    "claudeapi=",
    "secret",
    "sk-",
    "token",
}

BLOCKED_SUFFIXES = {
    ".7z",
    ".db",
    ".db-shm",
    ".db-wal",
    ".DS_Store",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".log",
    ".mp3",
    ".mp4",
    ".pdf",
    ".pem",
    ".png",
    ".pyc",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".tgz",
    ".webm",
    ".webp",
    ".zip",
}


def _json(payload):
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _terminus_repo_root() -> Path:
    override = os.environ.get("TERMINUS_REPO_ROOT") or os.environ.get("TERMINUS_CODEBASE_ROOT")
    if override:
        return Path(override).expanduser().resolve()

    current = Path(__file__).resolve()
    for candidate in [current.parent, *current.parents]:
        if (candidate / "AGENTS.md").exists() and (candidate / "package.json").exists():
            return candidate
        env_path_file = candidate / ".env.path"
        if env_path_file.exists():
            try:
                env_path = Path(env_path_file.read_text(encoding="utf-8").strip()).expanduser()
                repo_candidate = env_path.parent if env_path.name == ".env" else env_path
                if (repo_candidate / "AGENTS.md").exists() and (repo_candidate / "package.json").exists():
                    return repo_candidate.resolve()
            except OSError:
                pass
    known_local_repo = Path("/Users/dancross/Dev/GitHub/Terminus")
    if (known_local_repo / "AGENTS.md").exists() and (known_local_repo / "package.json").exists():
        return known_local_repo.resolve()
    return current.parents[5]


def _repo_root(repo: str = DEFAULT_REPO) -> Path:
    repo_key = (repo or DEFAULT_REPO).strip().lower()
    if repo_key == "terminus":
        return _terminus_repo_root()
    if repo_key == "shipyard":
        override = os.environ.get("SHIPYARD_REPO_ROOT")
        candidate = Path(override).expanduser() if override else Path(KNOWN_REPOS["shipyard"])
        candidate = candidate.resolve()
        repo_markers = ("README.md", "package.json", ".git")
        if candidate.exists() and candidate.is_dir() and any((candidate / marker).exists() for marker in repo_markers):
            return candidate
        raise ValueError("Shipyard repository root is not available.")
    if repo_key == "terminus_rpg":
        override = os.environ.get("TERMINUS_RPG_REPO_ROOT")
        candidate = Path(override).expanduser() if override else Path(KNOWN_REPOS["terminus_rpg"])
        candidate = candidate.resolve()
        if candidate.exists() and candidate.is_dir():
            return candidate
        raise ValueError("Terminus RPG repository root is not available.")
    if repo_key == "raven_corpus":
        override = os.environ.get("RAVEN_CALDER_CORPUS_ROOT") or os.environ.get("RAVEN_CORPUS_ROOT")
        candidate = Path(override).expanduser() if override else Path(KNOWN_REPOS["raven_corpus"])
        candidate = candidate.resolve()
        if candidate.exists() and candidate.is_dir():
            return candidate
        raise ValueError("Raven Calder corpus root is not available.")
    raise ValueError("Unknown repo. Use 'terminus', 'shipyard', 'terminus_rpg', or 'raven_corpus'.")


def _is_excluded_path(path: Path) -> bool:
    parts = set(path.parts)
    if parts.intersection(EXCLUDED_DIRS):
        return True
    if path.name in SENSITIVE_NAMES:
        return True
    lower_name = path.name.lower()
    if any(fragment in lower_name for fragment in SENSITIVE_NAME_FRAGMENTS):
        return True
    return any(lower_name.endswith(suffix.lower()) for suffix in BLOCKED_SUFFIXES)


def _resolve_repo_path(path_value: str = "", repo: str = DEFAULT_REPO) -> Path:
    repo_root = _repo_root(repo)
    raw = (path_value or "").strip()
    candidate = repo_root if not raw else (repo_root / raw)
    resolved = candidate.expanduser().resolve()

    try:
        resolved.relative_to(repo_root)
    except ValueError:
        raise ValueError(f"Path is outside the {repo or DEFAULT_REPO} repository root.")

    if _is_excluded_path(resolved):
        raise ValueError("Path is excluded from Terminus codebase-reader access.")
    return resolved


def _relative(path: Path, repo: str = DEFAULT_REPO) -> str:
    return str(path.relative_to(_repo_root(repo)))


def _safe_limit(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def _rg_exclude_args():
    args = []
    for directory in sorted(EXCLUDED_DIRS):
        args.extend(["--glob", f"!**/{directory}/**"])
    for name in sorted(SENSITIVE_NAMES):
        args.extend(["--glob", f"!**/{name}"])
    for suffix in sorted(BLOCKED_SUFFIXES):
        args.extend(["--glob", f"!**/*{suffix}"])
    return args


def _run(command, repo: str = DEFAULT_REPO, timeout=20):
    completed = subprocess.run(
        command,
        cwd=_repo_root(repo),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    return completed


def repo_tree(path: str = "", max_entries: int = 200, include_hidden: bool = False, repo: str = DEFAULT_REPO):
    try:
        root = _resolve_repo_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    max_entries = _safe_limit(max_entries, 200, 1, MAX_TREE_ENTRIES)
    if not root.exists():
        return _json({"ok": False, "error": "Path does not exist.", "path": path})

    entries = []
    if root.is_file():
        return _json({"ok": True, "repo": repo, "repo_root": str(_repo_root(repo)), "entries": [_relative(root, repo)]})

    for current, dirnames, filenames in os.walk(root):
        current_path = Path(current)
        dirnames[:] = sorted(
            name
            for name in dirnames
            if (include_hidden or not name.startswith("."))
            and not _is_excluded_path(current_path / name)
        )
        filenames = sorted(
            name
            for name in filenames
            if (include_hidden or not name.startswith("."))
            and not _is_excluded_path(current_path / name)
        )

        for dirname in dirnames:
            entries.append(_relative(current_path / dirname, repo) + "/")
            if len(entries) >= max_entries:
                return _json({"ok": True, "repo": repo, "repo_root": str(_repo_root(repo)), "truncated": True, "entries": entries})
        for filename in filenames:
            entries.append(_relative(current_path / filename, repo))
            if len(entries) >= max_entries:
                return _json({"ok": True, "repo": repo, "repo_root": str(_repo_root(repo)), "truncated": True, "entries": entries})

    return _json({"ok": True, "repo": repo, "repo_root": str(_repo_root(repo)), "truncated": False, "entries": entries})


def repo_search(pattern: str, path: str = "", file_glob: str = "", max_results: int = 40, fixed_string: bool = False, repo: str = DEFAULT_REPO):
    return ripgrep_search(
        pattern=pattern,
        path=path,
        file_glob=file_glob,
        max_results=max_results,
        fixed_string=fixed_string,
        repo=repo,
    )


def ripgrep_search(
    pattern: str,
    path: str = "",
    file_glob: str = "",
    max_results: int = 40,
    fixed_string: bool = False,
    case_sensitive: bool = False,
    word_regexp: bool = False,
    context_lines: int = 0,
    files_with_matches: bool = False,
    repo: str = DEFAULT_REPO,
):
    if not pattern:
        return _json({"ok": False, "error": "Search pattern is required."})

    try:
        search_root = _resolve_repo_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    max_results = _safe_limit(max_results, 40, 1, MAX_SEARCH_RESULTS)
    context_lines = _safe_limit(context_lines, 0, 0, 5)
    command = [
        "rg",
        "--color",
        "never",
        "--max-count",
        str(max_results),
    ]
    if not files_with_matches:
        command.extend(["--line-number", "--no-heading"])
    else:
        command.append("--files-with-matches")
    if fixed_string:
        command.append("--fixed-strings")
    if not case_sensitive:
        command.append("--ignore-case")
    if word_regexp:
        command.append("--word-regexp")
    if context_lines:
        command.extend(["--context", str(context_lines)])
    if file_glob:
        command.extend(["--glob", file_glob])
    command.extend(_rg_exclude_args())
    command.extend([pattern, str(search_root)])

    try:
        completed = _run(command, repo=repo)
    except FileNotFoundError:
        return _json({"ok": False, "error": "rg was not found on PATH."})
    except subprocess.TimeoutExpired:
        return _json({"ok": False, "error": "Search timed out."})

    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    trimmed = lines[:max_results]
    return _json(
        {
            "ok": completed.returncode in (0, 1),
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "exit_code": completed.returncode,
            "truncated": len(lines) > len(trimmed),
            "command": "rg",
            "matches": trimmed,
            "stderr": completed.stderr.strip()[-2000:],
        }
    )


def repo_read_file(path: str, start_line: int = 1, max_lines: int = 240, repo: str = DEFAULT_REPO):
    try:
        target = _resolve_repo_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    if not target.exists():
        return _json({"ok": False, "error": "File does not exist.", "path": path})
    if not target.is_file():
        return _json({"ok": False, "error": "Path is not a file.", "path": path})
    if _is_excluded_path(target):
        return _json({"ok": False, "error": "File is excluded from codebase-reader access.", "path": path})

    start_line = _safe_limit(start_line, 1, 1, 1_000_000)
    max_lines = _safe_limit(max_lines, 240, 1, 500)
    try:
        raw = target.read_bytes()
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "path": path})

    if b"\x00" in raw[:4096]:
        return _json({"ok": False, "error": "Binary-looking file refused.", "path": path})

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    selected = lines[start_line - 1 : start_line - 1 + max_lines]
    rendered_lines = [f"{line_number}: {line}" for line_number, line in enumerate(selected, start=start_line)]
    content = "\n".join(rendered_lines)
    truncated_by_chars = len(content) > MAX_READ_CHARS
    if truncated_by_chars:
        content = content[:MAX_READ_CHARS]

    return _json(
        {
            "ok": True,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "start_line": start_line,
            "returned_lines": len(selected),
            "total_lines": len(lines),
            "truncated": start_line - 1 + max_lines < len(lines) or truncated_by_chars,
            "content": content,
        }
    )


def _ensure_writable_repo(repo: str):
    repo_key = (repo or DEFAULT_REPO).strip().lower()
    if repo_key not in WRITABLE_REPOS:
        raise ValueError("Write access is only enabled for repo='terminus_rpg' or repo='raven_corpus'.")


def repo_write_file(path: str, content: str, overwrite: bool = False, create_dirs: bool = True, repo: str = DEFAULT_REPO):
    try:
        _ensure_writable_repo(repo)
        target = _resolve_repo_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})

    if not path or not str(path).strip():
        return _json({"ok": False, "error": "A repo-relative file path is required.", "repo": repo})
    if target.exists() and not target.is_file():
        return _json({"ok": False, "error": "Path exists but is not a file.", "repo": repo, "path": path})
    if target.exists() and not overwrite:
        return _json({"ok": False, "error": "File already exists. Set overwrite=true to replace it.", "repo": repo, "path": path})

    text = "" if content is None else str(content)
    if len(text) > MAX_WRITE_CHARS:
        return _json({"ok": False, "error": f"Content exceeds {MAX_WRITE_CHARS} characters.", "repo": repo, "path": path})

    try:
        if create_dirs:
            target.parent.mkdir(parents=True, exist_ok=True)
        elif not target.parent.exists():
            return _json({"ok": False, "error": "Parent directory does not exist.", "repo": repo, "path": path})
        target.write_text(text, encoding="utf-8")
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})

    return _json(
        {
            "ok": True,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "bytes_written": len(text.encode("utf-8")),
            "overwrote": bool(overwrite),
        }
    )


def repo_append_file(path: str, content: str, create_dirs: bool = True, repo: str = DEFAULT_REPO):
    try:
        _ensure_writable_repo(repo)
        target = _resolve_repo_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})

    if not path or not str(path).strip():
        return _json({"ok": False, "error": "A repo-relative file path is required.", "repo": repo})
    if target.exists() and not target.is_file():
        return _json({"ok": False, "error": "Path exists but is not a file.", "repo": repo, "path": path})

    text = "" if content is None else str(content)
    if len(text) > MAX_WRITE_CHARS:
        return _json({"ok": False, "error": f"Content exceeds {MAX_WRITE_CHARS} characters.", "repo": repo, "path": path})

    try:
        if create_dirs:
            target.parent.mkdir(parents=True, exist_ok=True)
        elif not target.parent.exists():
            return _json({"ok": False, "error": "Parent directory does not exist.", "repo": repo, "path": path})
        with target.open("a", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})

    return _json(
        {
            "ok": True,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "bytes_appended": len(text.encode("utf-8")),
        }
    )


def _notebook_path(path: str, repo: str = DEFAULT_REPO) -> Path:
    target = _resolve_repo_path(path, repo)
    if target.suffix.lower() != ".ipynb":
        raise ValueError("Notebook tools only operate on .ipynb files.")
    return target


def _load_notebook(path: str, repo: str = DEFAULT_REPO):
    target = _notebook_path(path, repo)
    if not target.exists():
        raise FileNotFoundError("Notebook file does not exist.")
    if not target.is_file():
        raise ValueError("Notebook path is not a file.")
    try:
        return target, json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Notebook JSON is invalid: {exc}") from exc


def _source_to_text(source) -> str:
    if isinstance(source, list):
        return "".join(str(item) for item in source)
    if source is None:
        return ""
    return str(source)


def _text_to_source(text: str):
    value = "" if text is None else str(text)
    if not value:
        return []
    return [line for line in value.splitlines(keepends=True)]


def _new_notebook_payload(title: str = "", kind: str = "experiment"):
    heading = title.strip() if title else "Untitled Notebook"
    subtitle = "Experiment notebook" if kind == "experiment" else "Tutorial notebook"
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [f"# {heading}\n", "\n", f"{subtitle}.\n"],
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {
                "name": "python",
                "pygments_lexer": "ipython3",
            },
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _validate_notebook_payload(notebook):
    issues = []
    if not isinstance(notebook, dict):
        return ["Notebook root must be a JSON object."]
    if notebook.get("nbformat") != 4:
        issues.append("Expected nbformat 4.")
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        issues.append("Notebook must contain a cells array.")
        return issues
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict):
            issues.append(f"Cell {index} must be an object.")
            continue
        cell_type = cell.get("cell_type")
        if cell_type not in {"markdown", "code", "raw"}:
            issues.append(f"Cell {index} has unsupported cell_type {cell_type!r}.")
        if "source" not in cell:
            issues.append(f"Cell {index} is missing source.")
        if cell_type == "code":
            if "outputs" not in cell:
                issues.append(f"Code cell {index} is missing outputs.")
            if "execution_count" not in cell:
                issues.append(f"Code cell {index} is missing execution_count.")
    return issues


def _write_notebook(target: Path, notebook):
    issues = _validate_notebook_payload(notebook)
    if issues:
        return issues
    target.write_text(json.dumps(notebook, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return []


def notebook_read(path: str, max_cells: int = 80, max_source_chars: int = 5000, include_outputs: bool = False, repo: str = DEFAULT_REPO):
    try:
        target, notebook = _load_notebook(path, repo)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})

    cells = notebook.get("cells", [])
    max_cells = _safe_limit(max_cells, 80, 1, 200)
    max_source_chars = _safe_limit(max_source_chars, 5000, 200, 20000)
    rendered = []
    for index, cell in enumerate(cells[:max_cells]):
        source = _source_to_text(cell.get("source"))
        truncated = len(source) > max_source_chars
        item = {
            "index": index,
            "cell_type": cell.get("cell_type"),
            "source": source[:max_source_chars],
            "source_truncated": truncated,
        }
        if include_outputs and cell.get("cell_type") == "code":
            outputs = cell.get("outputs", [])
            item["execution_count"] = cell.get("execution_count")
            item["outputs"] = [
                {
                    "output_type": output.get("output_type") if isinstance(output, dict) else None,
                    "text": _source_to_text(output.get("text"))[:max_source_chars] if isinstance(output, dict) else "",
                }
                for output in outputs[:10]
                if isinstance(output, dict)
            ]
            item["outputs_truncated"] = len(outputs) > 10
        rendered.append(item)

    return _json(
        {
            "ok": True,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "nbformat": notebook.get("nbformat"),
            "nbformat_minor": notebook.get("nbformat_minor"),
            "total_cells": len(cells),
            "returned_cells": len(rendered),
            "truncated": len(cells) > len(rendered),
            "cells": rendered,
        }
    )


def notebook_validate(path: str, repo: str = DEFAULT_REPO):
    try:
        target, notebook = _load_notebook(path, repo)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    issues = _validate_notebook_payload(notebook)
    return _json(
        {
            "ok": not issues,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "issues": issues,
            "cell_count": len(notebook.get("cells", [])) if isinstance(notebook, dict) else 0,
        }
    )


def notebook_create(path: str, title: str = "", kind: str = "experiment", overwrite: bool = False, repo: str = DEFAULT_REPO):
    try:
        _ensure_writable_repo(repo)
        target = _notebook_path(path, repo)
    except ValueError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    if target.exists() and not overwrite:
        return _json({"ok": False, "error": "Notebook already exists. Set overwrite=true to replace it.", "repo": repo, "path": path})
    kind_value = "tutorial" if str(kind).strip().lower() == "tutorial" else "experiment"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        issues = _write_notebook(target, _new_notebook_payload(title, kind_value))
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    return _json(
        {
            "ok": not issues,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "issues": issues,
        }
    )


def notebook_update_cell(
    path: str,
    cell_index: int,
    source: str,
    cell_type: str = "",
    clear_outputs: bool = True,
    repo: str = DEFAULT_REPO,
):
    try:
        _ensure_writable_repo(repo)
        target, notebook = _load_notebook(path, repo)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    cells = notebook.get("cells", [])
    try:
        index = int(cell_index)
    except (TypeError, ValueError):
        return _json({"ok": False, "error": "cell_index must be an integer.", "repo": repo, "path": path})
    if index < 0 or index >= len(cells):
        return _json({"ok": False, "error": "cell_index is out of range.", "repo": repo, "path": path, "cell_count": len(cells)})

    cell = cells[index]
    next_type = (cell_type or cell.get("cell_type") or "markdown").strip().lower()
    if next_type not in {"markdown", "code", "raw"}:
        return _json({"ok": False, "error": "cell_type must be markdown, code, or raw.", "repo": repo, "path": path})
    cell["cell_type"] = next_type
    cell.setdefault("metadata", {})
    cell["source"] = _text_to_source(source)
    if next_type == "code":
        if clear_outputs:
            cell["outputs"] = []
            cell["execution_count"] = None
        else:
            cell.setdefault("outputs", [])
            cell.setdefault("execution_count", None)
    else:
        cell.pop("outputs", None)
        cell.pop("execution_count", None)

    try:
        issues = _write_notebook(target, notebook)
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    return _json({"ok": not issues, "repo": repo, "repo_root": str(_repo_root(repo)), "path": _relative(target, repo), "cell_index": index, "issues": issues})


def notebook_append_cell(path: str, source: str, cell_type: str = "markdown", clear_outputs: bool = True, repo: str = DEFAULT_REPO):
    try:
        _ensure_writable_repo(repo)
        target, notebook = _load_notebook(path, repo)
    except (ValueError, FileNotFoundError, OSError) as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    next_type = (cell_type or "markdown").strip().lower()
    if next_type not in {"markdown", "code", "raw"}:
        return _json({"ok": False, "error": "cell_type must be markdown, code, or raw.", "repo": repo, "path": path})
    cell = {"cell_type": next_type, "metadata": {}, "source": _text_to_source(source)}
    if next_type == "code":
        cell["outputs"] = []
        cell["execution_count"] = None
    notebook.setdefault("cells", []).append(cell)
    try:
        issues = _write_notebook(target, notebook)
    except OSError as exc:
        return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
    return _json(
        {
            "ok": not issues,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "path": _relative(target, repo),
            "cell_index": len(notebook.get("cells", [])) - 1,
            "issues": issues,
        }
    )


def repo_git_status(repo: str = DEFAULT_REPO):
    try:
        completed = _run(["git", "status", "--short", "--branch"], repo=repo, timeout=10)
    except FileNotFoundError:
        return _json({"ok": False, "error": "git was not found on PATH."})
    except subprocess.TimeoutExpired:
        return _json({"ok": False, "error": "git status timed out."})
    return _json(
        {
            "ok": completed.returncode == 0,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "exit_code": completed.returncode,
            "status": completed.stdout.strip(),
            "stderr": completed.stderr.strip()[-2000:],
        }
    )


def repo_git_diff(path: str = "", max_chars: int = MAX_DIFF_CHARS, repo: str = DEFAULT_REPO):
    command = ["git", "diff", "--"]
    if path:
        try:
            target = _resolve_repo_path(path, repo)
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc), "repo": repo, "path": path})
        command.append(str(target.relative_to(_repo_root(repo))))

    max_chars = _safe_limit(max_chars, MAX_DIFF_CHARS, 1000, MAX_DIFF_CHARS)
    try:
        completed = _run(command, repo=repo, timeout=15)
    except FileNotFoundError:
        return _json({"ok": False, "error": "git was not found on PATH."})
    except subprocess.TimeoutExpired:
        return _json({"ok": False, "error": "git diff timed out."})

    diff = completed.stdout
    truncated = len(diff) > max_chars
    if truncated:
        diff = diff[:max_chars]
    return _json(
        {
            "ok": completed.returncode == 0,
            "repo": repo,
            "repo_root": str(_repo_root(repo)),
            "exit_code": completed.returncode,
            "truncated": truncated,
            "diff": diff,
            "stderr": completed.stderr.strip()[-2000:],
        }
    )


TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_tree",
            "description": "List files and directories in an allowed repository with safety exclusions. Use repo='terminus' for Terminus, repo='shipyard' for Shipyard, repo='terminus_rpg' for the Terminus RPG repo, or repo='raven_corpus' for the Raven Calder corpus.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "path": {"type": "string", "description": "Optional repo-relative directory or file path."},
                    "max_entries": {"type": "integer", "description": "Maximum entries to return, capped at 500."},
                    "include_hidden": {"type": "boolean", "description": "Whether to include hidden files that are not otherwise excluded."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_search",
            "description": "Search an allowed repository using ripgrep with bounded output and safety exclusions. Use repo='shipyard' for Shipyard diagnostics, repo='terminus_rpg' for Terminus RPG source, or repo='raven_corpus' for Raven Calder corpus research.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "pattern": {"type": "string", "description": "Search pattern."},
                    "path": {"type": "string", "description": "Optional repo-relative search path."},
                    "file_glob": {"type": "string", "description": "Optional ripgrep glob, such as *.py or seed/**/*.json."},
                    "max_results": {"type": "integer", "description": "Maximum matches to return, capped at 80."},
                    "fixed_string": {"type": "boolean", "description": "Use literal string matching instead of regex."},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "ripgrep_search",
            "description": "Run bounded ripgrep (`rg`) search over an allowed repository. This is the preferred tool for fast codebase issue discovery in Terminus, Shipyard, or the Terminus RPG repo, and for corpus research in Raven Calder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "pattern": {"type": "string", "description": "Ripgrep regex pattern, or literal text when fixed_string is true."},
                    "path": {"type": "string", "description": "Optional repo-relative search path."},
                    "file_glob": {"type": "string", "description": "Optional ripgrep glob, such as *.ts, *.tsx, or vessel/src/**/*.ts."},
                    "max_results": {"type": "integer", "description": "Maximum output lines to return, capped at 80."},
                    "fixed_string": {"type": "boolean", "description": "Use literal string matching instead of regex."},
                    "case_sensitive": {"type": "boolean", "description": "Use case-sensitive matching. Defaults to false."},
                    "word_regexp": {"type": "boolean", "description": "Only match whole words."},
                    "context_lines": {"type": "integer", "description": "Context lines around matches, capped at 5."},
                    "files_with_matches": {"type": "boolean", "description": "Return only matching file paths."},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_read_file",
            "description": "Read a bounded slice of a non-sensitive text file from an allowed repository with line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "path": {"type": "string", "description": "Repo-relative file path."},
                    "start_line": {"type": "integer", "description": "First 1-based line to read. Defaults to 1."},
                    "max_lines": {"type": "integer", "description": "Maximum lines to return, capped at 500."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_write_file",
            "description": "Write a UTF-8 text file inside a writable repository. Paths remain rooted under the selected repo and sensitive/binary paths are blocked.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": WRITABLE_REPO_ENUM, "description": WRITABLE_REPO_DESCRIPTION},
                    "path": {"type": "string", "description": "Repo-relative file path to create or overwrite."},
                    "content": {"type": "string", "description": "UTF-8 text content to write, capped at 120000 characters."},
                    "overwrite": {"type": "boolean", "description": "Whether to replace an existing file. Defaults to false."},
                    "create_dirs": {"type": "boolean", "description": "Whether to create parent directories. Defaults to true."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_append_file",
            "description": "Append UTF-8 text to a file inside a writable repository. Paths remain rooted under the selected repo and sensitive/binary paths are blocked.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": WRITABLE_REPO_ENUM, "description": WRITABLE_REPO_DESCRIPTION},
                    "path": {"type": "string", "description": "Repo-relative file path."},
                    "content": {"type": "string", "description": "UTF-8 text content to append, capped at 120000 characters."},
                    "create_dirs": {"type": "boolean", "description": "Whether to create parent directories. Defaults to true."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "notebook_read",
            "description": "Read a structured summary of a .ipynb notebook's cells without hand-parsing raw JSON.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "path": {"type": "string", "description": "Repo-relative .ipynb path."},
                    "max_cells": {"type": "integer", "description": "Maximum cells to return, capped at 200."},
                    "max_source_chars": {"type": "integer", "description": "Maximum source characters per cell, capped at 20000."},
                    "include_outputs": {"type": "boolean", "description": "Whether to include a bounded summary of code outputs."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "notebook_validate",
            "description": "Validate that a .ipynb file has a sane nbformat 4 structure and valid cell shapes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "path": {"type": "string", "description": "Repo-relative .ipynb path."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "notebook_create",
            "description": "Create a clean nbformat 4 Python .ipynb notebook inside a writable repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": WRITABLE_REPO_ENUM, "description": WRITABLE_REPO_DESCRIPTION},
                    "path": {"type": "string", "description": "Repo-relative .ipynb path."},
                    "title": {"type": "string", "description": "Notebook title."},
                    "kind": {"type": "string", "enum": ["experiment", "tutorial"], "description": "Notebook shape. Defaults to experiment."},
                    "overwrite": {"type": "boolean", "description": "Whether to replace an existing notebook. Defaults to false."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "notebook_update_cell",
            "description": "Replace one cell's source in a .ipynb notebook inside a writable repository, optionally changing cell type and clearing outputs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": WRITABLE_REPO_ENUM, "description": WRITABLE_REPO_DESCRIPTION},
                    "path": {"type": "string", "description": "Repo-relative .ipynb path."},
                    "cell_index": {"type": "integer", "description": "Zero-based cell index to update."},
                    "source": {"type": "string", "description": "Replacement cell source."},
                    "cell_type": {"type": "string", "enum": ["markdown", "code", "raw"], "description": "Optional replacement cell type."},
                    "clear_outputs": {"type": "boolean", "description": "Clear code outputs and execution_count. Defaults to true."},
                },
                "required": ["path", "cell_index", "source"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "notebook_append_cell",
            "description": "Append a markdown, code, or raw cell to a .ipynb notebook inside a writable repository.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": WRITABLE_REPO_ENUM, "description": WRITABLE_REPO_DESCRIPTION},
                    "path": {"type": "string", "description": "Repo-relative .ipynb path."},
                    "source": {"type": "string", "description": "Cell source to append."},
                    "cell_type": {"type": "string", "enum": ["markdown", "code", "raw"], "description": "Cell type. Defaults to markdown."},
                    "clear_outputs": {"type": "boolean", "description": "Create code cells without outputs. Defaults to true."},
                },
                "required": ["path", "source"],
            },
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_git_status",
            "description": "Read the current git branch and short status for an allowed repository.",
            "parameters": {"type": "object", "properties": {"repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."}}, "required": []},
        },
    },
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "repo_git_diff",
            "description": "Read a bounded git diff for an allowed repository, optionally scoped to one repo-relative path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {"type": "string", "enum": REPO_ENUM, "description": "Allowed repository to inspect. Defaults to terminus."},
                    "path": {"type": "string", "description": "Optional repo-relative path to diff."},
                    "max_chars": {"type": "integer", "description": "Maximum characters to return, capped at 24000."},
                },
                "required": [],
            },
        },
    },
]


def execute(function_name, arguments, config):
    try:
        arguments = arguments or {}
        if function_name == "repo_tree":
            return repo_tree(
                arguments.get("path", ""),
                arguments.get("max_entries", 200),
                arguments.get("include_hidden", False),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "repo_search":
            return repo_search(
                arguments.get("pattern", ""),
                arguments.get("path", ""),
                arguments.get("file_glob", ""),
                arguments.get("max_results", 40),
                arguments.get("fixed_string", False),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "ripgrep_search":
            return ripgrep_search(
                arguments.get("pattern", ""),
                arguments.get("path", ""),
                arguments.get("file_glob", ""),
                arguments.get("max_results", 40),
                arguments.get("fixed_string", False),
                arguments.get("case_sensitive", False),
                arguments.get("word_regexp", False),
                arguments.get("context_lines", 0),
                arguments.get("files_with_matches", False),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "repo_read_file":
            return repo_read_file(
                arguments.get("path", ""),
                arguments.get("start_line", 1),
                arguments.get("max_lines", 240),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "repo_write_file":
            return repo_write_file(
                arguments.get("path", ""),
                arguments.get("content", ""),
                arguments.get("overwrite", False),
                arguments.get("create_dirs", True),
                arguments.get("repo", "raven_corpus"),
            ), True
        if function_name == "repo_append_file":
            return repo_append_file(
                arguments.get("path", ""),
                arguments.get("content", ""),
                arguments.get("create_dirs", True),
                arguments.get("repo", "raven_corpus"),
            ), True
        if function_name == "notebook_read":
            return notebook_read(
                arguments.get("path", ""),
                arguments.get("max_cells", 80),
                arguments.get("max_source_chars", 5000),
                arguments.get("include_outputs", False),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "notebook_validate":
            return notebook_validate(
                arguments.get("path", ""),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        if function_name == "notebook_create":
            return notebook_create(
                arguments.get("path", ""),
                arguments.get("title", ""),
                arguments.get("kind", "experiment"),
                arguments.get("overwrite", False),
                arguments.get("repo", "raven_corpus"),
            ), True
        if function_name == "notebook_update_cell":
            return notebook_update_cell(
                arguments.get("path", ""),
                arguments.get("cell_index", 0),
                arguments.get("source", ""),
                arguments.get("cell_type", ""),
                arguments.get("clear_outputs", True),
                arguments.get("repo", "raven_corpus"),
            ), True
        if function_name == "notebook_append_cell":
            return notebook_append_cell(
                arguments.get("path", ""),
                arguments.get("source", ""),
                arguments.get("cell_type", "markdown"),
                arguments.get("clear_outputs", True),
                arguments.get("repo", "raven_corpus"),
            ), True
        if function_name == "repo_git_status":
            return repo_git_status(arguments.get("repo", DEFAULT_REPO)), True
        if function_name == "repo_git_diff":
            return repo_git_diff(
                arguments.get("path", ""),
                arguments.get("max_chars", MAX_DIFF_CHARS),
                arguments.get("repo", DEFAULT_REPO),
            ), True
        return f"Unknown function '{function_name}'.", False
    except Exception as exc:
        logger.error("[codebase-reader] tool error: %s", exc, exc_info=True)
        return _json({"ok": False, "error": str(exc)}), False
