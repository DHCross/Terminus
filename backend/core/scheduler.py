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
        self._restore_custom_tasks()

    def _get_custom_tasks_file(self) -> Path:
        p = Path.home() / ".terminus" / "data" / "custom_tasks.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _load_custom_tasks(self) -> dict:
        f = self._get_custom_tasks_file()
        if not f.exists():
            return {}
        try:
            import json
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save_custom_tasks(self, tasks: dict):
        f = self._get_custom_tasks_file()
        try:
            import json
            f.write_text(json.dumps(tasks, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning(f"[scheduler] Failed saving custom tasks: {e}")

    def _restore_custom_tasks(self):
        tasks = self._load_custom_tasks()
        for task_id, t in tasks.items():
            try:
                self._schedule_task_job(
                    task_id=task_id,
                    name=t.get("name", task_id),
                    interval_minutes=t.get("interval_minutes"),
                    cron_hour=t.get("cron_hour"),
                    cron_minute=t.get("cron_minute"),
                    instruction=t.get("instruction", ""),
                    persist=False
                )
            except Exception as e:
                logger.warning(f"[scheduler] Error restoring custom task {task_id}: {e}")

    def _execute_custom_task(self, task_id: str, name: str, instruction: str):
        """Execute a scheduled background task and notify user if noteworthy."""
        logger.info(f"[scheduler] Executing custom background task '{name}' ({task_id})")
        if not self.generate_fn:
            logger.warning(f"[scheduler] Cannot execute '{name}': no generate_fn configured")
            return

        prompt = (
            f"You are Terminus running a background scheduled watchdog task: '{name}'.\n"
            f"Task Instruction: {instruction}\n\n"
            f"Execute any necessary analysis or actions. If you find important updates or results for Dan, "
            f"provide a clear concise summary. If there is nothing new, return 'NO_ACTION'."
        )
        try:
            response = self.generate_fn(prompt)
            if response and "NO_ACTION" not in response:
                # Send macOS system notification
                try:
                    from core.macos_controller import macos_controller
                    clean_msg = response.strip().replace("\n", " ")[:120]
                    macos_controller.system_notify(f"Terminus: {name}", clean_msg)
                except Exception as ex:
                    logger.debug(f"[scheduler] Failed to send notification: {ex}")

                # Save output to journal
                now_str = datetime.now().strftime("%Y-%m-%d")
                task_log = JOURNAL_DIR / f"{now_str}-tasks.md"
                with task_log.open("a", encoding="utf-8") as f:
                    f.write(f"\n\n### [{datetime.now().strftime('%H:%M')}] Scheduled Task: {name}\n{response}\n")

        except Exception as e:
            logger.error(f"[scheduler] Custom task execution '{name}' failed: {e}")

    def add_custom_task(
        self,
        name: str,
        instruction: str,
        interval_minutes: Optional[int] = None,
        cron_hour: Optional[int] = None,
        cron_minute: Optional[int] = None,
    ) -> str:
        """Schedule a new recurring background task with persistence."""
        import re
        import uuid
        task_id = f"task_{re.sub(r'[^a-zA-Z0-9_]', '_', name).lower()[:20]}_{str(uuid.uuid4())[:6]}"
        return self._schedule_task_job(
            task_id=task_id,
            name=name,
            interval_minutes=interval_minutes,
            cron_hour=cron_hour,
            cron_minute=cron_minute,
            instruction=instruction,
            persist=True
        )

    def _schedule_task_job(
        self,
        task_id: str,
        name: str,
        instruction: str,
        interval_minutes: Optional[int] = None,
        cron_hour: Optional[int] = None,
        cron_minute: Optional[int] = None,
        persist: bool = True
    ) -> str:
        if not self._scheduler or not self._scheduler.running:
            self.start()

        if not self._scheduler:
            return "APScheduler is not available on this system."

        trigger = None
        schedule_desc = ""
        if interval_minutes and interval_minutes > 0:
            trigger = IntervalTrigger(minutes=interval_minutes)
            schedule_desc = f"every {interval_minutes} minutes"
        elif cron_hour is not None:
            minute = cron_minute if cron_minute is not None else 0
            trigger = CronTrigger(hour=cron_hour, minute=minute)
            schedule_desc = f"daily at {cron_hour:02d}:{minute:02d} UTC"
        else:
            trigger = IntervalTrigger(hours=1)
            schedule_desc = "every 1 hour (default)"

        self._scheduler.add_job(
            lambda: self._execute_custom_task(task_id, name, instruction),
            trigger,
            id=task_id,
            name=f"Task: {name}",
            replace_existing=True,
        )

        if persist:
            tasks = self._load_custom_tasks()
            tasks[task_id] = {
                "id": task_id,
                "name": name,
                "instruction": instruction,
                "interval_minutes": interval_minutes,
                "cron_hour": cron_hour,
                "cron_minute": cron_minute,
                "schedule": schedule_desc,
                "created_at": datetime.now().isoformat()
            }
            self._save_custom_tasks(tasks)

        logger.info(f"[scheduler] Scheduled custom task '{name}' ({task_id}) {schedule_desc}")
        return f"Successfully scheduled task '{name}' (ID: {task_id}) running {schedule_desc}."

    def cancel_task(self, task_id: str) -> str:
        """Cancel a scheduled custom task."""
        if self._scheduler and self._scheduler.running:
            try:
                self._scheduler.remove_job(task_id)
            except Exception:
                pass

        # Remove from persistence
        tasks = self._load_custom_tasks()
        if task_id in tasks:
            del tasks[task_id]
            self._save_custom_tasks(tasks)
            return f"Task '{task_id}' has been cancelled and removed."

        return f"Task '{task_id}' removed from active schedule."

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
        if job_id in job_map:
            try:
                job_map[job_id]()
                return True
            except Exception as e:
                logger.error(f"[scheduler] Manual trigger {job_id} failed: {e}")
                return False

        # Check custom jobs
        tasks = self._load_custom_tasks()
        if job_id in tasks:
            t = tasks[job_id]
            self._execute_custom_task(job_id, t.get("name", job_id), t.get("instruction", ""))
            return True

        return False


# Global singleton
_scheduler: Optional[TerminusScheduler] = None


def get_scheduler(**kwargs) -> TerminusScheduler:
    """Get or create global scheduler instance."""
    global _scheduler
    if _scheduler is None:
        _scheduler = TerminusScheduler(**kwargs)
    return _scheduler
