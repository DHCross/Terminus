"""
Browser Automation Engine for Terminus using Playwright.

Enables Terminus to:
  - Launch visible Google Chrome on macOS
  - Navigate to URLs and read page content
  - Extract all form inputs, labels, and dropdowns
  - Intelligently fill out forms (job applications, registrations, etc.)
  - Click buttons and submit forms
  - Capture screenshots to ~/.terminus/screenshots/
"""

import concurrent.futures
import logging
import os
import re
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


class BrowserEngine:
    """
    Manages a persistent Google Chrome browser instance for Terminus.
    Uses a dedicated single-thread worker to ensure compatibility with
    FastAPI's async event loops and synchronous tool calling.
    """

    def __init__(self):
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="browser_worker")
        self._playwright: Optional[Any] = None
        self._browser: Optional[Any] = None
        self._context: Optional[Any] = None
        self._page: Optional[Any] = None
        self._screenshots_dir = Path.home() / ".terminus" / "screenshots"
        self._screenshots_dir.mkdir(parents=True, exist_ok=True)

    def _run_in_worker(self, fn, *args, timeout: float = 45.0, **kwargs):
        """Execute a callable on the dedicated browser worker thread."""
        future = self._executor.submit(fn, *args, **kwargs)
        return future.result(timeout=timeout)

    def _ensure_browser_sync(self, headless: bool = False) -> Any:
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError("Playwright is not installed. Please install playwright.")

        if self._playwright is None:
            self._playwright = sync_playwright().start()

        # 1. First attempt: Connect to an existing running Chrome instance (CDP port 9222)
        if self._context is None and (self._browser is None or not self._browser.is_connected()):
            try:
                self._browser = self._playwright.chromium.connect_over_cdp("http://localhost:9222", timeout=2000)
                contexts = self._browser.contexts
                if contexts:
                    self._context = contexts[0]
                    pages = self._context.pages
                    self._page = pages[-1] if pages else self._context.new_page()
                else:
                    self._context = self._browser.new_context()
                    self._page = self._context.new_page()
                logger.info("[browser] Connected to user's existing Chrome instance via CDP (port 9222)")
                return self._page
            except Exception:
                pass  # Chrome not running with CDP on port 9222

        # 2. Second attempt: Launch with persistent profile so Bitwarden and logins persist permanently
        if self._context is None:
            user_data_dir = Path.home() / ".terminus" / "chrome-profile"
            user_data_dir.mkdir(parents=True, exist_ok=True)
            try:
                self._context = self._playwright.chromium.launch_persistent_context(
                    user_data_dir=str(user_data_dir),
                    channel="chrome",
                    headless=headless,
                    args=["--disable-blink-features=AutomationControlled"],
                    viewport={"width": 1280, "height": 900},
                    user_agent=(
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                    ),
                )
                logger.info(f"[browser] Google Chrome launched with persistent profile at {user_data_dir}")
            except Exception as e:
                logger.warning(f"[browser] Persistent Chrome launch failed ({e}), falling back to chromium")
                self._context = self._playwright.chromium.launch_persistent_context(
                    user_data_dir=str(user_data_dir),
                    headless=headless,
                    args=["--disable-blink-features=AutomationControlled"],
                    viewport={"width": 1280, "height": 900},
                )

            pages = self._context.pages
            self._page = pages[0] if pages else self._context.new_page()

        if self._page is None or self._page.is_closed():
            self._page = self._context.new_page()

        return self._page

    def _get_active_page(self, auto_ensure: bool = True) -> Any:
        """Get the active page, auto-recovering if closed or if user opened new tabs."""
        if self._page is not None and not self._page.is_closed():
            return self._page

        # Check if context has any open pages
        if self._context is not None:
            try:
                pages = self._context.pages
                if pages:
                    self._page = pages[-1]
                    return self._page
                else:
                    self._page = self._context.new_page()
                    return self._page
            except Exception as e:
                logger.debug(f"[browser] Context page recovery error: {e}")

        # Auto-ensure/connect
        if auto_ensure:
            try:
                return self._ensure_browser_sync()
            except Exception as e:
                logger.warning(f"[browser] Could not auto-ensure browser: {e}")
                return None
        return None

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

    def close(self) -> str:
        """
        Closes the active browser session.
        """
        def _task():
            try:
                if self._page and not self._page.is_closed():
                    self._page.close()
                if self._context:
                    self._context.close()
                if self._browser:
                    self._browser.close()
                if self._playwright:
                    self._playwright.stop()
            except Exception as e:
                logger.warning(f"[browser] Error during browser close: {e}")
            finally:
                self._page = None
                self._context = None
                self._browser = None
                self._playwright = None

            return "Browser session closed successfully."

        return self._run_in_worker(_task)


# Global singleton instance
browser_engine = BrowserEngine()
