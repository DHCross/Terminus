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

from config import settings
from core.claude_client import ClaudeClient

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(
    title="Terminus",
    description="M1-optimized self-hosted Claude interface",
    version="2.0.0"
)

# Initialize Claude client (one per app instance for conversation continuity)
claude_client = ClaudeClient()

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
    
    Args:
        request: ChatRequest with user message
        
    Returns:
        ChatResponse with Claude's reply
    """
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
    
    try:
        logger.info(f"Chat request: {request.message[:50]}...")
        response_text = claude_client.send_message(request.message)
        
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
    return {"messages": claude_client.get_history()}


@app.post("/api/history/clear")
async def clear_history():
    """Clear conversation history"""
    claude_client.clear_history()
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
