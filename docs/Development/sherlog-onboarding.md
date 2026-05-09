# Terminus + Sherlog Onboarding

Welcome. This document walks you through Sherlog integration and the M1-optimized backend rebuild.

## What is Sherlog?

Sherlog is a preflight validation and velocity tracking system for feature development. It:

- **Validates your plan** before you start (finds missing pieces, estimates effort)
- **Tracks session progress** across days or weeks (who did what, how long it takes)
- **Detects gaps** (missing tests, stale docs, unmigrated data)
- **Estimates effort** by analyzing codebase and feature complexity

For the Terminus rebuild, Sherlog ensures you don't forget a data migration step, lose track of progress across 4 phases, or accidentally ship incomplete features.

**Sherlog is also an AI tool.** When an AI agent (like GitHub Copilot) works on this project, it **must**:
- Run preflight before proposing any plan
- Log progress via session notes every 10-15 minutes of work
- End the session when work is complete
- Never claim "no gaps detected" without running doctor/gaps

This keeps the AI coherent and trustworthy across multiple conversations.

## Setup (First Time Only)

Sherlog is already installed. Just verify it works:

```bash
cd /Users/dancross/Dev/GitHub/Terminus
npm install 2>/dev/null  # ensures sherlog-velocity deps are ready
npm run sherlog:preflight -- --feature "M1-optimized-backend"
```

You should see:
```
SHERLOG TRACE PREFLIGHT
Feature: M1-optimized-backend
Status: OK
Verify: X pass, 0 warn, 0 fail
...
```

If that works, you're good. Copy the command above into your shell history or a script for quick access.

## The Rebuild at a Glance

**Current state**: Terminus runs on Sapphire (external USB drive, Python backend, heavy STT overhead)

**End state**: Terminus runs on M1-optimized FastAPI backend (internal SSD, lighter, native M1 whisper)

**Four phases**:

| Phase | Work | Exit Criteria |
|-------|------|---------------|
| 1: Scaffold | FastAPI app, web UI mount, chat works | Claude responds via new backend |
| 2: Continuity | Migrate memory/traces JSON → SQLite | Old conversations accessible, new ones stored in SQLite |
| 3: STT | Swap faster_whisper → mlx-whisper | Voice input works, faster, lower memory |
| 4: Polish | Scheduler, plugins, testing | Journal tasks run, reasoning-trace works, all user features intact |

## Daily Workflow

### Starting a Session

When you sit down to code, tell Sherlog:

```bash
npm run sherlog:session:start -- "Phase 1: Scaffold FastAPI routes"
```

This logs the start time and feature. Sherlog uses this to compute velocity.

### During the Session

As you complete discrete steps, log them:

```bash
npm run sherlog:session:note -- "FastAPI app running on localhost:8000"
npm run sherlog:session:note -- "Chat endpoint POST /api/chat implemented"
npm run sherlog:session:note -- "Web UI mounted, CSS loads"
```

These notes appear in the velocity log and help you track what you did.

### Ending the Session

When you're done:

```bash
npm run sherlog:session:end
```

Sherlog computes how long you worked and logs velocity metrics (commits/hour, lines/day, etc.). This helps you forecast remaining work.

## Checking Progress

At any point, see the health of the rebuild:

```bash
# Full preflight (runs doctor, gaps, estimates)
npm run sherlog:preflight -- --feature "M1-optimized-backend"

# Just the gap analysis
npm run sherlog:gaps -- --feature "M1-optimized-backend"

# JSON output for scripting
npm run sherlog:doctor -- --feature "M1-optimized-backend" --json
```

## Handling Gaps

If Sherlog flags a gap (e.g., "no migration plan documented"), fix it before merging:

```bash
# If Phase 2 is missing a data migration strategy:
npm run sherlog:gaps -- --feature "M1-optimized-backend"
# Add the missing plan to docs/rebuild-phase-2-migration.md
npm run sherlog:session:note -- "Documented SQLite migration strategy"
```

## Repository Structure

```
Terminus/
  sherlog.context.json       ← feature definition & zones
  sherlog-velocity/          ← Sherlog CLI & tracking
  .logs/terminus-velocity.jsonl  ← session logs (auto-created)
  docs/
    sherlog-onboarding.md    ← you are here
    rebuild-phases.md        ← planning doc (create as needed)
    rebuild-phase-2-migration.md ← data migration plan (Phase 2)
```

When you start Phase 2, create a doc explaining the JSON → SQLite migration. Sherlog can then validate that you didn't ship Phase 2 without that plan.

## Quick Commands

Copy these into your shell or keep them handy:

```bash
# Validate & estimate effort
alias sherlog-check='npm run sherlog:preflight -- --feature "M1-optimized-backend"'

# Start work
sherlog-start() { npm run sherlog:session:start -- "$1"; }

# Log progress
sherlog-note() { npm run sherlog:session:note -- "$1"; }

# End day
sherlog-done() { npm run sherlog:session:end; }

# Check gaps
sherlog-gaps() { npm run sherlog:gaps -- --feature "M1-optimized-backend"; }
```

Then:

```bash
sherlog-start "Phase 1: Scaffold"
# ... code ...
sherlog-note "FastAPI app running"
sherlog-done
```

## When to Reach Out to Sherlog

Run a preflight when:
- You're about to start a new phase
- You've finished a phase and want to confirm completeness
- You're unsure if you've covered all the requirements
- Something feels like it's drifting or taking longer than expected

Run a gap check when:
- You committed code and want to know if you missed anything
- You're handing work off to someone else
- Before merging a phase into main

## Next Steps

1. Run the preflight to validate Sherlog is working:
   ```bash
   npm run sherlog:preflight -- --feature "M1-optimized-backend"
   ```

2. Create a `docs/rebuild-phases.md` (optional, but helpful):
   ```bash
   npm run sherlog:session:start -- "Planning: Draft Phase 1 requirements"
   # (edit docs/rebuild-phases.md)
   npm run sherlog:session:end
   ```

3. Start Phase 1:
   ```bash
   npm run sherlog:session:start -- "Phase 1: Scaffold FastAPI app"
   # (begin coding)
   ```

That's it. Sherlog runs quietly. Focus on the code.

---

## For the AI Agent

When working on the Terminus rebuild, **you must**:

1. **Before proposing any plan**, run:
   ```bash
   npm run sherlog:preflight -- --feature "M1-optimized-backend"
   ```
   And report the findings to the human.

2. **If you don't see a preflight run yet in this conversation**, run one before sketching Phase 1.

3. **During work**, log progress:
   ```bash
   npm run sherlog:session:note -- "Scaffold: FastAPI app initialized"
   npm run sherlog:session:note -- "Scaffold: Routes /api/chat and /api/config implemented"
   ```
   Every 10-15 minutes of work (or after each logical step).

4. **Never claim**:
   - "No gaps detected" without running gaps
   - "Ready to build Phase X" without running doctor
   - "Scope is complete" without evidence from Sherlog

5. **When you finish a phase or hand off work**, end the session:
   ```bash
   npm run sherlog:session:end
   ```

This keeps you coherent across conversation restarts and ensures the human can always verify your work.

---

**Questions?** Read `/docs/why-sherlog.md` (will be added to SHERLOG_starter docs) or the AGENTS.md in the repo root.
