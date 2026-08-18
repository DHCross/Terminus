"""
macOS Native OS & GUI Controller for Terminus (OpenClaw Pillar 1).

Gives Terminus system-wide computer use capabilities:
  - Screen perception & high-res desktop screenshots
  - Mouse clicking, moving, dragging, scrolling
  - Keyboard typing and keyboard shortcuts (Cmd+C, Cmd+V, Cmd+Space, etc.)
  - App launching & focusing (Notes, VS Code, Slack, Finder, System Settings, etc.)
  - AppleScript execution for native macOS control
  - Clipboard read & write (pbcopy / pbpaste)
  - Native macOS notification banners
"""

import json
import logging
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Safe screenshot output directory
SCREENSHOTS_DIR = Path.home() / ".terminus" / "screenshots"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

# Key alias mapping for Mac shortcuts
MAC_KEY_MAP = {
    "cmd": "command",
    "ctrl": "ctrl",
    "opt": "option",
    "alt": "option",
    "shift": "shift",
    "enter": "return",
    "esc": "escape",
}


class MacOSController:
    """Controls native macOS GUI, input devices, apps, and system clipboard."""

    def __init__(self):
        self.screenshots_dir = SCREENSHOTS_DIR

    def get_screen_size(self) -> Dict[str, int]:
        """Get the main display screen width and height."""
        try:
            import pyautogui
            size = pyautogui.size()
            return {"width": size.width, "height": size.height}
        except Exception as e:
            logger.warning("Could not get screen size via pyautogui: %s", e)
            return {"width": 1920, "height": 1080}

    def desktop_screenshot(self, name: Optional[str] = None, region: Optional[List[int]] = None) -> str:
        """
        Capture a full macOS desktop screenshot (or specific region [x, y, w, h]).
        Saves image to ~/.terminus/screenshots/ and returns path and resolution.
        Uses Quartz CoreGraphics and native screencapture.
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        prefix = f"desktop_{name}" if name else "desktop"
        filename = f"{prefix}_{timestamp}.png"
        filepath = self.screenshots_dir / filename

        # 1. Try Quartz CoreGraphics capture
        try:
            import Quartz
            import Quartz.CoreGraphics as CG
            from PIL import Image

            main_display_id = CG.CGMainDisplayID()
            cg_image = CG.CGDisplayCreateImage(main_display_id)
            if cg_image is not None:
                width = CG.CGImageGetWidth(cg_image)
                height = CG.CGImageGetHeight(cg_image)
                bytes_per_row = CG.CGImageGetBytesPerRow(cg_image)
                data_provider = CG.CGImageGetDataProvider(cg_image)
                raw_data = CG.CGDataProviderCopyData(data_provider)

                img = Image.frombuffer("RGBA", (width, height), raw_data, "raw", "BGRA", bytes_per_row, 1)

                if region and len(region) == 4:
                    rx, ry, rw, rh = region
                    img = img.crop((rx, ry, rx + rw, ry + rh))
                    width, height = img.size

                img.save(filepath, format="PNG")
                return (
                    f"Screenshot captured successfully!\n"
                    f"File: {filepath}\n"
                    f"Resolution: {width}x{height} px"
                )
        except Exception as e:
            logger.debug("Quartz screenshot failed, falling back to screencapture: %s", e)

        # 2. Fallback to /usr/sbin/screencapture
        try:
            cmd = ["/usr/sbin/screencapture", "-x"]
            if region and len(region) == 4:
                x, y, w, h = region
                cmd.extend(["-R", f"{x},{y},{w},{h}"])
            cmd.append(str(filepath))

            subprocess.run(cmd, check=True, timeout=10)

            width, height = 0, 0
            try:
                from PIL import Image
                with Image.open(filepath) as img:
                    width, height = img.size
            except Exception:
                pass

            return (
                f"Screenshot captured successfully!\n"
                f"File: {filepath}\n"
                f"Resolution: {width}x{height} px"
            )
        except Exception as e:
            logger.error("Desktop screenshot failed: %s", e)
            return f"Failed to take desktop screenshot: {e}"

    def desktop_click(self, x: int, y: int, button: str = "left", clicks: int = 1) -> str:
        """Click at (x, y) coordinates on screen."""
        try:
            import pyautogui
            pyautogui.click(x=x, y=y, button=button, clicks=clicks)
            action = "Double clicked" if clicks == 2 else ("Right clicked" if button == "right" else "Clicked")
            return f"{action} at coordinates ({x}, {y})"
        except Exception as e:
            logger.error("Desktop click failed: %s", e)
            return f"Failed to click at ({x}, {y}): {e}"

    def desktop_mouse_move(self, x: int, y: int) -> str:
        """Move mouse cursor smoothly to (x, y) coordinates."""
        try:
            import pyautogui
            pyautogui.moveTo(x=x, y=y, duration=0.2)
            return f"Moved mouse to ({x}, {y})"
        except Exception as e:
            return f"Failed to move mouse: {e}"

    def desktop_mouse_drag(self, x: int, y: int, button: str = "left") -> str:
        """Drag mouse cursor to (x, y) coordinates."""
        try:
            import pyautogui
            pyautogui.dragTo(x=x, y=y, button=button, duration=0.5)
            return f"Dragged mouse to ({x}, {y})"
        except Exception as e:
            return f"Failed to drag mouse: {e}"

    def desktop_scroll(self, amount: int) -> str:
        """Scroll mouse wheel (positive = up, negative = down)."""
        try:
            import pyautogui
            pyautogui.scroll(amount)
            direction = "up" if amount > 0 else "down"
            return f"Scrolled {direction} by {abs(amount)} clicks"
        except Exception as e:
            return f"Failed to scroll: {e}"

    def desktop_type(self, text: str, paste_if_multiline: bool = True) -> str:
        """
        Type text into the currently active macOS application.
        Uses clipboard paste for multiline/complex text for instant speed and emoji fidelity.
        """
        if not text:
            return "No text provided to type."
        try:
            import pyautogui
            if paste_if_multiline and ("\n" in text or len(text) > 100):
                # Paste via clipboard for reliability
                old_clip = self.clipboard_read()
                self.clipboard_write(text)
                time.sleep(0.05)
                pyautogui.hotkey("command", "v")
                time.sleep(0.05)
                return f"Pasted {len(text)} characters into active window"
            else:
                pyautogui.write(text, interval=0.01)
                return f"Typed {len(text)} characters into active window"
        except Exception as e:
            logger.error("Desktop type failed: %s", e)
            return f"Failed to type text: {e}"

    def desktop_shortcut(self, keys: List[str]) -> str:
        """
        Press a keyboard shortcut (e.g. ['command', 'space'], ['command', 'c'], ['return'], ['escape']).
        """
        if not keys:
            return "No keys provided."
        try:
            import pyautogui
            normalized_keys = [MAC_KEY_MAP.get(k.lower().strip(), k.lower().strip()) for k in keys]
            if len(normalized_keys) == 1:
                pyautogui.press(normalized_keys[0])
            else:
                pyautogui.hotkey(*normalized_keys)
            return f"Pressed shortcut: {' + '.join(keys)}"
        except Exception as e:
            logger.error("Desktop shortcut failed: %s", e)
            return f"Failed to press shortcut {keys}: {e}"

    def app_launch(self, app_name: str) -> str:
        """Launch or open a macOS application by name (e.g. 'Notes', 'Visual Studio Code', 'Slack', 'Finder')."""
        if not app_name.strip():
            return "No app name provided."
        try:
            subprocess.run(["open", "-a", app_name.strip()], check=True, timeout=10)
            return f"Launched/brought to front: {app_name}"
        except Exception as e:
            return f"Failed to launch app '{app_name}': {e}"

    def app_focus(self, app_name: str) -> str:
        """Activate/focus a macOS application window using AppleScript."""
        if not app_name.strip():
            return "No app name provided."
        script = f'tell application "{app_name.strip()}" to activate'
        return self.applescript_run(script)

    def applescript_run(self, script: str) -> str:
        """
        Execute arbitrary AppleScript code on macOS to control apps, Finder, System Settings, etc.
        """
        if not script.strip():
            return "No AppleScript provided."
        try:
            result = subprocess.run(
                ["/usr/bin/osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=15,
            )
            out = result.stdout.strip()
            err = result.stderr.strip()
            if result.returncode != 0:
                return f"AppleScript error: {err or 'Unknown error'}"
            return out if out else "AppleScript executed successfully."
        except subprocess.TimeoutExpired:
            return "AppleScript timed out after 15 seconds."
        except Exception as e:
            return f"Failed to execute AppleScript: {e}"

    def clipboard_read(self) -> str:
        """Read current text content from macOS clipboard."""
        try:
            result = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, text=True, timeout=5)
            text = result.stdout
            if not text:
                return "(Clipboard is empty)"
            if len(text) > 4000:
                return text[:4000] + f"\n\n[... {len(text) - 4000} chars truncated]"
            return text
        except Exception as e:
            return f"Failed to read clipboard: {e}"

    def clipboard_write(self, text: str) -> str:
        """Write text content into macOS clipboard."""
        try:
            subprocess.run(["/usr/bin/pbcopy"], input=text, text=True, check=True, timeout=5)
            return f"Copied {len(text)} characters to clipboard."
        except Exception as e:
            return f"Failed to write to clipboard: {e}"

    def system_notify(self, title: str, message: str) -> str:
        """Display a native macOS notification banner."""
        title_clean = title.replace('"', '\\"')
        msg_clean = message.replace('"', '\\"')
        script = f'display notification "{msg_clean}" with title "{title_clean}"'
        return self.applescript_run(script)

    # ── Active-window context (Pillar 1 extension) ──────────────────────────

    def ax_status(self) -> Dict[str, Any]:
        """
        Report whether the host process has Accessibility (AX) permission.
        Reading UI elements of other apps requires the Terminal / uvicorn host
        app to be granted Accessibility in System Settings → Privacy & Security
        → Accessibility. This probe tells us whether read_active_window /
        list_windows will work or will return a permission error.
        """
        # Use the lightest possible System Events query — asking for the name of
        # the frontmost process. Heavier queries (e.g. counting UI elements) can
        # hang for the full timeout when AX is not granted, because macOS pops a
        # permission dialog and blocks osascript. This lighter query either
        # returns immediately (AX granted) or fails fast (AX denied).
        try:
            script = (
                'tell application "System Events" to '
                'name of (first process whose frontmost is true)'
            )
            result = subprocess.run(
                ["/usr/bin/osascript", "-e", script],
                capture_output=True, text=True, timeout=3,
            )
            err = result.stderr.strip()
            out = result.stdout.strip()
            if result.returncode == 0 and out and "not authorized" not in err.lower():
                return {
                    "granted": True,
                    "frontmost_app": out,
                    "detail": "OK",
                }
            return {
                "granted": False,
                "frontmost_app": None,
                "detail": err or "AX probe returned no output",
            }
        except subprocess.TimeoutExpired:
            return {
                "granted": False,
                "frontmost_app": None,
                "detail": "AX probe timed out — permission likely not granted (grant the host app in System Settings → Privacy & Security → Accessibility)",
            }
        except Exception as e:
            return {"granted": False, "frontmost_app": None, "detail": f"probe failed: {e}"}

    def list_windows(self, app_name: Optional[str] = None) -> str:
        """
        Enumerate the open windows of an app (or the frontmost app if app_name is None).
        Returns one line per window with its index and title, so the agent can pick
        which window to read with read_active_window.
        """
        if app_name and not app_name.strip():
            app_name = None
        try:
            if app_name:
                # Verify the app is running
                script_check = f'tell application "System Events" to (count (processes whose name is "{app_name}")) > 0'
                r = subprocess.run(["/usr/bin/osascript", "-e", script_check],
                                   capture_output=True, text=True, timeout=4)
                if r.returncode != 0 or r.stdout.strip() != "true":
                    return f"Application '{app_name}' is not running."
                script = (
                    f'tell application "System Events" to tell process "{app_name}"\n'
                    '  set out to ""\n'
                    '  set i to 1\n'
                    '  repeat with w in windows\n'
                    '    set out to out & "[" & i & "] " & (name of w) & linefeed\n'
                    '    set i to i + 1\n'
                    '  end repeat\n'
                    '  return out\n'
                    'end tell'
                )
            else:
                script = (
                    'tell application "System Events"\n'
                    '  set p to first process whose frontmost is true\n'
                    '  set out to ""\n'
                    '  set i to 1\n'
                    '  repeat with w in windows of p\n'
                    '    set out to out & "[" & i & "] " & (name of p) & " — " & (name of w) & linefeed\n'
                    '    set i to i + 1\n'
                    '  end repeat\n'
                    '  return out\n'
                    'end tell'
                )
            result = subprocess.run(["/usr/bin/osascript", "-e", script],
                                    capture_output=True, text=True, timeout=6)
            out = result.stdout.strip()
            err = result.stderr.strip()
            if result.returncode != 0:
                if "not authorized" in err.lower() or "assistive" in err.lower():
                    return (
                        f"Accessibility permission denied — grant it to your Terminal/uvicorn host in "
                        f"System Settings → Privacy & Security → Accessibility. Detail: {err}"
                    )
                return f"Could not list windows: {err or 'unknown error'}"
            if not out:
                return f"No open windows for {'app ' + app_name if app_name else 'frontmost app'}."
            header = f"**Open windows of {app_name if app_name else 'frontmost app'}**:\n"
            return header + out
        except subprocess.TimeoutExpired:
            return "Listing windows timed out."
        except Exception as e:
            return f"Failed to list windows: {e}"

    def read_active_window(self, app_name: Optional[str] = None, window_index: int = 1) -> str:
        """
        Read the visible text content of the frontmost window of an app (or of a
        specific window by 1-based index). Uses AppleScript + System Events AX
        queries with per-app fallbacks for Safari, Chrome, Mail, Notes, TextEdit.

        Requires Accessibility permission for the host process (see ax_status).
        """
        if app_name and not app_name.strip():
            app_name = None
        if window_index < 1:
            window_index = 1

        # Per-app extraction strategies. Each returns the visible text of the
        # target window, or raises/returns None to fall through to the generic
        # System Events UI-element walk.
        def _try_applescript_app(script: str) -> Optional[str]:
            try:
                r = subprocess.run(["/usr/bin/osascript", "-e", script],
                                   capture_output=True, text=True, timeout=10)
                if r.returncode == 0:
                    return r.stdout
                err = r.stderr.strip()
                if "not authorized" in err.lower() or "assistive" in err.lower():
                    raise PermissionError(err)
                return None
            except subprocess.TimeoutExpired:
                return None

        # 1. App-specific content queries (preferred — clean text, no AX walk)
        if app_name:
            app_lower = app_name.lower()
            if "safari" in app_lower:
                script = (
                    f'tell application "{app_name}"\n'
                    f'  if (count windows) >= {window_index} then\n'
                    f'    return text of document 1 of window {window_index}\n'
                    f'  end if\n'
                    f'end tell'
                )
                out = _try_applescript_app(script)
                if out:
                    return f"**{app_name} — window {window_index}**:\n{out[:8000]}"
            elif "chrome" in app_lower or "edge" in app_lower or "brave" in app_lower:
                # Chrome's AppleScript exposes tab content via `execute javascript`.
                script = (
                    f'tell application "{app_name}"\n'
                    f'  if (count windows) >= {window_index} then\n'
                    f'    set t to active tab of window {window_index}\n'
                    f'    return execute t javascript "document.body.innerText.slice(0, 8000)"\n'
                    f'  end if\n'
                    f'end tell'
                )
                out = _try_applescript_app(script)
                if out:
                    return f"**{app_name} — window {window_index} (active tab)**:\n{out}"
            elif "notes" in app_lower:
                script = (
                    f'tell application "{app_name}"\n'
                    f'  if (count windows) >= {window_index} then\n'
                    f'    return body of note 1 of window {window_index}\n'
                    f'  end if\n'
                    f'end tell'
                )
                out = _try_applescript_app(script)
                if out:
                    return f"**{app_name} — window {window_index}**:\n{out[:8000]}"
            elif "textedit" in app_lower or "pages" in app_lower:
                script = (
                    f'tell application "{app_name}"\n'
                    f'  if (count windows) >= {window_index} then\n'
                    f'    return text of document 1 of window {window_index}\n'
                    f'  end if\n'
                    f'end tell'
                )
                out = _try_applescript_app(script)
                if out:
                    return f"**{app_name} — window {window_index}**:\n{out[:8000]}"
            elif "mail" in app_lower:
                script = (
                    f'tell application "{app_name}"\n'
                    f'  if (count windows) >= {window_index} then\n'
                    f'    set mv to message viewer 1 of window {window_index}\n'
                    f'    set sel to selected messages of mv\n'
                    f'    if (count of sel) > 0 then\n'
                    f'      set m to item 1 of sel\n'
                    f'      return "Subject: " & (subject of m) & linefeed & "From: " & (sender of m) & linefeed & linefeed & (content of m)\n'
                    f'    else\n'
                    f'      return "No message selected in Mail window {window_index}."\n'
                    f'    end if\n'
                    f'  end if\n'
                    f'end tell'
                )
                out = _try_applescript_app(script)
                if out:
                    return f"**{app_name} — window {window_index}**:\n{out[:8000]}"

        # 2. Generic fallback: walk the window's UI elements via System Events.
        #    Requires AX permission. Returns concatenated text of text areas /
        #    static texts. Works in many apps but is messier than the per-app paths.
        try:
            if app_name:
                proc_clause = f'process "{app_name}"'
            else:
                proc_clause = '(first process whose frontmost is true)'
            script = (
                'tell application "System Events"\n'
                f'  tell {proc_clause}\n'
                f'    if (count windows) < {window_index} then return ""\n'
                f'    set w to window {window_index}\n'
                '    set out to ""\n'
                '    try\n'
                '      repeat with el in (UI elements of w)\n'
                '    try\n'
                '      set out to out & (value of (first text area of el)) & linefeed\n'
                '    end try\n'
                '    try\n'
                '      set out to out & (value of el as text) & linefeed\n'
                '    end try\n'
                '    try\n'
                '      repeat with st in (static texts of el)\n'
                '        set out to out & (value of st) & linefeed\n'
                '      end repeat\n'
                '    end try\n'
                '  end repeat\n'
                '    end try\n'
                '    return out\n'
                '  end tell\n'
                'end tell'
            )
            r = subprocess.run(["/usr/bin/osascript", "-e", script],
                               capture_output=True, text=True, timeout=10)
            out = r.stdout.strip()
            err = r.stderr.strip()
            if r.returncode != 0:
                if "not authorized" in err.lower() or "assistive" in err.lower():
                    return (
                        "Accessibility permission denied — grant it to your Terminal/uvicorn host in "
                        "System Settings → Privacy & Security → Accessibility, then try again. "
                        f"Detail: {err}"
                    )
                return f"Could not read window via AX: {err}"
            if out:
                return f"**{app_name or 'frontmost app'} — window {window_index}**:\n{out[:8000]}"
        except Exception as e:
            logger.debug(f"[macos] AX window walk failed: {e}")

        # 3. Last resort: screenshot + tell the agent to use vision.
        try:
            shot = self.desktop_screenshot(name=f"active_window_{int(time.time())}")
            return (
                f"Could not extract text from the active window via AppleScript/AX. "
                f"Took a screenshot instead — use the desktop_screenshot tool or read the image:\n{shot}"
            )
        except Exception as e:
            return f"Failed to read active window and screenshot fallback also failed: {e}"

    def read_selection(self) -> str:
        """
        Read the currently selected text in whatever app is frontmost, by
        simulating Cmd+C into the clipboard and reading it back. The prior
        clipboard contents are restored afterwards so this is non-destructive.

        This works in any app that supports standard copy — no Accessibility
        permission required.
        """
        try:
            import pyautogui
            old_clip = self.clipboard_read()
            # Clear clipboard first so we can detect "nothing was selected"
            self.clipboard_write("")
            time.sleep(0.05)
            pyautogui.hotkey("command", "c")
            time.sleep(0.25)  # give the frontmost app time to populate the clipboard
            new_text = self.clipboard_read()
            # Restore prior clipboard
            try:
                if old_clip and old_clip != "(Clipboard is empty)":
                    self.clipboard_write(old_clip)
            except Exception:
                pass
            if not new_text or new_text == "(Clipboard is empty)":
                return "No text is currently selected in the frontmost application."
            if len(new_text) > 8000:
                return new_text[:8000] + f"\n\n[... {len(new_text) - 8000} chars truncated]"
            return new_text
        except Exception as e:
            logger.error("[macos] read_selection failed: %s", e)
            return f"Failed to read selection: {e}"


# Global singleton instance
macos_controller = MacOSController()
