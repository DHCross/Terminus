"""
Terminus FastAPI Backend — v2.1.0
M1-optimized, self-hosted Claude with voice, tools, scheduler, and reasoning-trace.
"""
import logging
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import settings
from core.claude_client import ClaudeClient
from core.continuity_db import ContinuityDB
from core.stt import get_stt_engine
from core.voice import get_voice_engine
from core.tracer import record_turn
from core.scheduler import get_scheduler
from core.tools import all_tools

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="Terminus",
    description="M1-optimized self-hosted Claude with voice, tools, and scheduler",
    version="2.1.0",
)

# ── Core services ─────────────────────────────────────────────────────────────
claude_client = ClaudeClient(tools=all_tools())
continuity_db = ContinuityDB(settings.DATA_DIR / "continuity.db")
continuity_db.init_schema()
voice_engine = get_voice_engine()
scheduler = get_scheduler(generate_fn=claude_client.send_message, db=continuity_db)

current_conversation_id: str = None


# ── Models ────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    response: str
    model: str

class SpeakRequest(BaseModel):
    text: str

class VoiceChatRequest(BaseModel):
    text: str

class ConfigResponse(BaseModel):
    model: str
    host: str
    port: int
    ready: bool
    voice_backend: str
    tools_enabled: bool
    scheduler_running: bool

class TranscriptionResponse(BaseModel):
    text: str
    language: str
    confidence: float
    duration: float
    segments: list
    model: str


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
async def serve_index():
    index_path = Path(__file__).parent / "templates" / "index.html"
    if index_path.exists():
        return FileResponse(index_path, media_type="text/html")
    return HTMLResponse("<html><body><h1>Terminus v2.1.0 Ready</h1></body></html>")


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "service": "terminus-backend",
        "version": "2.1.0",
        "model": settings.LLM_MODEL,
        "voice": voice_engine.backend,
        "tools": len(claude_client.tools or []),
    }


@app.get("/api/config", response_model=ConfigResponse)
async def get_config():
    return ConfigResponse(
        model=settings.LLM_MODEL,
        host=settings.HOST,
        port=settings.PORT,
        ready=bool(settings.ANTHROPIC_API_KEY),
        voice_backend=voice_engine.backend,
        tools_enabled=bool(claude_client.tools),
        scheduler_running=bool(scheduler._scheduler and scheduler._scheduler.running),
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Send a message to Claude with tool use. Saves to DB and trace files."""
    global current_conversation_id

    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")
    if not request.message or not request.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"session_{datetime.utcnow().isoformat()[:10]}",
        )

    try:
        response_text = claude_client.send_message(request.message)
        continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "user", request.message)
        continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "assistant", response_text)
        record_turn(request.message, response_text)
        return ChatResponse(response=response_text, model=settings.LLM_MODEL)
    except Exception as e:
        logger.error(f"Chat error: {e}")
        raise HTTPException(status_code=500, detail=f"Claude API error: {e}")


@app.post("/api/voice/chat")
async def voice_chat(request: VoiceChatRequest):
    """
    Voice loop: text-in → Claude (streaming) → ElevenLabs audio-out.
    Returns streaming MP3. Latency target: ~1.5s to first audio byte.
    """
    global current_conversation_id

    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    if current_conversation_id is None:
        current_conversation_id = str(uuid.uuid4())
        continuity_db.add_conversation(
            current_conversation_id,
            f"voice_{datetime.utcnow().isoformat()[:10]}",
        )

    try:
        # Get full response (streaming internally), then pass to voice engine
        full_response = ""
        for chunk in claude_client.stream_message(request.text):
            full_response += chunk

        continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "user", request.text)
        continuity_db.add_message(str(uuid.uuid4()), current_conversation_id, "assistant", full_response)
        record_turn(request.text, full_response)

        def audio_generator():
            for audio_chunk in voice_engine.stream(full_response):
                yield audio_chunk

        content_type = "audio/mpeg" if voice_engine.available else "audio/aiff"
        return StreamingResponse(
            audio_generator(),
            media_type=content_type,
            headers={
                "X-Response-Text": full_response[:200],
                "X-Voice-Backend": voice_engine.backend,
            },
        )
    except Exception as e:
        logger.error(f"Voice chat error: {e}")
        raise HTTPException(status_code=500, detail=f"Voice chat error: {e}")


@app.post("/api/speak")
async def speak(request: SpeakRequest):
    """Synthesize text to speech. Returns streaming audio."""
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    def audio_generator():
        for chunk in voice_engine.stream(request.text):
            yield chunk

    content_type = "audio/mpeg" if voice_engine.available else "audio/aiff"
    return StreamingResponse(
        audio_generator(),
        media_type=content_type,
        headers={"X-Voice-Backend": voice_engine.backend},
    )


@app.post("/api/transcribe", response_model=TranscriptionResponse)
async def transcribe(audio_file: UploadFile = File(...)):
    """Transcribe audio file using MLX Whisper (M1 Neural Engine)."""
    allowed_types = {"audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "application/octet-stream"}
    if audio_file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail=f"Unsupported audio type: {audio_file.content_type}")

    temp_file = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            tmp.write(await audio_file.read())
            temp_file = tmp.name

        stt_engine = get_stt_engine()
        if not stt_engine.available:
            raise HTTPException(status_code=503, detail="MLX Whisper not installed")

        return TranscriptionResponse(**stt_engine.transcribe(temp_file))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        if temp_file:
            Path(temp_file).unlink(missing_ok=True)


@app.get("/api/history")
async def get_history():
    if current_conversation_id:
        messages = continuity_db.get_conversation_messages(current_conversation_id)
        return {"messages": messages, "conversation_id": current_conversation_id}
    return {"messages": [], "conversation_id": None}


@app.get("/api/conversations")
async def list_conversations():
    return {"conversations": continuity_db.get_all_conversations()}


@app.post("/api/conversations/{conv_id}/load")
async def load_conversation(conv_id: str):
    global current_conversation_id
    current_conversation_id = conv_id
    messages = continuity_db.get_conversation_messages(conv_id)
    claude_client.clear_history()
    for msg in messages:
        claude_client.conversation_history.append({"role": msg["role"], "content": msg["content"]})
    return {"status": "loaded", "conversation_id": conv_id, "message_count": len(messages)}


@app.post("/api/history/clear")
async def clear_history():
    global current_conversation_id
    claude_client.clear_history()
    current_conversation_id = None
    return {"status": "cleared"}


@app.get("/api/tasks")
async def list_tasks():
    """List scheduled tasks with next run times."""
    return {"jobs": scheduler.list_jobs()}


@app.post("/api/tasks/{job_id}/run")
async def run_task(job_id: str):
    """Manually trigger a scheduled task."""
    if not scheduler.trigger_now(job_id):
        raise HTTPException(
            status_code=404,
            detail=f"Job '{job_id}' not found. Valid: daily_brief, journal_prompt, trace_compact, health_ping",
        )
    return {"status": "triggered", "job_id": job_id}


@app.get("/api/trace")
async def get_trace(date: str = None):
    """Get reasoning trace for today or a given date."""
    from core.tracer import _read_trace
    today = date or datetime.now().strftime("%Y-%m-%d")
    return {"date": today, "trace": _read_trace(today)}


@app.get("/api/journal")
async def list_journal():
    """List available journal entries."""
    from core.tracer import JOURNAL_DIR
    if not JOURNAL_DIR.exists():
        return {"entries": []}
    entries = sorted([p.name for p in JOURNAL_DIR.iterdir() if p.suffix == ".md"], reverse=True)
    return {"entries": entries}


@app.get("/api/journal/{filename}")
async def get_journal_entry(filename: str):
    """Read a journal entry."""
    from core.tracer import JOURNAL_DIR
    if not filename.replace("-", "").replace(".", "").replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = JOURNAL_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"filename": filename, "content": path.read_text(encoding="utf-8")}


@app.get("/api/version")
async def get_version():
    return {
        "version": "2.1.0",
        "name": "Terminus",
        "description": "M1-optimized self-hosted Claude with voice, tools, scheduler, and reasoning-trace",
        "phases": {
            "phase_1": {"name": "Scaffold & Chat", "status": "complete"},
            "phase_2": {"name": "Continuity Migration", "status": "complete"},
            "phase_3": {"name": "STT Optimization", "status": "complete"},
            "phase_4": {"name": "Voice + Tools + Scheduler + Plugins", "status": "complete"},
        },
        "components": {
            "llm": f"{settings.LLM_MODEL} with tool use",
            "tts": f"ElevenLabs {settings.VOICE_MODEL} (fallback: macOS say)",
            "stt": "MLX Whisper (M1 Neural Engine)",
            "scheduler": "APScheduler — daily_brief@07:00, journal@21:00, compact@03:00",
            "tools": "web_search, read_file, write_file, list_directory, run_command, read_trace, write_journal, commit_claim",
            "reasoning_trace": "~/.terminus/data/traces/YYYY-MM-DD.{jsonl,md}",
        },
    }


@app.get("/api/changelog")
async def get_changelog():
    changelog_path = Path(__file__).parent.parent / "CHANGELOG.md"
    if not changelog_path.exists():
        raise HTTPException(status_code=404, detail="Changelog not found")
    return {"changelog": changelog_path.read_text(encoding="utf-8"), "format": "markdown"}


# ── Static ────────────────────────────────────────────────────────────────────
static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    logger.info(f"Terminus v2.1.0 | model={settings.LLM_MODEL} | voice={voice_engine.backend} | tools={len(claude_client.tools or [])}")
    logger.info(f"Continuity DB: {len(continuity_db.get_all_conversations())} conversations")
    scheduler.start()


@app.on_event("shutdown")
async def shutdown_event():
    scheduler.stop()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.HOST, port=settings.PORT, log_level="info")
