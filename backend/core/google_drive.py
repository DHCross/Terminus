"""
Google Drive & Workspace connector for Terminus.

Uses OAuth2 with the same client credentials already set up in the
Computer/chat-auto-responder project (client ID 869440988645-...).

Token is stored locally at ~/.terminus/google_token.json after the
one-time browser consent flow.  Subsequent restarts reuse the cached
refresh token — no browser needed again.

Capabilities exposed as Terminus tools:
  gdrive_search(query, max_results)   – full-text search across Drive
  gdrive_list(folder_id)              – list files in a folder
  gdrive_read(file_id_or_name)        – read/export file content
  gdrive_upload(name, content, folder_id)  – create/update a Doc or plain file
  gdrive_create_doc(title, content, folder_id)  – create a Google Doc
"""

from __future__ import annotations

import json
import logging
import os
import webbrowser
from pathlib import Path
from threading import Lock
from typing import Any

logger = logging.getLogger(__name__)

# ── OAuth constants ────────────────────────────────────────────────────────────

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets",
]

CLIENT_SECRET_PATH = Path(
    "/Users/dancross/Dev/GitHub/Computer/"
    "client_secret_869440988645-ee5cobnrcnpn4m3fumetohaq1v1pl977"
    ".apps.googleusercontent.com.json"
)

TOKEN_PATH = Path.home() / ".terminus" / "google_token.json"

REDIRECT_URI = "http://localhost:3000/oauth2callback"

_creds_lock = Lock()


# ── Auth helpers ───────────────────────────────────────────────────────────────

def _load_client_secrets() -> dict:
    if not CLIENT_SECRET_PATH.exists():
        raise FileNotFoundError(
            f"Google OAuth client secret not found at {CLIENT_SECRET_PATH}. "
            "Please copy the file from the Computer repo or update CLIENT_SECRET_PATH."
        )
    data = json.loads(CLIENT_SECRET_PATH.read_text())
    # Supports both 'web' and 'installed' credential types
    return data.get("web") or data.get("installed") or {}


def get_credentials():
    """
    Return a valid google.oauth2.credentials.Credentials object.

    On first call (no token file) this runs a local callback server on port 3000
    at /oauth2callback — matching the URI registered in the Google Cloud Console.
    Subsequent calls load and auto-refresh the cached token from
    ~/.terminus/google_token.json.
    """
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    import urllib.parse
    import http.server
    import threading
    import webbrowser

    with _creds_lock:
        creds = None

        # Load existing token
        if TOKEN_PATH.exists():
            try:
                creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
            except Exception as e:
                logger.warning("Could not load cached Google token: %s", e)
                creds = None

        # Refresh expired token
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                TOKEN_PATH.write_text(creds.to_json())
                return creds
            except Exception as e:
                logger.warning("Token refresh failed (%s), re-authorising…", e)
                creds = None

        if creds and creds.valid:
            return creds

        # ── First-time auth: local callback server flow ────────────────────
        from google_auth_oauthlib.flow import Flow

        secrets = _load_client_secrets()
        client_config = {
            "web": {
                "client_id": secrets["client_id"],
                "client_secret": secrets["client_secret"],
                "auth_uri": secrets.get("auth_uri", "https://accounts.google.com/o/oauth2/auth"),
                "token_uri": secrets.get("token_uri", "https://oauth2.googleapis.com/token"),
                "redirect_uris": ["http://localhost:3000/oauth2callback"],
            }
        }

        flow = Flow.from_client_config(
            client_config,
            scopes=SCOPES,
            redirect_uri="http://localhost:3000/oauth2callback",
        )

        auth_url, _ = flow.authorization_url(
            access_type="offline",
            prompt="consent",
        )

        # Shared state for the callback
        auth_code: list[str] = []
        server_done = threading.Event()

        class CallbackHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path == "/oauth2callback":
                    params = urllib.parse.parse_qs(parsed.query)
                    code = params.get("code", [None])[0]
                    if code:
                        auth_code.append(code)
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html")
                        self.end_headers()
                        self.wfile.write(b"""
                        <html><body style='font-family:sans-serif;text-align:center;padding:60px'>
                        <h2>&#10003; Terminus is connected to Google Drive!</h2>
                        <p>You can close this tab and return to your session.</p>
                        </body></html>""")
                    else:
                        self.send_response(400)
                        self.end_headers()
                        self.wfile.write(b"Auth failed - no code returned.")
                    server_done.set()
                else:
                    self.send_response(302)
                    self.send_header("Location", auth_url)
                    self.end_headers()

            def log_message(self, format, *args):
                pass  # Silence request logs

        httpd = http.server.HTTPServer(("localhost", 3000), CallbackHandler)
        httpd.timeout = 120  # 2 minutes to complete auth

        logger.info("Opening browser for Google OAuth consent...")
        print(f"\nOpening your browser for Google OAuth consent.\n"
              f"   If it doesn't open automatically, visit:\n   {auth_url}\n")
        webbrowser.open(auth_url)

        # Serve until callback received or timeout
        while not server_done.is_set():
            httpd.handle_request()
        httpd.server_close()

        if not auth_code:
            raise RuntimeError("Google OAuth flow timed out or was cancelled.")

        # Allow Google to return a broader scope set (e.g. previously-granted
        # scopes from other apps on the same account) without raising an error.
        os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
        flow.fetch_token(code=auth_code[0])
        creds = flow.credentials

        # Persist
        TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_PATH.write_text(creds.to_json())
        logger.info("Google OAuth token saved to %s", TOKEN_PATH)
        return creds



def _drive_service():
    from googleapiclient.discovery import build
    return build("drive", "v3", credentials=get_credentials(), cache_discovery=False)


def _docs_service():
    from googleapiclient.discovery import build
    return build("docs", "v1", credentials=get_credentials(), cache_discovery=False)


# ── Tool implementations ───────────────────────────────────────────────────────

def gdrive_search(query: str, max_results: int = 10) -> str:
    """Full-text search across the user's Google Drive."""
    if not query.strip():
        return "No search query provided."
    try:
        service = _drive_service()
        q = f"fullText contains '{query.replace(chr(39), '')}' and trashed = false"
        resp = service.files().list(
            q=q,
            pageSize=max(1, min(max_results, 50)),
            fields="files(id, name, mimeType, modifiedTime, webViewLink, parents)",
        ).execute()
        files = resp.get("files", [])
        if not files:
            return f"No Drive files found matching: {query}"
        lines = [f"Drive search results for '{query}' ({len(files)} found):\n"]
        for f in files:
            mt = _friendly_mime(f.get("mimeType", ""))
            modified = f.get("modifiedTime", "")[:10]
            lines.append(
                f"• {f['name']} [{mt}] — modified {modified}\n"
                f"  ID: {f['id']}\n"
                f"  Link: {f.get('webViewLink', 'n/a')}\n"
            )
        return "\n".join(lines)
    except Exception as e:
        return f"Google Drive search failed: {e}"


def gdrive_list(folder_id: str = "root", max_results: int = 50) -> str:
    """List files inside a Drive folder (default: My Drive root)."""
    try:
        service = _drive_service()
        q = f"'{folder_id}' in parents and trashed = false"
        resp = service.files().list(
            q=q,
            pageSize=max(1, min(max_results, 100)),
            orderBy="folder,name",
            fields="files(id, name, mimeType, modifiedTime, webViewLink)",
        ).execute()
        files = resp.get("files", [])
        if not files:
            return f"No files found in folder: {folder_id}"
        lines = [f"Files in {'My Drive' if folder_id == 'root' else folder_id} ({len(files)} items):\n"]
        for f in files:
            icon = "📁" if "folder" in f.get("mimeType", "") else "📄"
            mt = _friendly_mime(f.get("mimeType", ""))
            lines.append(f"{icon} {f['name']} [{mt}] — ID: {f['id']}")
        return "\n".join(lines)
    except Exception as e:
        return f"Google Drive list failed: {e}"


def gdrive_read(file_id: str) -> str:
    """
    Read/export file content from Google Drive.
    For Google Docs/Sheets/Slides the content is exported to plain text or CSV.
    For binary files a summary is returned.
    """
    if not file_id.strip():
        return "No file ID provided."
    try:
        service = _drive_service()
        # Get file metadata
        meta = service.files().get(
            fileId=file_id,
            fields="id, name, mimeType, size, modifiedTime",
        ).execute()
        name = meta.get("name", "unknown")
        mime = meta.get("mimeType", "")

        # Google Workspace types — export as plain text
        EXPORT_MAP = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "text/plain",
        }
        if mime in EXPORT_MAP:
            content = service.files().export(
                fileId=file_id, mimeType=EXPORT_MAP[mime]
            ).execute()
            text = content.decode("utf-8") if isinstance(content, bytes) else str(content)
            if len(text) > 8000:
                text = text[:8000] + f"\n\n[… {len(text) - 8000} more chars truncated]"
            return f"**{name}** (Google {_friendly_mime(mime)}):\n\n{text}"

        # Plain text / markdown / JSON
        if any(t in mime for t in ("text/", "json", "xml", "javascript")):
            content = service.files().get_media(fileId=file_id).execute()
            text = content.decode("utf-8") if isinstance(content, bytes) else str(content)
            if len(text) > 8000:
                text = text[:8000] + f"\n\n[… {len(text) - 8000} more chars truncated]"
            return f"**{name}** ({mime}):\n\n{text}"

        # Binary — just describe it
        size = meta.get("size", "unknown")
        modified = meta.get("modifiedTime", "")[:10]
        return (
            f"**{name}** is a binary file ({_friendly_mime(mime)}, {size} bytes).\n"
            f"Last modified: {modified}\n"
            "Binary content cannot be displayed as text. "
            "Use gdrive_download_url to get a browser link instead."
        )
    except Exception as e:
        return f"Google Drive read failed: {e}"


def gdrive_upload(name: str, content: str, folder_id: str = "") -> str:
    """
    Create or update a plain-text file in Google Drive.
    If a file with the same name already exists in the folder it will be updated.
    """
    if not name.strip():
        return "No file name provided."
    try:
        from googleapiclient.http import MediaInMemoryUpload
        service = _drive_service()

        # Check if file already exists
        q = f"name = '{name}' and trashed = false"
        if folder_id:
            q += f" and '{folder_id}' in parents"
        existing = service.files().list(q=q, fields="files(id, name)").execute().get("files", [])

        media = MediaInMemoryUpload(
            content.encode("utf-8"),
            mimetype="text/plain",
            resumable=False,
        )
        if existing:
            file_id = existing[0]["id"]
            service.files().update(fileId=file_id, media_body=media).execute()
            return f"Updated '{name}' in Google Drive (ID: {file_id})."
        else:
            metadata: dict[str, Any] = {"name": name}
            if folder_id:
                metadata["parents"] = [folder_id]
            result = service.files().create(
                body=metadata, media_body=media, fields="id, name, webViewLink"
            ).execute()
            return (
                f"Created '{result['name']}' in Google Drive.\n"
                f"ID: {result['id']}\n"
                f"Link: {result.get('webViewLink', 'n/a')}"
            )
    except Exception as e:
        return f"Google Drive upload failed: {e}"


def gdrive_create_doc(title: str, content: str = "", folder_id: str = "") -> str:
    """
    Create a new Google Doc with the given title and optional initial content.
    """
    if not title.strip():
        return "No document title provided."
    try:
        service = _drive_service()
        docs = _docs_service()

        # Create the Doc
        doc_meta = {"name": title, "mimeType": "application/vnd.google-apps.document"}
        if folder_id:
            doc_meta["parents"] = [folder_id]
        doc = service.files().create(body=doc_meta, fields="id, webViewLink").execute()
        doc_id = doc["id"]

        # Insert initial content if supplied
        if content.strip():
            docs.documents().batchUpdate(
                documentId=doc_id,
                body={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
            ).execute()

        return (
            f"Google Doc '{title}' created.\n"
            f"ID: {doc_id}\n"
            f"Link: {doc.get('webViewLink', f'https://docs.google.com/document/d/{doc_id}/edit')}"
        )
    except Exception as e:
        return f"Google Doc creation failed: {e}"


def gdrive_auth_status() -> str:
    """Check and report Google Drive authentication status."""
    if not CLIENT_SECRET_PATH.exists():
        return (
            "❌ Google OAuth client secret not found.\n"
            f"Expected at: {CLIENT_SECRET_PATH}"
        )
    if TOKEN_PATH.exists():
        try:
            from google.oauth2.credentials import Credentials
            creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
            if creds.valid:
                return "✅ Google Drive authenticated and token is valid."
            elif creds.expired and creds.refresh_token:
                return "⚠️ Token is expired but has a refresh token — will auto-refresh on next use."
            else:
                return "❌ Token found but is invalid. Run gdrive_auth to re-authenticate."
        except Exception as e:
            return f"❌ Token file is corrupted: {e}"
    return (
        "⚠️ Not yet authenticated with Google Drive.\n"
        "Call gdrive_auth to open the browser consent flow."
    )


# ── Mime type helpers ──────────────────────────────────────────────────────────

def _friendly_mime(mime: str) -> str:
    MAP = {
        "application/vnd.google-apps.document": "Google Doc",
        "application/vnd.google-apps.spreadsheet": "Google Sheet",
        "application/vnd.google-apps.presentation": "Google Slides",
        "application/vnd.google-apps.folder": "Folder",
        "application/pdf": "PDF",
        "text/plain": "Text",
        "text/csv": "CSV",
        "application/json": "JSON",
        "image/png": "PNG Image",
        "image/jpeg": "JPEG Image",
    }
    return MAP.get(mime, mime.split("/")[-1] if "/" in mime else mime)
