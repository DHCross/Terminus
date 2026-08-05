# core/usage_tracker.py — Track API credit usage locally
# Accumulates token costs per-request, stores running balance in a JSON file.

import json
import logging
import os
import threading
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_legacy_data_path = Path(__file__).parent.parent / "user" / "usage.json"
_data_path = Path(
    os.environ.get("SAPPHIRE_USAGE_TRACKER_PATH", str(Path.home() / ".terminus" / "usage.json"))
).expanduser()

# Claude pricing per million tokens (as of August 2026)
# https://docs.anthropic.com/en/docs/about-claude/pricing
PRICING = {
    # Claude Sonnet 4.5 / 4.6
    "claude-sonnet-4-5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    # Claude Sonnet 5
    "claude-sonnet-5": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
    # Claude Haiku 4.5
    "claude-haiku-4-5": {"input": 0.80, "output": 4.00, "cache_read": 0.08, "cache_write": 1.00},
    "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00, "cache_read": 0.08, "cache_write": 1.00},
    # Claude Opus 4.5 / 5
    "claude-opus-4-5": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-5": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-4-6": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    "claude-opus-4-7": {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_write": 18.75},
    # Fallback for unknown models
    "_default": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write": 3.75},
}


def _load():
    """Load usage data from disk."""
    try:
        if _data_path.exists():
            return json.loads(_data_path.read_text(encoding="utf-8"))
        if _legacy_data_path != _data_path and _legacy_data_path.exists():
            return json.loads(_legacy_data_path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"[USAGE] Failed to load usage data: {e}")
    return {
        "starting_balance": 5.00,
        "total_spent": 0.0,
        "session_spent": 0.0,
        "last_updated": None,
        "history": []  # Last N entries for debugging
    }


def _save(data):
    """Save usage data to disk."""
    try:
        _data_path.parent.mkdir(parents=True, exist_ok=True)
        _data_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning(f"[USAGE] Failed to save usage data: {e}")


def get_balance():
    """Get current balance info."""
    with _lock:
        data = _load()
        remaining = max(0, data["starting_balance"] - data["total_spent"])
        return {
            "starting_balance": round(data["starting_balance"], 4),
            "total_spent": round(data["total_spent"], 4),
            "session_spent": round(data.get("session_spent", 0), 4),
            "remaining": round(remaining, 4),
            "last_updated": data.get("last_updated"),
            "tracker_path": str(_data_path),
            "tracker_scope": "shared-local",
        }


def set_balance(amount):
    """Set the current remaining balance shown in the UI.

    The UI prompt asks for the balance "as of right now", so we preserve spend
    history and shift the starting balance so remaining credit matches `amount`
    exactly at the moment this is called.
    """
    with _lock:
        data = _load()
        target_remaining = float(amount)
        data["starting_balance"] = float(data.get("total_spent", 0.0)) + target_remaining
        data["last_updated"] = datetime.now().isoformat()
        _save(data)
    logger.info(f"[USAGE] Remaining balance set to ${amount:.2f}")
    return get_balance()


def reset_session():
    """Reset session-level spending counter."""
    with _lock:
        data = _load()
        data["session_spent"] = 0.0
        _save(data)


def record_usage(model, prompt_tokens=0, completion_tokens=0,
                 cache_read_tokens=0, cache_write_tokens=0):
    """Record token usage and deduct estimated cost from balance.

    Args:
        model: Model name (e.g., 'claude-sonnet-4-6')
        prompt_tokens: Input tokens (excluding cache)
        completion_tokens: Output tokens
        cache_read_tokens: Tokens read from cache (cheaper)
        cache_write_tokens: Tokens written to cache (more expensive)
    """
    prices = PRICING.get(model, PRICING["_default"])

    # Cache-read tokens replace regular input tokens at a lower rate
    # Non-cached input = total input - cache_read - cache_write
    regular_input = max(0, prompt_tokens - cache_read_tokens - cache_write_tokens)

    cost = (
        (regular_input / 1_000_000) * prices["input"] +
        (completion_tokens / 1_000_000) * prices["output"] +
        (cache_read_tokens / 1_000_000) * prices["cache_read"] +
        (cache_write_tokens / 1_000_000) * prices["cache_write"]
    )

    with _lock:
        data = _load()
        data["total_spent"] += cost
        data["session_spent"] = data.get("session_spent", 0) + cost
        data["last_updated"] = datetime.now().isoformat()

        # Keep last 50 entries for debugging
        data["history"] = data.get("history", [])[-49:] + [{
            "time": datetime.now().strftime("%H:%M:%S"),
            "model": model,
            "in": prompt_tokens,
            "out": completion_tokens,
            "cache_r": cache_read_tokens,
            "cache_w": cache_write_tokens,
            "cost": round(cost, 6),
        }]
        _save(data)

    remaining = max(0, data["starting_balance"] - data["total_spent"])
    logger.info(
        f"[USAGE] {model}: {prompt_tokens}in/{completion_tokens}out "
        f"(cache: {cache_read_tokens}r/{cache_write_tokens}w) "
        f"= ${cost:.4f} | remaining: ${remaining:.2f}"
    )
    return cost
