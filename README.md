# Terminus

A native macOS launcher for [Sapphire](https://github.com/ddxfish/sapphire) with a custom seed pack for continuity-focused research.

Sapphire runs directly on your Mac (Python backend + Electron shell) — no Docker required. The Sapphire installation lives on an external drive; this repo holds configuration, environment, and the Coherence Lab seed pack.

## Prerequisites

- **Python 3.11+** (installed via [uv](https://docs.astral.sh/uv/) or system Python)
- **Node.js** (for the Electron shell)
- **[Task](https://taskfile.dev/installation/)** CLI (task runner used by Sapphire)
- **[uv](https://docs.astral.sh/uv/)** (Python package manager)
- Sapphire source cloned to your external drive (default: `/Volumes/My Passport/Sapphire-native`)

## Quick Start

```bash
cp .env.example .env    # edit to add API keys and verify paths
make setup              # check prerequisites and wire up .env
make launch             # start Sapphire natively
```

Then open: [https://localhost:8073](https://localhost:8073)

Sapphire uses a self-signed certificate, so your browser will show a warning. Proceed to continue.

## Coherence Lab Seed

This repo includes a seed pack oriented around continuity and research:

- continuity and memory as external state
- coherence engines / Logos Theory
- contradiction dynamics in transformers
- falsifiability-first research collaboration

Install the seed pack:

```bash
make seed-coherence-lab
```

What it seeds:

- persona: `terminus`
- prompt preset: `terminus_lab`
- compatibility persona: `coherence_engine`
- compatibility prompt preset: `logos_lab`
- toolset: `coherence_lab`
- disabled continuity task: `Terminus Daily Brief`

After Sapphire starts:

1. Switch to the `terminus` persona.
2. If you want recurring synthesis, enable `Terminus Daily Brief` in Continuity.
3. Upload the Markdown notes in [seed/coherence-lab/knowledge/](seed/coherence-lab/knowledge/) into Mind > Knowledge for richer long-term context.

This is the useful connection to Sapphire: not "continuous learning" in the weight-update sense, but persistent prompt state, memory, knowledge, goals, and scheduled continuity as a scaffold around a stateless model.

## SHERLOG Preflight

[SHERLOG](https://github.com/dancross/SHERLOG_starter) is a repo-aware preflight CLI for AI-assisted development. It detects gaps, tracks velocity, and validates code hygiene before you hand work off to an AI.

```bash
make verify              # Validate install and bundle freshness
make doctor ARGS="--feature 'Seed Pack'"   # Feature health check
make gaps ARGS="--feature 'Seed Pack'"     # Detect missing tests/docs
make hygiene             # Code quality scan
```

SHERLOG is under active development. Not every type of work has a pre-defined feature key — use what's available and skip checks that don't apply.

## Common Commands

```bash
make launch              # Start Sapphire (Electron + Python backend)
make stop                # Stop Sapphire
make logs                # Tail runtime logs
make setup               # Check prerequisites and configure
make seed-coherence-lab  # Install the Coherence Lab seed pack
make verify              # SHERLOG preflight check
make doctor              # SHERLOG feature health
make gaps                # SHERLOG gap detection
make hygiene             # SHERLOG code quality scan
```

## Configuration

Edit [.env](.env) before starting:

- `SAPPHIRE_NATIVE_DIR`: path to Sapphire installation (default: `/Volumes/My Passport/Sapphire-native`)
- `TZ`: your timezone
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`
- `ELEVENLABS_API_KEY`: for ElevenLabs TTS
- `LMSTUDIO_BASE_URL`: if you run LM Studio locally

## Upstream References

- [Sapphire repository](https://github.com/ddxfish/sapphire)
