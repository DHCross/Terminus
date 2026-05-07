"""
APScheduler-powered background heartbeat for Terminus.

Scheduled jobs:
  - 07:00  daily_brief      — Generate morning context summary, save to journal
  - 21:00  journal_prompt   — Evening reflection, append to today's trace
  - 03:00  trace_compact    — Compact yesterday's trace into a summary entry
  - Every 30 min: health_ping — Log uptime to activity_log

All jobs write to the continuity DB and/or trace files so Terminus can
read them as context in later conversations.
"""

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Callable

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.interval import IntervalTrigger
    APSCHEDULER_AVAILABLE = True
except ImportError:
    APSCHEDULER_AVAILABLE = False

logger = logging.getLogger(__name__)

# Where traces and journal entries live
TRACES_DIR = Path.home() / ".terminus" / "data" / "traces"
JOURNAL_DIR = Path.home() / ".terminus" / "data" / "journal"


def _ensure_dirs():
    TRACES_DIR.mkdir(parents=True, exist_ok=True)
    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)


# ── Job implementations ──────────────────────────────────────────────────────

def daily_brief(generate_fn: Optional[Callable] = None):
    """
    Morning job: summarize yesterday's trace + journal into a brief.
    Writes to journal/{date}-brief.md and logs to activity_log.
    """
    _ensure_dirs()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    brief_path = JOURNAL_DIR / f"{today}-brief.md"

    if brief_path.exists():
        logger.info(f"[scheduler] Daily brief already exists for {today}, skipping")
        return

    # Read yesterday's trace if it exists
    yesterday = (now.replace(hour=0, minute=0, second=0) - timedelta(days=1)).strftime("%Y-%m-%d")
    trace_path = TRACES_DIR / f"{yesterday}.md"
    context = ""
    if trace_path.exists():
        context = trace_path.read_text(encoding="utf-8")[-4000:]  # last 4k chars

    brief_content = f"# Daily Brief — {today}\n\n"
    brief_content += f"*Generated at {now.strftime('%H:%M')}*\n\n"

    if generate_fn and context:
        try:
            prompt = (
                f"You are Terminus, a self-hosted AI assistant. "
                f"Based on yesterday's conversation traces below, write a brief morning summary "
                f"in 2-3 paragraphs: what was discussed, any open threads, and one suggested focus for today.\n\n"
                f"Yesterday's traces:\n{context}"
            )
            summary = generate_fn(prompt)
            brief_content += summary
        except Exception as e:
            logger.warning(f"[scheduler] Brief generation failed: {e}")
            brief_content += "_Brief generation unavailable — LLM not connected._\n"
            if context:
                brief_content += f"\n\n**Yesterday's trace excerpt:**\n\n{context[:1000]}...\n"
    else:
        brief_content += "_No previous trace found. Fresh start today._\n"

    brief_path.write_text(brief_content, encoding="utf-8")
    logger.info(f"[scheduler] Daily brief written to {brief_path}")


def journal_prompt(generate_fn: Optional[Callable] = None):
    """
    Evening job: write a reflection prompt to today's journal entry.
    Appends to journal/{date}.md.
    """
    _ensure_dirs()
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    journal_path = JOURNAL_DIR / f"{today}.md"

    # Read today's trace for context
    trace_path = TRACES_DIR / f"{today}.md"
    context = ""
    if trace_path.exists():
        context = trace_path.read_text(encoding="utf-8")[-3000:]

    entry = f"\n\n---\n\n## Evening Reflection — {now.strftime('%H:%M')}\n\n"

    if generate_fn and context:
        try:
            prompt = (
                f"You are Terminus. Based on today's conversation traces, write a brief evening "
                f"reflection (3-5 sentences): what felt significant, any patterns you noticed, "
                f"and one open question to carry forward.\n\nToday's traces:\n{context}"
            )
            reflection = generate_fn(prompt)
            entry += reflection
        except Exception as e:
            logger.warning(f"[scheduler] Journal prompt generation failed: {e}")
            entry += "_Reflection generation unavailable._\n"
    else:
        entry += "_No conversations today._\n"

    with journal_path.open("a", encoding="utf-8") as f:
        f.write(entry)

    logger.info(f"[scheduler] Journal entry appended to {journal_path}")


def trace_compact():
    """
    Early morning job: compact yesterday's JSONL trace into a summary line
    at the top of the file for fast context loading.
    """
    _ensure_dirs()
    yesterday = (datetime.now().replace(hour=0, minute=0, second=0) - timedelta(days=1)).strftime("%Y-%m-%d")
    trace_path = TRACES_DIR / f"{yesterday}.jsonl"

    if not trace_path.exists():
        return

    import json
    try:
        lines = trace_path.read_text(encoding="utf-8").strip().splitlines()
        entries = [json.loads(l) for l in lines if l.strip()]
        user_count = sum(1 for e in entries if e.get("type") == "user")
        assistant_count = sum(1 for e in entries if e.get("type") == "assistant")
        tool_count = sum(1 for e in entries if e.get("type") == "tool_call")

        summary = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "type": "compact_summary",
            "date": yesterday,
            "user_turns": user_count,
            "assistant_turns": assistant_count,
            "tool_calls": tool_count,
            "total_entries": len(entries),
        }

        # Prepend summary to file
        existing = trace_path.read_text(encoding="utf-8")
        trace_path.write_text(
            json.dumps(summary, ensure_ascii=False) + "\n" + existing,
            encoding="utf-8"
        )
        logger.info(f"[scheduler] Trace compacted for {yesterday}: {user_count}u/{assistant_count}a/{tool_count}t")
    except Exception as e:
        logger.warning(f"[scheduler] Trace compact failed: {e}")


def health_ping(db=None):
    """Log an uptime heartbeat to the activity_log table."""
    if db:
        try:
            import sqlite3
            conn = sqlite3.connect(db.db_path)
            conn.execute(
                "INSERT INTO activity_log (event_type, content, timestamp) VALUES (?, ?, ?)",
                ("health_ping", "Terminus running", datetime.now().isoformat()),
            )
            conn.commit()
            conn.close()
            logger.debug("[scheduler] health_ping logged")
        except Exception as e:
            logger.warning(f"[scheduler] Health ping failed: {e}")
    else:
        logger.debug("[scheduler] health_ping — no DB connected")


# ── Scheduler ────────────────────────────────────────────────────────────────

class TerminusScheduler:
    """
    Background scheduler. Starts with the FastAPI app and stops on shutdown.

    Usage:
        scheduler = TerminusScheduler(generate_fn=claude_client.send_message, db=continuity_db)
        scheduler.start()
        # ... app runs ...
        scheduler.stop()
    """

    def __init__(
        self,
        generate_fn: Optional[Callable] = None,
        db=None,
    ):
        self.generate_fn = generate_fn
        self.db = db
        self._scheduler: Optional["BackgroundScheduler"] = None

        if not APSCHEDULER_AVAILABLE:
            logger.warning("[scheduler] APScheduler not installed — scheduled jobs disabled")

    def start(self):
        """Start the background scheduler with all jobs registered."""
        if not APSCHEDULER_AVAILABLE:
            return

        self._scheduler = BackgroundScheduler(timezone="UTC")

        # Daily brief at 07:00
        self._scheduler.add_job(
            lambda: daily_brief(self.generate_fn),
            CronTrigger(hour=7, minute=0),
            id="daily_brief",
            name="Daily Brief",
            replace_existing=True,
        )

        # Evening journal at 21:00
        self._scheduler.add_job(
            lambda: journal_prompt(self.generate_fn),
            CronTrigger(hour=21, minute=0),
            id="journal_prompt",
            name="Journal Prompt",
            replace_existing=True,
        )

        # Trace compact at 03:00
        self._scheduler.add_job(
            trace_compact,
            CronTrigger(hour=3, minute=0),
            id="trace_compact",
            name="Trace Compact",
            replace_existing=True,
        )

        # Health ping every 30 minutes
        self._scheduler.add_job(
            lambda: health_ping(self.db),
            IntervalTrigger(minutes=30),
            id="health_ping",
            name="Health Ping",
            replace_existing=True,
        )

        self._scheduler.start()
        logger.info("[scheduler] Started — daily_brief@07:00, journal@21:00, compact@03:00, ping/30m")

    def stop(self):
        """Stop the scheduler cleanly."""
        if self._scheduler and self._scheduler.running:
            self._scheduler.shutdown(wait=False)
            logger.info("[scheduler] Stopped")

    def list_jobs(self) -> list:
        """Return list of scheduled jobs with next run time."""
        if not self._scheduler:
            return []
        jobs = []
        for job in self._scheduler.get_jobs():
            next_run = job.next_run_time.isoformat() if job.next_run_time else None
            jobs.append({
                "id": job.id,
                "name": job.name,
                "next_run": next_run,
            })
        return jobs

    def trigger_now(self, job_id: str) -> bool:
        """Manually trigger a job by ID. Returns True if triggered."""
        job_map = {
            "daily_brief": lambda: daily_brief(self.generate_fn),
            "journal_prompt": lambda: journal_prompt(self.generate_fn),
            "trace_compact": trace_compact,
            "health_ping": lambda: health_ping(self.db),
        }
        if job_id not in job_map:
            return False
        try:
            job_map[job_id]()
            return True
        except Exception as e:
            logger.error(f"[scheduler] Manual trigger {job_id} failed: {e}")
            return False


# Global singleton
_scheduler: Optional[TerminusScheduler] = None


def get_scheduler(**kwargs) -> TerminusScheduler:
    """Get or create global scheduler instance."""
    global _scheduler
    if _scheduler is None:
        _scheduler = TerminusScheduler(**kwargs)
    return _scheduler
