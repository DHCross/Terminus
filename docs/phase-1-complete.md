# Phase 1: FastAPI Backend + Web UI — Complete ✅

## What's Done

**Terminus Phase 1** is fully functional and tested. The new backend:

- ✅ Runs on **localhost:8000** (not 8073 — we own port 8000 now)
- ✅ Uses **Claude Sonnet 4.6** (current Anthropic model)
- ✅ Web UI loads and serves chat interface
- ✅ Chat endpoint: `POST /api/chat` → Claude responds
- ✅ Config endpoint: `GET /api/config` → Server status
- ✅ History endpoint: `GET /api/history` → Conversation memory
- ✅ All dependencies vendored (no external drive needed)
- ✅ Committed to git with full diff

## How to Run

```bash
# Start the backend (from Terminus root)
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' ../.env | cut -d= -f2) python3 main.py
```

Then open: **http://localhost:8000**

(Or use the startup script we created: `./scripts/start-phase1-backend.sh`)

## What Changed

| Before (Sapphire) | After (Terminus Phase 1) |
|---|---|
| Python + Electron on USB drive | Python FastAPI on internal SSD |
| Port 8073 | Port 8000 |
| Sapphire-specific wrapper | Direct Anthropic SDK |
| Heavy STT overhead (next phase) | Lean scaffolding, ready for mlx-whisper |
| External dependency coupling | Self-contained backend |

## Architecture

```
backend/
  main.py              ← FastAPI app & routes
  config.py            ← Settings (model, API key, paths)
  core/
    claude_client.py   ← Claude wrapper
  static/              ← Web UI assets (JS, CSS, images)
  templates/
    index.html         ← Web UI entry point
  requirements.txt     ← Dependencies
  venv/                ← Virtual environment
```

## Next: Phase 2

When ready, Phase 2 will:
- Migrate conversation history from Sapphire's JSON → SQLite
- Build continuity schema for storing memory
- Keep this backend running unchanged

Then Phase 3 swaps STT to mlx-whisper (M1 Neural Engine), and Phase 4 adds scheduler + plugins.

---

**Status**: Phase 1 Exit Criteria Met ✅
- Backend runs error-free
- Web UI loads
- Claude chat works
- Conversation history tracked
- Sherlog session logged (4m 32s, 2 notes, committed)

Ready to proceed when you are.
