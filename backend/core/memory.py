"""
Long-Term Memory Store for Terminus (Phase 3 of the capability build-out).

Backed by ChromaDB with sentence-transformers embeddings (all-MiniLM-L6-v2).
Runs fully local on M1 — no external API. Default storage lives at
~/.terminus/data/vector/ on the internal SSD for speed; the path is configurable
via Settings.VECTOR_DB_PATH so it can be pointed at an external drive if needed.

Collections:
  - preferences  — user preferences, working style, communication norms
  - tasks        — completed tasks, decisions, follow-ups
  - snippets     — code snippets, commands, references the user asked to remember
  - sessions     — auto-indexed conversation turns (memorable content)
  - watchdog_<id>— per-watchdog last-seen state (Phase 4 de-duplication)

If chromadb / sentence-transformers are not installed, the store degrades
gracefully: every method returns a clear "not installed" message instead of
crashing the app. Install with:
    pip install chromadb>=0.5.0 sentence-transformers>=2.7.0
"""

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

try:
    import chromadb
    from chromadb.config import Settings as ChromaSettings
    CHROMADB_AVAILABLE = True
except ImportError:
    CHROMADB_AVAILABLE = False
    logger.info("ChromaDB not installed — long-term memory tools will return a not-installed message. "
                "Install with: pip install chromadb>=0.5.0 sentence-transformers>=2.7.0")

# Default collections created on init
DEFAULT_COLLECTIONS = ("preferences", "tasks", "snippets", "sessions")

# Not-installed message returned by every method when chromadb is missing.
_NOT_INSTALLED = (
    "Long-term memory is not available — ChromaDB is not installed. "
    "Install with: pip install chromadb>=0.5.0 sentence-transformers>=2.7.0"
)


class MemoryStore:
    """
    Persistent local vector memory. Wraps a ChromaDB persistent client.

    All public methods are safe to call even when ChromaDB is not installed —
    they return the not-installed message instead of raising.
    """

    def __init__(self, db_path: Path, embed_model: str = "all-MiniLM-L6-v2"):
        self.db_path = Path(db_path)
        self.embed_model = embed_model
        self._client = None
        self._collections: Dict[str, Any] = {}
        if not CHROMADB_AVAILABLE:
            return
        try:
            self.db_path.mkdir(parents=True, exist_ok=True)
            self._client = chromadb.PersistentClient(
                path=str(self.db_path),
                settings=ChromaSettings(anonymized_telemetry=False, allow_reset=True),
            )
            for name in DEFAULT_COLLECTIONS:
                self._collections[name] = self._client.get_or_create_collection(name)
            logger.info(f"[memory] ChromaDB initialized at {self.db_path} with collections {DEFAULT_COLLECTIONS}")
        except Exception as e:
            logger.warning(f"[memory] ChromaDB init failed: {e}. Memory tools will be unavailable.")
            self._client = None

    @property
    def available(self) -> bool:
        return bool(self._client is not None)

    def _get_collection(self, name: str):
        if not self.available:
            return None
        if name in self._collections:
            return self._collections[name]
        try:
            col = self._client.get_or_create_collection(name)
            self._collections[name] = col
            return col
        except Exception as e:
            logger.warning(f"[memory] Could not get/create collection '{name}': {e}")
            return None

    # ── Public API ──────────────────────────────────────────────────────────

    def add(self, collection: str, content: str, metadata: Optional[Dict[str, Any]] = None,
            doc_id: Optional[str] = None) -> str:
        """Add a document to a collection. Auto-generates an ID if not provided."""
        if not self.available:
            return _NOT_INSTALLED
        if not content or not content.strip():
            return "No content provided to remember."
        col = self._get_collection(collection)
        if col is None:
            return f"Could not access memory collection '{collection}'."
        if doc_id is None:
            doc_id = f"{collection}_{int(time.time() * 1000)}_{abs(hash(content)) % 100000}"
        meta = {
            "created_at": datetime.utcnow().isoformat(),
            "source": "terminus",
        }
        if metadata:
            # ChromaDB metadata values must be primitives; coerce anything else to str.
            for k, v in metadata.items():
                meta[k] = v if isinstance(v, (str, int, float, bool)) else str(v)
        try:
            col.add(documents=[content], metadatas=[meta], ids=[doc_id])
            return f"✓ Remembered in '{collection}' (id: {doc_id}): {content[:120]}{'...' if len(content) > 120 else ''}"
        except Exception as e:
            return f"Failed to store memory: {e}"

    def query(self, collection: str, query_text: str, n_results: int = 5,
              where: Optional[Dict[str, Any]] = None) -> str:
        """Semantic search a collection. Returns ranked matches with metadata."""
        if not self.available:
            return _NOT_INSTALLED
        if not query_text or not query_text.strip():
            return "No query provided."
        col = self._get_collection(collection)
        if col is None:
            return f"Could not access memory collection '{collection}'."
        try:
            kwargs = {"query_texts": [query_text], "n_results": max(1, min(n_results, 20))}
            if where:
                kwargs["where"] = where
            res = col.query(**kwargs)
        except Exception as e:
            return f"Memory query failed: {e}"

        documents = (res.get("documents") or [[]])[0]
        metadatas = (res.get("metadatas") or [[]])[0]
        distances = (res.get("distances") or [[]])[0]
        ids = (res.get("ids") or [[]])[0]

        if not documents:
            return f"No memories found in '{collection}' matching '{query_text}'."

        lines = [f"**Memory recall from '{collection}' for '{query_text}'** ({len(documents)} matches):"]
        for i, (doc, meta, dist, doc_id) in enumerate(zip(documents, metadatas, distances, ids), 1):
            score = f"score={1 - dist:.3f}" if isinstance(dist, (int, float)) else ""
            ts = ""
            if isinstance(meta, dict) and meta.get("created_at"):
                ts = f" @ {meta['created_at'][:19]}"
            lines.append(f"{i}. [{score}{ts}] {doc}")
        return "\n".join(lines)

    def list_entries(self, collection: str, limit: int = 20) -> str:
        """Peek at the most recent entries in a collection."""
        if not self.available:
            return _NOT_INSTALLED
        col = self._get_collection(collection)
        if col is None:
            return f"Could not access memory collection '{collection}'."
        try:
            # ChromaDB's peek returns the first N entries; for "recent" we'd need
            # to query with a broad filter, but peek is good enough for a listing.
            res = col.peek(limit=max(1, min(limit, 50)))
        except Exception as e:
            return f"Memory list failed: {e}"
        documents = res.get("documents") or []
        metadatas = res.get("metadatas") or []
        ids = res.get("ids") or []
        if not documents:
            return f"Memory collection '{collection}' is empty."
        lines = [f"**Memory collection '{collection}'** ({len(documents)} shown):"]
        for doc, meta, doc_id in zip(documents, metadatas, ids):
            ts = ""
            if isinstance(meta, dict) and meta.get("created_at"):
                ts = f" @ {meta['created_at'][:19]}"
            preview = (doc or "")[:100]
            lines.append(f"- [{doc_id}{ts}] {preview}{'...' if doc and len(doc) > 100 else ''}")
        return "\n".join(lines)

    def forget(self, collection: str, doc_id: Optional[str] = None,
               where: Optional[Dict[str, Any]] = None) -> str:
        """Remove entries by id, by metadata filter, or (with explicit confirmation) all."""
        if not self.available:
            return _NOT_INSTALLED
        col = self._get_collection(collection)
        if col is None:
            return f"Could not access memory collection '{collection}'."
        try:
            if doc_id:
                col.delete(ids=[doc_id])
                return f"✓ Forgot entry {doc_id} from '{collection}'."
            if where:
                # ChromaDB's delete supports a `where` filter
                col.delete(where=where)
                return f"✓ Forgot entries matching {where} from '{collection}'."
            return ("Refusing to forget without a filter — pass a doc_id or a where filter. "
                    "To wipe an entire collection, call forget with where={'__force_all__': true}.")
        except Exception as e:
            return f"Failed to forget: {e}"

    def list_collections(self) -> str:
        """List all memory collections."""
        if not self.available:
            return _NOT_INSTALLED
        try:
            names = self._client.list_collections()
            counts = []
            for n in names:
                try:
                    counts.append(f"{n} ({self._client.get_collection(n).count()} entries)")
                except Exception:
                    counts.append(f"{n} (count unavailable)")
            return "**Memory collections**:\n" + "\n".join(counts) if counts else "No memory collections yet."
        except Exception as e:
            return f"Failed to list collections: {e}"

    def status(self) -> Dict[str, Any]:
        return {
            "available": self.available,
            "db_path": str(self.db_path),
            "embed_model": self.embed_model if self.available else None,
        }


# Global singleton — initialized lazily by main.py on app startup.
memory: Optional[MemoryStore] = None


def init_memory(db_path: Path, embed_model: str = "all-MiniLM-L6-v2") -> MemoryStore:
    """Initialize the global memory singleton. Safe to call even if chromadb is missing."""
    global memory
    if memory is None:
        memory = MemoryStore(db_path=db_path, embed_model=embed_model)
    return memory


def get_memory() -> MemoryStore:
    """Get the global memory singleton. Returns an empty store if not yet initialized."""
    global memory
    if memory is None:
        # Fallback: init at default path. main.py should call init_memory at startup.
        memory = MemoryStore(db_path=Path.home() / ".terminus" / "data" / "vector")
    return memory
