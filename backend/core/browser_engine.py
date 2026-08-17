"""
Browser Automation Engine for Terminus using Playwright.

Enables Terminus to:
  - Launch visible Google Chrome on macOS
  - Navigate to URLs and read page content
  - Extract all form inputs, labels, and dropdowns
  - Intelligently fill out forms (job applications, registrations, etc.)
  - Click buttons and submit forms
  - Capture screenshots to ~/.terminus/screenshots/

Session persistence strategy (fixes "no active session" / "starts logged out"):
  1. Try to attach via CDP to port 9222 — the user's daily Chrome if they
     launched it with scripts/launch_chrome_cdp.sh. Reuses real logins/Bitwarden.
  2. Fallback: launch a DEDICATED persistent Chrome at ~/.terminus/chrome-profile
     with --remote-debugging-port=9223. We record its PID. On FastAPI restart,
     we re-attach via CDP to 9223 instead of relaunching (relaunching would fail
     because the orphaned Chrome still holds the profile directory lock — that
     was the root cause of "no active session" after uvicorn reload).
  3. browser_close() disconnects Playwright but does NOT kill the dedicated
     Chrome process, so the session survives the next browser_open.
"""

import concurrent.futures
import json
import logging
import os
import re
import socket
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    logger.warning("Playwright not installed — browser automation tools disabled")


# CDP endpoint for the user's daily Chrome (opt-in via scripts/launch_chrome_cdp.sh)
USER_CDP_PORT = 9222
# CDP endpoint for Terminus's dedicated persistent Chrome
DEDICATED_CDP_PORT = 9223
# Where the dedicated Chrome's user data dir lives
DEDICATED_PROFILE_DIR = Path.home() / ".terminus" / "chrome-profile"
# PID file so we can detect our dedicated Chrome across restarts
PID_FILE = Path.home() / ".terminus" / "data" / "chrome-cdp.pid"


def _cdp_port_open(port: int, host: str = "127.0.0.1", timeout_s: float = 0.4) -> bool:
    """Cheap socket probe — True if something is listening on the CDP port."""
    try:
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _read_dedicated_pid() -> Optional[int]:
    if not PID_FILE.exists():
        return None
    try:
        data = json.loads(PID_FILE.read_text(encoding="utf-8"))
        pid = int(data.get("pid", 0))
        return pid if pid > 0 else None
    except Exception:
        return None


def _write_dedicated_pid(pid: int, port: int = DEDICATED_CDP_PORT) -> None:
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        PID_FILE.write_text(
            json.dumps({"pid": pid, "port": port, "started_at": time.time()}),
            encoding="utf-8",
        )
    except Exception as e:
        logger.debug(f"[browser] Could not write PID file: {e}")


def _clear_dedicated_pid() -> None:
    try:
        if PID_FILE.exists():
            PID_FILE.unlink()
    except Exception:
        pass


class BrowserEngine:
    """
    Manages a persistent Google Chrome browser instance for Terminus.
    Uses a dedicated single-thread worker to ensure compatibility with
    FastAPI's async event loops and synchronous tool calling.
    """

    def __init__(self):
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="browser_worker")
        self._playwright: Optional[Any] = None
        self._browser: Optional[Any] = None  # CDP connection (lightweight)
        self._context: Optional[Any] = None  # persistent context (only when we launched it)
        self._page: Optional[Any] = None
        self._attach_mode: Optional[str] = None  # "user_cdp" | "dedicated_cdp" | "dedicated_launched"
        self._screenshots_dir = Path.home() / ".terminus" / "screenshots"
        self._screenshots_dir.mkdir(parents=True, exist_ok=True)

    def _run_in_worker(self, fn, *args, timeout: float = 45.0, **kwargs):
        """Execute a callable on the dedicated browser worker thread."""
        future = self._executor.submit(fn, *args, **kwargs)
        return future.result(timeout=timeout)

    # ── Connection lifecycle ────────────────────────────────────────────────

    def _start_playwright(self) -> Any:
        if self._playwright is None:
            self._playwright = sync_playwright().start()
        return self._playwright

    def _attach_cdp(self, port: int, mode_label: str) -> bool:
        """Try to connect_over_cdp to a running Chrome on `port`. Returns True on success."""
        if not _cdp_port_open(port):
            return False
        try:
            pw = self._start_playwright()
            self._browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=2000)
            contexts = self._browser.contexts
            if contexts:
                self._context = contexts[0]
                pages = self._context.pages
                self._page = pages[-1] if pages else self._context.new_page()
            else:
                self._context = self._browser.new_context()
                self._page = self._context.new_page()
            self._attach_mode = mode_label
            logger.info(f"[browser] Attached via CDP port {port} ({mode_label})")
            return True
        except Exception as e:
            logger.debug(f"[browser] CDP attach to port {port} failed: {e}")
            # Clean up partial state so a relaunch can proceed cleanly
            self._browser = None
            self._context = None
            self._page = None
            return False

    def _launch_dedicated_chrome(self, headless: bool = False) -> bool:
        """Launch our dedicated persistent Chrome with CDP on port 9223."""
        DEDICATED_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        pw = self._start_playwright()
        args = [
            f"--remote-debugging-port={DEDICATED_CDP_PORT}",
            "--disable-blink-features=AutomationControlled",
        ]
        try:
            self._context = pw.chromium.launch_persistent_context(
                user_data_dir=str(DEDICATED_PROFILE_DIR),
                channel="chrome",
                headless=headless,
                args=args,
                viewport={"width": 1280, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                ),
            )
            logger.info(f"[browser] Launched dedicated Chrome with CDP port {DEDICATED_CDP_PORT}, profile {DEDICATED_PROFILE_DIR}")
        except Exception as e:
            logger.warning(f"[browser] Persistent Chrome launch failed ({e}), falling back to bundled chromium")
            self._context = pw.chromium.launch_persistent_context(
                user_data_dir=str(DEDICATED_PROFILE_DIR),
                headless=headless,
                args=args,
                viewport={"width": 1280, "height": 900},
            )

        pages = self._context.pages
        self._page = pages[0] if pages else self._context.new_page()
        self._browser = None  # we own the context, not a CDP browser handle
        self._attach_mode = "dedicated_launched"

        # Best-effort PID capture for cross-restart detection.
        # launch_persistent_context doesn't expose the PID directly; probe the port
        # and record a marker. The PID is best-effort — the port check is the
        # primary signal used by _attach_cdp on the next restart.
        try:
            import subprocess
            r = subprocess.run(
                ["lsof", "-ti", f"tcp:{DEDICATED_CDP_PORT}", "-sTCP:LISTEN"],
                capture_output=True, text=True, timeout=3,
            )
            pids = [int(p) for p in r.stdout.split() if p.isdigit()]
            if pids:
                _write_dedicated_pid(pids[0], DEDICATED_CDP_PORT)
        except Exception as e:
            logger.debug(f"[browser] Could not capture dedicated Chrome PID: {e}")
        return True

    def _ensure_browser_sync(self, headless: bool = False) -> Any:
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError("Playwright is not installed. Please install playwright.")

        # If we already have a usable connection, just ensure a page exists.
        if self._context is not None:
            try:
                _ = self._context.pages  # cheap liveness probe
                if self._page is None or self._page.is_closed():
                    pages = self._context.pages
                    self._page = pages[-1] if pages else self._context.new_page()
                return self._page
            except Exception:
                # Context died — fall through to re-attach.
                logger.info("[browser] Existing context unusable, re-attaching")
                self._reset_connection_state()

        # 1. User's daily Chrome on 9222 (opt-in via launch_chrome_cdp.sh)
        if self._attach_cdp(USER_CDP_PORT, "user_cdp"):
            return self._page

        # 2. Re-attach to our dedicated Chrome on 9223 (survives uvicorn restart)
        if self._attach_cdp(DEDICATED_CDP_PORT, "dedicated_cdp"):
            return self._page

        # 3. Launch a fresh dedicated Chrome
        return self._page if self._launch_dedicated_chrome(headless=headless) else None

    def _reset_connection_state(self) -> None:
        """Drop all Playwright handles without killing any Chrome process."""
        # Do NOT close _context/_browser here — that would kill the dedicated
        # Chrome. Just forget our handles so _ensure_browser_sync re-attaches.
        self._browser = None
        self._context = None
        self._page = None
        self._attach_mode = None

    def _get_active_page(self, auto_ensure: bool = True) -> Any:
        """Get the active page, auto-recovering if closed or if user opened new tabs."""
        # Liveness check on the existing connection
        if self._context is not None and self._page is not None and not self._page.is_closed():
            try:
                _ = self._page.url  # raises if the connection is gone
                return self._page
            except Exception:
                logger.info("[browser] Page connection lost, re-attaching")
                self._reset_connection_state()

        # Try to recover from an existing context (same process)
        if self._context is not None:
            try:
                pages = self._context.pages
                if pages:
                    self._page = pages[-1]
                    return self._page
            except Exception as e:
                logger.debug(f"[browser] Context page recovery error: {e}")
                self._reset_connection_state()

        # Auto-ensure/connect (re-attaches via CDP if Chrome is still alive)
        if auto_ensure:
            try:
                return self._ensure_browser_sync()
            except Exception as e:
                logger.warning(f"[browser] Could not auto-ensure browser: {e}")
                return None
        return None

    # ── Public tool API ─────────────────────────────────────────────────────

    def status(self) -> str:
        """Return a human-readable connection status for diagnostics."""
        def _task():
            user_port = _cdp_port_open(USER_CDP_PORT)
            dedicated_port = _cdp_port_open(DEDICATED_CDP_PORT)
            pid = _read_dedicated_pid()
            pid_alive = _pid_alive(pid) if pid else False
            attached = self._attach_mode or "none"
            page_ok = False
            url = ""
            if self._page is not None:
                try:
                    url = self._page.url
                    page_ok = True
                except Exception:
                    page_ok = False
            return (
                f"**Browser Status**\n"
                f"- User Chrome CDP (port {USER_CDP_PORT}): {'listening' if user_port else 'not running'}\n"
                f"- Dedicated Chrome CDP (port {DEDICATED_CDP_PORT}): {'listening' if dedicated_port else 'not running'}\n"
                f"- Dedicated PID file: {pid or 'none'} ({'alive' if pid_alive else 'stale/none'})\n"
                f"- Current attach mode: {attached}\n"
                f"- Active page: {'yes' if page_ok else 'no'}{f' ({url})' if url else ''}"
            )
        return self._run_in_worker(_task)

    def get_tabs(self) -> str:
        """List all open tabs in the browser."""
        def _task():
            if self._context is None:
                # Try AppleScript to query native Chrome tabs if Playwright isn't active
                try:
                    import subprocess
                    script = '''
                    tell application "Google Chrome"
                        set tabList to ""
                        set tabIndex to 1
                        repeat with w in windows
                            repeat with t in tabs of w
                                set tabList to tabList & "[" & tabIndex & "] " & (title of t) & " - " & (URL of t) & linefeed
                                set tabIndex to tabIndex + 1
                            end repeat
                        end repeat
                        return tabList
                    end tell
                    '''
                    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
                    if result.returncode == 0 and result.stdout.strip():
                        return f"**Open Chrome Tabs (via macOS AppleScript)**:\n{result.stdout.strip()}"
                except Exception as ex:
                    logger.debug(f"AppleScript tab query failed: {ex}")
                return "No active browser session. Use browser_open(url) first or launch Chrome with remote debugging."

            pages = self._context.pages
            if not pages:
                return "No open tabs."

            lines = ["**Open Browser Tabs**:"]
            for i, p in enumerate(pages, 1):
                is_active = " (Active)" if p == self._page else ""
                try:
                    title = p.title()
                    url = p.url
                except Exception:
                    title, url = "Untitled", "unknown"
                lines.append(f"[{i}]{is_active} **{title}** — `{url}`")
            return "\n".join(lines)

        return self._run_in_worker(_task)

    def switch_tab(self, index: int) -> str:
        """Switch active focus to a specific tab index (1-based)."""
        def _task():
            if self._context is None or not self._context.pages:
                return "No active browser tabs to switch."
            pages = self._context.pages
            if index < 1 or index > len(pages):
                return f"Invalid tab index {index}. Available tabs: 1 to {len(pages)}."
            self._page = pages[index - 1]
            self._page.bring_to_front()
            return f"Switched to tab [{index}]: **{self._page.title()}** (`{self._page.url}`)"

        return self._run_in_worker(_task)

    def navigate(self, url: str, headless: bool = False) -> str:
        """
        Navigate to a URL. Launches Chrome if not already running.
        """
        def _task():
            clean_url = url.strip()
            if not (clean_url.startswith("http://") or clean_url.startswith("https://") or clean_url.startswith("file://") or clean_url.startswith("about:")):
                clean_url = f"https://{clean_url}"

            try:
                page = self._get_active_page(auto_ensure=True)
                if page is None:
                    page = self._ensure_browser_sync(headless=headless)
                page.goto(clean_url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1500)
                title = page.title()
                current_url = page.url
                return f"Navigated to: {title}\nURL: {current_url}"
            except Exception as e:
                logger.error(f"[browser] Navigation failed for {clean_url}: {e}")
                return f"Failed to navigate to {clean_url}: {str(e)}"

        return self._run_in_worker(_task)

    def get_page_content(self, max_length: int = 4000) -> str:
        """
        Extract clean text and interactive summary from the active page.
        """
        def _task():
            page = self._get_active_page(auto_ensure=True)
            if page is None or page.is_closed():
                return "No active browser session. Use browser_open(url) first."

            try:
                title = page.title()
                url = page.url

                extracted = page.evaluate("""() => {
                    const getVisibleText = (el) => {
                        if (!el) return '';
                        const style = window.getComputedStyle(el);
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                            return '';
                        }
                        return el.innerText || '';
                    };

                    const main = document.querySelector('main, [role="main"], article, #content, .content') || document.body;
                    const text = getVisibleText(main);

                    const actions = [];
                    document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"], [role="button"]').forEach((el) => {
                        const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
                        if (txt && txt.length < 50 && actions.length < 25) {
                            const tag = el.tagName.toLowerCase();
                            actions.push(`[${actions.length + 1}] <${tag}> "${txt}"`);
                        }
                    });

                    return {
                        text: text.slice(0, 3000),
                        actions: actions
                    };
                }""")

                lines = [
                    f"**Page Title**: {title}",
                    f"**Current URL**: {url}",
                    "",
                    "**Page Content Summary**:",
                    extracted.get("text", "")[:max_length],
                    "",
                    "**Key Interactive Elements**:",
                    "\n".join(extracted.get("actions", [])[:15]),
                ]
                return "\n".join(lines)
            except Exception as e:
                logger.error(f"[browser] Error reading page: {e}")
                return f"Error reading page content: {str(e)}"

        return self._run_in_worker(_task)

    def extract_form(self) -> str:
        """
        Scans the current page and extracts all form fields, inputs, dropdowns, and checkboxes.
        """
        def _task():
            page = self._get_active_page(auto_ensure=True)
            if page is None or page.is_closed():
                return "No active browser session. Use browser_open(url) first."

            try:
                fields = page.evaluate("""() => {
                    const results = [];
                    const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
                    
                    inputs.forEach((el, index) => {
                        const tag = el.tagName.toLowerCase();
                        const type = el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'text');
                        const id = el.id || '';
                        const name = el.name || '';
                        const placeholder = el.placeholder || '';
                        const required = el.required || el.hasAttribute('aria-required') || false;
                        const value = el.value || '';
                        
                        let label = '';
                        if (id) {
                            const labelEl = document.querySelector(`label[for="${id}"]`);
                            if (labelEl) label = labelEl.innerText.trim();
                        }
                        if (!label) {
                            const parentLabel = el.closest('label');
                            if (parentLabel) label = parentLabel.innerText.trim();
                        }
                        if (!label && el.getAttribute('aria-label')) {
                            label = el.getAttribute('aria-label').trim();
                        }
                        if (!label && el.getAttribute('aria-labelledby')) {
                            const labelled = document.getElementById(el.getAttribute('aria-labelledby'));
                            if (labelled) label = labelled.innerText.trim();
                        }
                        
                        let options = [];
                        if (tag === 'select') {
                            Array.from(el.options).slice(0, 15).forEach(o => {
                                if (o.text && o.text.trim()) options.push(o.text.trim());
                            });
                        }
                        
                        const fieldName = label || placeholder || name || id || `Field_${index + 1}`;
                        
                        results.push({
                            index: index + 1,
                            name: fieldName,
                            type: type,
                            id: id,
                            input_name: name,
                            placeholder: placeholder,
                            required: required,
                            current_value: type === 'checkbox' || type === 'radio' ? el.checked : value,
                            options: options
                        });
                    });
                    
                    return results;
                }""")

                if not fields:
                    return "No form fields detected on the current page."

                output = ["**Detected Form Fields**:\n"]
                for f in fields:
                    req = " *(Required)*" if f.get("required") else ""
                    val = f" [Current: {f.get('current_value')}]" if f.get("current_value") else ""
                    opts = f" (Options: {', '.join(f['options'][:6])})" if f.get("options") else ""
                    output.append(f"{f['index']}. **{f['name']}** ({f['type']}){req}{val}{opts}")

                output.append("\nTo fill these out, provide values using `browser_fill_form`.")
                return "\n".join(output)
            except Exception as e:
                logger.error(f"[browser] Error extracting form: {e}")
                return f"Error inspecting form fields: {str(e)}"

        return self._run_in_worker(_task)

    def fill_form(self, fields: Dict[str, Any]) -> str:
        """
        Fills out form fields by matching labels, placeholders, or names.
        """
        def _task():
            page = self._get_active_page(auto_ensure=True)
            if page is None or page.is_closed():
                return "No active browser session. Use browser_open(url) first."

            if not fields or not isinstance(fields, dict):
                return "No fields provided to fill."

            results = []

            for key, value in fields.items():
                val_str = str(value) if value is not None else ""
                filled = False

                # 1. Try get_by_label
                try:
                    locator = page.get_by_label(re.compile(re.escape(key), re.IGNORECASE))
                    if locator.count() > 0:
                        tag = locator.first.evaluate("el => el.tagName.toLowerCase()")
                        input_type = locator.first.evaluate("el => el.getAttribute('type') || ''")
                        
                        if tag == "select":
                            locator.first.select_option(label=val_str)
                        elif input_type in ("checkbox", "radio"):
                            if str(value).lower() in ("true", "1", "yes", "checked"):
                                locator.first.check()
                            else:
                                locator.first.uncheck()
                        else:
                            locator.first.fill(val_str)
                        filled = True
                        results.append(f"✓ Filled '{key}': {val_str}")
                        continue
                except Exception:
                    pass

                # 2. Try get_by_placeholder
                try:
                    locator = page.get_by_placeholder(re.compile(re.escape(key), re.IGNORECASE))
                    if locator.count() > 0:
                        locator.first.fill(val_str)
                        filled = True
                        results.append(f"✓ Filled '{key}': {val_str}")
                        continue
                except Exception:
                    pass

                # 3. Try custom selector or fallback DOM script
                try:
                    res = page.evaluate("""([targetKey, val]) => {
                        const keyLower = targetKey.toLowerCase().trim();
                        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'));
                        
                        for (const el of inputs) {
                            const id = (el.id || '').toLowerCase();
                            const name = (el.name || '').toLowerCase();
                            const placeholder = (el.placeholder || '').toLowerCase();
                            let label = '';
                            if (el.id) {
                                const lbl = document.querySelector(`label[for="${el.id}"]`);
                                if (lbl) label = lbl.innerText.toLowerCase();
                            }
                            if (!label && el.closest('label')) {
                                label = el.closest('label').innerText.toLowerCase();
                            }
                            
                            if (label.includes(keyLower) || placeholder.includes(keyLower) || name.includes(keyLower) || id.includes(keyLower)) {
                                const tag = el.tagName.toLowerCase();
                                const type = el.getAttribute('type') || '';
                                
                                if (tag === 'select') {
                                    for (let opt of el.options) {
                                        if (opt.text.toLowerCase().includes(val.toLowerCase()) || opt.value.toLowerCase().includes(val.toLowerCase())) {
                                            el.value = opt.value;
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                            return { success: true, matched: label || placeholder || name || id };
                                        }
                                    }
                                } else if (type === 'checkbox' || type === 'radio') {
                                    el.checked = (val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes');
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    return { success: true, matched: label || placeholder || name || id };
                                } else {
                                    el.value = val;
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                    return { success: true, matched: label || placeholder || name || id };
                                }
                            }
                        }
                        return { success: false };
                    }""", [key, val_str])

                    if res.get("success"):
                        results.append(f"✓ Filled '{key}' (matched: {res.get('matched')}): {val_str}")
                        filled = True
                    else:
                        results.append(f"✗ Could not find field matching '{key}'")
                except Exception as e:
                    results.append(f"✗ Error filling '{key}': {str(e)}")

            return "\n".join(results)

        return self._run_in_worker(_task)

    def click(self, target: str) -> str:
        """
        Clicks a button, link, or element matching text, label, or selector.
        """
        def _task():
            page = self._get_active_page(auto_ensure=True)
            if page is None or page.is_closed():
                return "No active browser session. Use browser_open(url) first."

            try:
                btn = page.get_by_role("button", name=re.compile(re.escape(target), re.IGNORECASE))
                if btn.count() > 0:
                    btn.first.click(timeout=5000)
                    page.wait_for_timeout(1000)
                    return f"✓ Clicked button: '{target}'"

                by_text = page.get_by_text(re.compile(re.escape(target), re.IGNORECASE))
                if by_text.count() > 0:
                    by_text.first.click(timeout=5000)
                    page.wait_for_timeout(1000)
                    return f"✓ Clicked element with text: '{target}'"

                page.locator(target).click(timeout=5000)
                page.wait_for_timeout(1000)
                return f"✓ Clicked selector: '{target}'"
            except Exception as e:
                logger.error(f"[browser] Click failed for target '{target}': {e}")
                return f"Failed to click '{target}': {str(e)}"

        return self._run_in_worker(_task)

    def take_screenshot(self, name: Optional[str] = None) -> str:
        """
        Captures a screenshot and saves it to ~/.terminus/screenshots/.
        """
        def _task():
            page = self._get_active_page(auto_ensure=True)
            if page is None or page.is_closed():
                return "No active browser session. Use browser_open(url) first."

            clean_name = re.sub(r'[^a-zA-Z0-9_-]', '_', name or f"screenshot_{int(time.time())}")
            if not clean_name.endswith(".png"):
                clean_name += ".png"

            filepath = self._screenshots_dir / clean_name
            try:
                page.screenshot(path=str(filepath), full_page=False)
                return f"Screenshot saved to: {filepath}"
            except Exception as e:
                return f"Failed to take screenshot: {str(e)}"

        return self._run_in_worker(_task)

    def close(self, kill_chrome: bool = False) -> str:
        """
        Disconnect from the browser session.

        By default (kill_chrome=False) this ONLY drops Playwright's handles —
        the dedicated Chrome process keeps running so the next browser_open
        re-attaches to the same logged-in session via CDP port 9223. This is
        the fix for "starts logged out" / "no active session" across tasks.

        Pass kill_chrome=True to fully terminate the dedicated Chrome process
        (the user's daily Chrome on port 9222 is never killed by Terminus).
        """
        def _task():
            killed_pid = None
            try:
                if self._page and not self._page.is_closed():
                    try:
                        self._page.close()
                    except Exception:
                        pass
                # Only close the context if WE launched it (dedicated_launched).
                # If we attached via CDP (user_cdp / dedicated_cdp), closing the
                # context would kill the user's Chrome — never do that.
                if self._context is not None and self._attach_mode == "dedicated_launched":
                    try:
                        self._context.close()
                    except Exception:
                        pass
                if self._browser is not None:
                    try:
                        self._browser.close()
                    except Exception:
                        pass
            except Exception as e:
                logger.warning(f"[browser] Error during browser close: {e}")
            finally:
                self._page = None
                self._context = None
                self._browser = None
                self._attach_mode = None

            if kill_chrome:
                pid = _read_dedicated_pid()
                if pid and _pid_alive(pid):
                    try:
                        os.kill(pid, 15)  # SIGTERM
                        killed_pid = pid
                        _clear_dedicated_pid()
                    except Exception as e:
                        logger.warning(f"[browser] Could not kill dedicated Chrome PID {pid}: {e}")
                else:
                    # Fallback: kill anything listening on the dedicated CDP port
                    try:
                        import subprocess
                        subprocess.run(
                            ["sh", "-c", f"lsof -ti tcp:{DEDICATED_CDP_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true"],
                            timeout=5,
                        )
                    except Exception:
                        pass

            if killed_pid:
                return f"Browser disconnected and dedicated Chrome (PID {killed_pid}) terminated."
            return "Browser session disconnected. Dedicated Chrome keeps running for session persistence."

        return self._run_in_worker(_task)

    def shutdown(self) -> str:
        """Fully terminate the dedicated Chrome process (alias for close(kill_chrome=True))."""
        return self.close(kill_chrome=True)


# Global singleton instance
browser_engine = BrowserEngine()
