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


# Global singleton instance
macos_controller = MacOSController()
