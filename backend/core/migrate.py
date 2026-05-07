#!/usr/bin/env python3
"""
Migration script: Sapphire SQLite → Terminus SQLite
Migrates conversation history and data from Sapphire's database to Terminus's schema
"""
import sqlite3
import json
from pathlib import Path
import uuid
from datetime import datetime
import sys

# Import Terminus continuity DB
from core.continuity_db import ContinuityDB


def migrate_from_sapphire(
    sapphire_db_path: Path,
    terminus_db_path: Path,
    backup: bool = True
) -> dict:
    """
    Migrate data from Sapphire to Terminus
    
    Args:
        sapphire_db_path: Path to Sapphire's sapphire_history.db
        terminus_db_path: Path where Terminus continuity.db will be created
        backup: Whether to backup Sapphire DB before migration
        
    Returns:
        Migration statistics
    """
    
    if not sapphire_db_path.exists():
        raise FileNotFoundError(f"Sapphire DB not found: {sapphire_db_path}")
    
    # Backup Sapphire DB if requested
    if backup:
        backup_path = sapphire_db_path.parent / f"{sapphire_db_path.name}.backup"
        import shutil
        shutil.copy2(sapphire_db_path, backup_path)
        print(f"✓ Backed up Sapphire DB to {backup_path}")
    
    # Initialize Terminus DB
    terminus_db = ContinuityDB(terminus_db_path)
    terminus_db.init_schema()
    print(f"✓ Initialized Terminus continuity DB at {terminus_db_path}")
    
    # Connect to Sapphire DB
    sapphire_conn = sqlite3.connect(sapphire_db_path)
    sapphire_conn.row_factory = sqlite3.Row
    sapphire_cursor = sapphire_conn.cursor()
    
    stats = {
        "conversations_migrated": 0,
        "messages_migrated": 0,
        "errors": []
    }
    
    try:
        # Get all conversations from Sapphire
        sapphire_cursor.execute('SELECT * FROM chats')
        chats = sapphire_cursor.fetchall()
        
        for chat in chats:
            try:
                chat_name = chat['name']
                
                # Create conversation in Terminus
                conv_id = str(uuid.uuid4())
                metadata = {}
                
                if chat['settings']:
                    try:
                        metadata = json.loads(chat['settings'])
                    except:
                        pass
                
                terminus_db.add_conversation(conv_id, chat_name, metadata)
                stats["conversations_migrated"] += 1
                
                # Parse messages from Sapphire's JSON
                if chat['messages']:
                    try:
                        messages = json.loads(chat['messages'])
                        
                        # Handle both list and dict formats
                        if isinstance(messages, dict):
                            # If it's a dict keyed by timestamp, extract values
                            messages = list(messages.values()) if messages else []
                        elif not isinstance(messages, list):
                            messages = []
                        
                        # Add each message to Terminus
                        for i, msg in enumerate(messages):
                            if isinstance(msg, dict) and 'content' in msg:
                                msg_id = str(uuid.uuid4())
                                role = msg.get('role', 'user')
                                content = msg['content']
                                timestamp = msg.get('timestamp', chat['updated_at'])
                                
                                terminus_db.add_message(
                                    msg_id, conv_id, role, content, timestamp
                                )
                                stats["messages_migrated"] += 1
                    except Exception as e:
                        stats["errors"].append(f"Error parsing messages for {chat_name}: {str(e)}")
                
                print(f"  ✓ Migrated conversation '{chat_name}' ({len(messages) if isinstance(messages, list) else 0} messages)")
                
            except Exception as e:
                error_msg = f"Error migrating chat '{chat_name}': {str(e)}"
                stats["errors"].append(error_msg)
                print(f"  ✗ {error_msg}")
    
    finally:
        sapphire_conn.close()
    
    return stats


def main():
    """Run migration"""
    sapphire_db = Path("/Volumes/My Passport/Sapphire-native/user/history/sapphire_history.db")
    terminus_db = Path.home() / ".terminus" / "data" / "continuity.db"
    
    print("🔄 Migrating Sapphire → Terminus Continuity")
    print(f"  Source: {sapphire_db}")
    print(f"  Target: {terminus_db}")
    print()
    
    try:
        stats = migrate_from_sapphire(sapphire_db, terminus_db, backup=True)
        
        print()
        print("✅ Migration Complete!")
        print(f"  Conversations: {stats['conversations_migrated']}")
        print(f"  Messages: {stats['messages_migrated']}")
        
        if stats['errors']:
            print(f"\n⚠️  Errors ({len(stats['errors'])}):")
            for error in stats['errors']:
                print(f"    - {error}")
        
        return 0
        
    except Exception as e:
        print(f"❌ Migration failed: {str(e)}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
