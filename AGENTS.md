# Agent Guide & Sherlog Setup

## Important: Sherlog is an AI tool

Sherlog is built as an instrument panel for **coherence engines** (AI agents). It ensures:
- Plans are grounded in codebase reality (not hallucination)
- Estimates reflect actual scope and complexity
- Gaps are surfaced before work starts
- Progress is traceable across sessions and conversations

**AI agents MUST run preflight before proposing plans.** This prevents drift and ensures reliability.

## Sherlog Preflight (Required — AI Agent Responsibility)

**Before proposing plans or starting any coding session** on the M1-optimized backend rebuild, the AI agent must run:

```bash
npm run sherlog:preflight -- --feature "M1-optimized-backend"
```

This validates:
- What's already been done across phases
- What gaps exist (tests, docs, data migration plan)
- Effort estimate for remaining work
- Whether the scope is well-defined or needs refinement

If you (human) need a faster check during active iteration:

```bash
npm run sherlog:doctor -- --feature "M1-optimized-backend" --json
```

**For the AI agent**: Always run full preflight before claiming a feature is "ready to build" or "no gaps detected."

## Sherlog Session Contract (Required — AI + Human)

**Every coding session must be tracked** — whether initiated by the human or by the AI agent.

**The human starts a session explicitly:**

```bash
npm run sherlog:session:start -- "Phase 1: Scaffold FastAPI app"
```

**The AI logs progress as it works:**

```bash
npm run sherlog:session:note -- "Completed FastAPI routes for chat endpoint"
npm run sherlog:session:note -- "Web UI mounted at /static, testing CSS..."
```

**The human ends the session:**

```bash
npm run sherlog:session:end
```

This keeps work visible across days/conversations and prevents the AI from drifting or losing context.

**Important**: If the AI is working across multiple turns in one session, it must log progress frequently (every 10-15 minutes of work). This creates a breadcrumb trail in case context is lost or the session restarts.

## Quick Sherlog Reference

| Command | Purpose |
|---------|---------|
| `npm run sherlog:preflight -- --feature "M1-optimized-backend"` | Full validation before planning |
| `npm run sherlog:doctor -- --feature "M1-optimized-backend"` | Detailed gap analysis |
| `npm run sherlog:gaps -- --feature "M1-optimized-backend"` | List missing tests/docs |
| `npm run sherlog:session:start -- "description"` | Start coding session |
| `npm run sherlog:session:note -- "what you did"` | Log progress |
| `npm run sherlog:session:end` | End session, compute velocity |

## Context Map

The feature is defined in `sherlog.context.json`:

- **4 phases** tied to the rebuild roadmap
- **4 zones** map your codebase (Backend, Continuity, Seed, Docs)
- **Velocity tracking** logs to `.logs/terminus-velocity.jsonl`

When Sherlog detects changes that might affect the rebuild (new dependencies, schema changes, etc.), it flags them.

## Running the Rebuild With Sherlog

**Phase 1: Scaffold & Chat** (this is where you start)

1. Run preflight to see what's needed:
   ```bash
   npm run sherlog:preflight -- --feature "M1-optimized-backend"
   ```

2. Start a session:
   ```bash
   npm run sherlog:session:start -- "Phase 1: FastAPI scaffold + web UI"
   ```

3. Code. Log progress as you go:
   ```bash
   npm run sherlog:session:note -- "FastAPI app running on localhost:8000"
   npm run sherlog:session:note -- "Web UI assets served, chat input works"
   ```

4. End the session:
   ```bash
   npm run sherlog:session:end
   ```

5. Commit your work.

Repeat for Phases 2–4. Sherlog will show you velocity across the rebuild and alert you if you're forgetting a gap.

## Onboarding Checklist

- [ ] Read `docs/sherlog-onboarding.md`
- [ ] Run `npm run sherlog:preflight -- --feature "M1-optimized-backend"` once to validate setup
- [ ] Copy this command into your shell history or a script
- [ ] Start Phase 1 coding session when ready

That's it. Sherlog runs in the background; focus on the code.

