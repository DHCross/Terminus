# Terminus Backend Rebuild — Phase Plan

**Objective**: Divorce from Sapphire. Build M1-optimized FastAPI backend on internal SSD.

**Timeline**: 4 phases (tracked via Sherlog)

**Tracking**: `npm run sherlog:session:start -- "Phase N: ..."`

---

## Phase 1: Scaffold & Chat

**Duration**: ~1 day of focused work

**Goal**: Get a FastAPI app running, serve the web UI, chat with Claude works end-to-end.

**What to build**:
- [ ] FastAPI app on localhost:8000 (not 8073 yet)
- [ ] Copy `/Volumes/My Passport/Sapphire-native/interfaces/web/static/*` to `backend/static/`
- [ ] Copy `/Volumes/My Passport/Sapphire-native/interfaces/web/templates/index.html` to `backend/templates/`
- [ ] Implement `POST /api/chat` endpoint (takes text, calls Claude SDK, returns response)
- [ ] Implement `GET /api/config` endpoint (returns API keys, model name, etc.)
- [ ] Serve web UI at `GET /`
- [ ] Self-signed cert on 8000 (or test on 5000 first)

**Exit criteria**:
- FastAPI app starts without errors
- Web UI loads at https://localhost:8000 or http://localhost:5000
- Chat input → API call → Claude response → UI updates
- Sherlog session logs confirm the milestone

**Key file structure**:
```
phase-1-fastapi/
  main.py              # FastAPI app + routes
  config.py            # Settings (API keys, model)
  core/
    claude_client.py   # Anthropic SDK wrapper
  static/              # Copied from Sapphire
  templates/           # Copied from Sapphire
  requirements.txt     # FastAPI, uvicorn, anthropic
```

**Dependency additions**:
```
fastapi>=0.104.0
uvicorn[standard]>=0.24.0
anthropic>=0.7.0
python-dotenv
```

---

## Phase 2: Continuity Migration

**Duration**: ~1-2 days (depends on data volume)

**Goal**: Move conversation memory, traces, and state from Sapphire's JSON format to SQLite.

**What to build**:
- [ ] SQLite schema (conversations, messages, traces, metadata)
- [ ] Migration script: `Sapphire JSON files → SQLite database`
- [ ] `GET /api/conversations` endpoint (list all conversations)
- [ ] `POST /api/conversations/{id}/messages` endpoint (append message)
- [ ] `GET /api/conversations/{id}` endpoint (get full conversation history)
- [ ] Trace schema + endpoints for reasoning-trace plugin
- [ ] Backup old JSON before migration (just in case)

**Exit criteria**:
- Old conversations load from SQLite and match original content
- New messages save to SQLite automatically
- Migration script runs without data loss
- Backup exists

**Key file structure**:
```
core/
  db.py                # SQLite init, queries
  models.py            # Pydantic models for conversations/messages
  migrate.py           # JSON → SQLite script
```

**Dependency additions**:
```
aiosqlite>=0.19.0
```

**Data migration**:
1. Snapshot `/Volumes/My Passport/Sapphire-native/user/continuity/traces/` and `/user/history/`
2. Run migration script to parse JSON, insert into SQLite
3. Verify row counts match
4. Archive original JSON files (keep as backup)

---

## Phase 3: STT Optimization

**Duration**: ~6-8 hours (mostly testing)

**Goal**: Replace Faster Whisper (CPU, 4 workers) with MLX Whisper (M1 Neural Engine, single threaded).

**What to build**:
- [ ] MLX Whisper client wrapper
- [ ] `POST /api/transcribe` endpoint (takes audio file or stream, returns text)
- [ ] Update web UI to use new endpoint (likely copy-paste from Sapphire's audio handler)
- [ ] Benchmark: MLX vs. Faster Whisper on the same audio file (should be 3-5x faster)

**Exit criteria**:
- Voice input works
- Transcription faster than before
- RAM usage lower than Faster Whisper's 4-worker mode
- Tested with actual spoken utterances

**Key file structure**:
```
core/
  stt.py               # MLX Whisper wrapper
```

**Dependency additions**:
```
mlx-whisper>=0.4.0
```

**Configuration**:
```python
STT_MODEL = "base.en"  # or "small.en" if accuracy needed
DEVICE = "gpu"         # MLX auto-uses Neural Engine on M1
```

---

## Phase 4: Scheduler & Plugins

**Duration**: ~1-2 days

**Goal**: Port scheduled tasks (journal, daily brief) and reasoning-trace plugin.

**What to build**:
- [ ] APScheduler integration
- [ ] `POST /api/tasks/enable`, `GET /api/tasks/list` endpoints
- [ ] Reasoning-trace plugin loader (keep the one from Sapphire, just port the API)
- [ ] Scheduled task execution (e.g., "daily brief" at 8am)
- [ ] Journal entries stored in SQLite
- [ ] Plugin architecture (thin loader that calls Python/JS plugins)

**Exit criteria**:
- Scheduled tasks run on time
- Journal entries appear in UI
- Reasoning-trace plugin can be toggled on/off
- No orphaned processes like the duplicate Sapphire instances

**Key file structure**:
```
core/
  scheduler.py         # APScheduler setup
  plugins.py           # Plugin loader
plugins/
  reasoning_trace/     # Port from Sapphire
```

**Dependency additions**:
```
APScheduler>=3.10.0
```

---

## Deferred / Out of Scope

**Not rebuilding in Phase 1-4**:
- Personas system (keep Sapphire seed, port UI only)
- Email plugin (disabled already)
- Multi-user support
- Authentication (localhost-only, no auth needed)
- Electron shell (use browser direct)

These can be added later if needed. The rebuild focuses on core chat + continuity + M1 optimization.

---

## Rollback / Checkpoint

After each phase:
1. Commit work: `git commit -m "Phase N: [description]"`
2. Run Sherlog: `npm run sherlog:session:end`
3. Tag checkpoint: `git tag phase-N-complete`

If Phase N fails and you need to revert: `git reset --hard phase-N-1-complete`

---

## Testing Checklist

- [ ] **Phase 1**: Chat works, web UI loads, no 500 errors
- [ ] **Phase 2**: Old conversations load, new messages save
- [ ] **Phase 3**: Voice input works, transcription accurate
- [ ] **Phase 4**: Tasks run on schedule, plugins load
- [ ] **Integration**: All features work together (chat + continuity + STT + tasks)
- [ ] **Performance**: Memory stays under 200MB idle, CPU < 5% idle
- [ ] **Launch**: `make launch` still works (may need script updates)

---

## When to Reach Out to Sherlog

- Before Phase 1: `npm run sherlog:preflight -- --feature "M1-optimized-backend"` (validate scope)
- After Phase 2: `npm run sherlog:gaps -- --feature "M1-optimized-backend"` (check data integrity)
- Before Phase 4: `npm run sherlog:preflight` (confirm no gaps in plugin strategy)
- Before merging main: full preflight to ensure nothing was forgotten

---

## Success Criteria (End of Rebuild)

- ✅ Terminus runs from internal SSD
- ✅ No Sapphire dependency
- ✅ All user data migrated (conversations, traces, journal)
- ✅ Voice input faster and lighter
- ✅ Scheduled tasks work
- ✅ Reasoning-trace plugin loads
- ✅ Memory pressure dropped vs. Sapphire baseline
- ✅ Rebuild documented in this file and via Sherlog logs
