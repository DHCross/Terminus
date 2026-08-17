"""
Bitwarden Scoped Vault Integration for Terminus.

Strict security boundary:
- ONLY accesses items located within the Bitwarden folder named "Terminus" (case-insensitive).
- Refuses to query or return any items from other folders (e.g. Personal, Financial, Primary Email).
- Verifies session unlock status via `bw status`.
"""

import json
import logging
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

ALLOWED_FOLDER_NAME = "Terminus"


class BitwardenVault:
    """Scoped access to Bitwarden credentials restricted strictly to the Terminus folder."""

    def __init__(self):
        self.allowed_folder_name = ALLOWED_FOLDER_NAME

    def _get_bw_path(self) -> Optional[str]:
        return shutil.which("bw")

    def get_status(self) -> Dict[str, Any]:
        """Check if Bitwarden CLI is installed and unlocked."""
        bw_path = self._get_bw_path()
        if not bw_path:
            return {
                "installed": False,
                "status": "not_installed",
                "message": "Bitwarden CLI ('bw') is not installed. Install it with: brew install bitwarden-cli or npm install -g @bitwarden/cli",
            }

        session_key = os.environ.get("BW_SESSION", "").strip()
        try:
            res = subprocess.run([bw_path, "status"], capture_output=True, text=True, timeout=5)
            if res.returncode == 0:
                data = json.loads(res.stdout)
                status = data.get("status", "unknown")
                return {
                    "installed": True,
                    "status": status,
                    "user_email": data.get("userEmail"),
                    "session_env_set": bool(session_key),
                    "message": f"Bitwarden vault status: {status}",
                }
            return {"installed": True, "status": "error", "message": res.stderr.strip()}
        except Exception as e:
            return {"installed": True, "status": "error", "message": str(e)}

    def get_login(self, service: str) -> str:
        """
        Query a credential from Bitwarden.
        STRICT SECURITY ENFORCEMENT: Only returns items inside the 'Terminus' folder.
        """
        bw_path = self._get_bw_path()
        if not bw_path:
            return (
                "Bitwarden CLI ('bw') is not installed on this system. "
                "To enable CLI vault lookups, install it with `brew install bitwarden-cli`."
            )

        clean_service = service.strip()
        if not clean_service:
            return "No service name provided to bitwarden_get_login."

        session_key = os.environ.get("BW_SESSION", "").strip()

        try:
            # 1. Find folder ID for 'Terminus'
            folder_cmd = [bw_path, "list", "folders"]
            if session_key:
                folder_cmd.extend(["--session", session_key])

            f_res = subprocess.run(folder_cmd, capture_output=True, text=True, timeout=10)
            if f_res.returncode != 0 or not f_res.stdout.strip():
                err_msg = f_res.stderr.strip() or f_res.stdout.strip()
                if "Vault is locked" in err_msg or "unauthenticated" in err_msg or not f_res.stdout.strip():
                    return (
                        "Bitwarden vault is currently locked or unauthenticated. "
                        "Please run `export BW_SESSION=$(bw unlock --raw)` in your terminal session."
                    )
                return f"Bitwarden folder lookup failed: {err_msg}"

            folders = json.loads(f_res.stdout)
            terminus_folder_id = None
            for f in folders:
                if (f.get("name") or "").strip().lower() == self.allowed_folder_name.lower():
                    terminus_folder_id = f.get("id")
                    break

            if not terminus_folder_id:
                return (
                    f"Security boundary alert: No folder named '{self.allowed_folder_name}' found in your Bitwarden vault.\n"
                    f"Terminus is strictly forbidden from accessing credentials outside the '{self.allowed_folder_name}' folder.\n"
                    f"Please create a folder named '{self.allowed_folder_name}' in Bitwarden and place automation logins in it."
                )

            # 2. Search items
            cmd = [bw_path, "list", "items", "--search", clean_service]
            if session_key:
                cmd.extend(["--session", session_key])

            res = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            if res.returncode != 0:
                return f"Bitwarden search error: {res.stderr.strip()}"

            items = json.loads(res.stdout)
            if not items:
                return f"No credential found matching '{clean_service}' in Bitwarden."

            # 3. Strictly filter for items in the Terminus folder
            allowed_items = [item for item in items if item.get("folderId") == terminus_folder_id]

            if not allowed_items:
                return (
                    f"Security Block: Found {len(items)} item(s) matching '{clean_service}', but NONE of them are in the "
                    f"'{self.allowed_folder_name}' folder.\n"
                    f"Terminus is strictly barred from accessing credentials outside the '{self.allowed_folder_name}' folder.\n"
                    f"To grant Terminus access to this login, move it into your Bitwarden '{self.allowed_folder_name}' folder."
                )

            match = allowed_items[0]
            login_data = match.get("login", {})
            username = login_data.get("username", "")
            password = login_data.get("password", "")
            uris = [u.get("uri") for u in login_data.get("uris", []) if u.get("uri")]

            return json.dumps({
                "status": "success",
                "folder": self.allowed_folder_name,
                "item_name": match.get("name"),
                "username": username,
                "password": password,
                "uris": uris
            }, indent=2)

        except Exception as e:
            logger.error(f"[bitwarden] Error fetching login: {e}")
            return f"Error querying Bitwarden vault: {str(e)}"


bitwarden_vault = BitwardenVault()
