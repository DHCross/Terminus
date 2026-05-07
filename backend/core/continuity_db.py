"""
Terminus Continuity Database Schema & Initialization
"""
import sqlite3
from pathlib import Path
from datetime import datetime
import json
from typing import Optional


class ContinuityDB:
    """SQLite database for Terminus continuity and memory"""
    
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
    
    def init_schema(self):
        """Create tables if they don't exist"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Conversations table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                metadata TEXT  -- JSON: settings, personas, etc.
            )
        ''')
        
        # Messages table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,  -- 'user' or 'assistant'
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                metadata TEXT,  -- JSON: tokens, model, etc.
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        ''')
        
        # Activity log (for continuity/memory)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT,
                event_type TEXT NOT NULL,  -- 'message', 'task', 'journal', etc.
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                metadata TEXT,  -- JSON
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        ''')
        
        # Traces (for reasoning/debugging)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS traces (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
                trace_type TEXT NOT NULL,  -- 'reasoning', 'error', etc.
                data TEXT NOT NULL,  -- JSON
                timestamp TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        ''')
        
        # Indexes for performance
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_activity_log_conv ON activity_log(conversation_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_activity_log_event ON activity_log(event_type)')
        
        conn.commit()
        conn.close()
    
    def add_conversation(self, conv_id: str, name: str, metadata: Optional[dict] = None) -> bool:
        """Add a new conversation"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        now = datetime.utcnow().isoformat()
        try:
            cursor.execute('''
                INSERT INTO conversations (id, name, created_at, updated_at, metadata)
                VALUES (?, ?, ?, ?, ?)
            ''', (conv_id, name, now, now, json.dumps(metadata or {})))
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False
        finally:
            conn.close()
    
    def add_message(self, msg_id: str, conv_id: str, role: str, content: str, 
                   timestamp: Optional[str] = None, metadata: Optional[dict] = None) -> bool:
        """Add a message to a conversation"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if timestamp is None:
            timestamp = datetime.utcnow().isoformat()
        
        # Ensure metadata is JSON-serializable
        if metadata:
            try:
                metadata_str = json.dumps(metadata)
            except (TypeError, ValueError):
                # If metadata contains non-serializable types, convert to string
                metadata_str = json.dumps({"raw": str(metadata)})
        else:
            metadata_str = json.dumps({})
        
        try:
            cursor.execute('''
                INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (msg_id, conv_id, role, content, timestamp, metadata_str))
            
            # Update conversation timestamp
            cursor.execute('''
                UPDATE conversations SET updated_at = ? WHERE id = ?
            ''', (datetime.utcnow().isoformat(), conv_id))
            
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False
        finally:
            conn.close()
    
    def get_conversation_messages(self, conv_id: str) -> list:
        """Get all messages for a conversation"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT role, content FROM messages 
            WHERE conversation_id = ?
            ORDER BY timestamp ASC
        ''', (conv_id,))
        
        messages = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return messages
    
    def get_all_conversations(self) -> list:
        """Get all conversations"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT id, name, created_at, updated_at FROM conversations
            ORDER BY updated_at DESC
        ''')
        
        conversations = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return conversations
