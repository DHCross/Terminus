"""
Terminus FastAPI Backend
M1-optimized, self-hosted Claude chat application
"""
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import logging
import uuid
from datetime import datetime

from config import settings
from core.claude_client import ClaudeClient
from core.continuity_db import ContinuityDB

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Terminus",
    description="M1-optimized self-hosted Claude interface",
    version="2.0.0"
)

# Initialize Claude client and continuity DB
claude_client = ClaudeClient()
continuity_db = ContinuityDB(settings.DATA_DIR / "continuity.db")
continuity_db.init_schema()

# Current conversation ID (in-memory session)
current_conversation_id: str = None

# Request/Response models
class ChatRequest(BaseModel):
    """User chat message"""
    message: str


class ChatResponse(BaseModel):
    """Chat response from Claude"""
    response: str
    model: str


class ConfigResponse(BaseModel):
    """Server configuration"""
    model: str
    host: str
    port: int
    ready: bool


# Routes

@app.get("/")
async def serve_index():
    """Serve the main web UI"""
    index_path = Path(__file__).parent / "templates" / "index.html"
    if index_path.exists():
        return FileResponse(index_path, media_type="text/html")
    else:
        return HTMLResponse(
            """
            <html>
                <body>
                    <h1>Terminus Backend Ready</h1>
                    <p>Chat UI not yet mounted. Copy Sapphire web UI to backend/templates/</p>
                </body>
            </html>
            """
        )


@app.get("/api/config", response_model=ConfigResponse)
async def get_config():
    """Get server configuration"""
    return ConfigResponse(
        model=settings.LLM_MODEL,
        host=settings.HOST,
        port=settings.PORT,
        ready=bool(settings.ANTHROPIC_API_KEY)
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    Send a message to Claude and get a response
    Saves messages to continuity database
    
    Args:
        request: ChatRequest with user message
        
    Returns:
        ChatResponse with Claude's reply
    """
    global current_conversation_id
    
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY not set"
        )
    
    if not request.message or not request.message.strip():
        raise HTTPException(
            status_code=400,
            detail="Message cannot be empty"
        )
    
    # Initialize conversation if needed
    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"session_{datetime.utcnow().isoformat()[:10]}"
        )
        logger.info(f"Started new conversation: {current_conversation_id}")
    
    try:
        logger.info(f"Chat request: {request.message[:50]}...")
        
        # Get response from Claude
        response_text = claude_client.send_message(request.message)
        
        # Save user message to database
        continuity_db.add_message(
            str(uuid.uuid4()),
            current_conversation_id,
            "user",
            request.message
        )
        
        # Save assistant response to database
        continuity_db.add_message(
            str(uuid.uuid4()),
            current_conversation_id,
            "assistant",
            response_text
        )
        
        return ChatResponse(
            response=response_text,
            model=settings.LLM_MODEL
        )
    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Claude API error: {str(e)}"
        )


@app.get("/api/history")
async def get_history():
    """Get current conversation history"""
    global current_conversation_id
    
    if current_conversation_id:
        messages = continuity_db.get_conversation_messages(current_conversation_id)
        return {"messages": messages, "conversation_id": current_conversation_id}
    else:
        return {"messages": [], "conversation_id": None}


@app.get("/api/conversations")
async def list_conversations():
    """List all conversations"""
    conversations = continuity_db.get_all_conversations()
    return {"conversations": conversations}


@app.post("/api/conversations/{conv_id}/load")
async def load_conversation(conv_id: str):
    """Load a specific conversation"""
    global current_conversation_id
    
    current_conversation_id = conv_id
    messages = continuity_db.get_conversation_messages(conv_id)
    claude_client.clear_history()
    
    # Reload Claude history from database
    for msg in messages:
        claude_client.conversation_history.append({
            "role": msg["role"],
            "content": msg["content"]
        })
    
    logger.info(f"Loaded conversation: {conv_id} ({len(messages)} messages)")
    return {
        "status": "loaded",
        "conversation_id": conv_id,
        "message_count": len(messages)
    }


@app.post("/api/history/clear")
async def clear_history():
    """Start a new conversation"""
    global current_conversation_id
    
    claude_client.clear_history()
    current_conversation_id = None
    return {"status": "cleared"}


# Mount static assets if they exist
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    logger.info(f"Mounted static files from {static_dir}")


@app.on_event("startup")
async def startup_event():
    """Log startup information"""
    logger.info(f"Terminus Backend Starting")
    logger.info(f"Model: {settings.LLM_MODEL}")
    logger.info(f"API Key present: {bool(settings.ANTHROPIC_API_KEY)}")
    logger.info(f"Data directory: {settings.DATA_DIR}")
    
    # Check continuity database
    conv_count = len(continuity_db.get_all_conversations())
    logger.info(f"Continuity DB ready ({conv_count} existing conversations)")


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "terminus-backend",
        "model": settings.LLM_MODEL
    }


if __name__ == "__main__":
    import uvicorn
    
    logger.info(f"Starting server on {settings.HOST}:{settings.PORT}")
    uvicorn.run(
        app,
        host=settings.HOST,
        port=settings.PORT,
        log_level="info"
    )
