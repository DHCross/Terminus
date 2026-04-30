# Terminus

A native macOS launcher for Terminus, with a custom seed pack for continuity-focused research.

Terminus runs directly on your Mac (Python backend + Electron shell) — no Docker required. The native Terminus install lives on an external drive; this repo holds configuration, environment, and the Coherence Lab seed pack.

## Origin And Attribution

Terminus did not originate from a blank slate. It began as a personal derivative environment bootstrapped from the open-source [Sapphire](https://github.com/ddxfish/sapphire) project and has been evolving toward a distinct local system with its own prompt architecture, continuity model, project memory, and workflow conventions.

The goal of this repo is not to relabel Sapphire as if it originated here. The goal is to build a clearly differentiated personal system on top of borrowed scaffolding while preserving upstream attribution.

If you are reading this as a public project:

- Sapphire is the upstream foundation
- Terminus is the local derivative system and seed/config layer built around that foundation
- Terminus-specific changes should be understood as modifications and additions, not as a claim of original authorship over upstream Sapphire

## License Status

This repo currently needs a licensing review before any public release.

The upstream Sapphire repository appears to be licensed under AGPL-3.0, while this repo currently contains an MIT `LICENSE` file. That may not be the correct licensing posture for a derivative distribution if this repo includes or depends on Sapphire-derived code rather than only separate configuration and notes.

Until that is resolved, treat Terminus as a personal derivative workspace rather than a ready-to-publish standalone project.

## Prerequisites

- **Python 3.11+** (installed via [uv](https://docs.astral.sh/uv/) or system Python)
- **Node.js** (for the Electron shell)
- **[Task](https://taskfile.dev/installation/)** CLI (task runner used by the native app)
- **[uv](https://docs.astral.sh/uv/)** (Python package manager)
- Native app source cloned to your external drive (default: `/Volumes/My Passport/Sapphire-native`)

## Quick Start

```bash
cp .env.example .env    # edit to add API keys and verify paths
make setup              # check prerequisites and wire up .env
make launch             # start Terminus natively
```

Then open: [https://localhost:8073](https://localhost:8073)

Terminus uses a self-signed certificate, so your browser will show a warning. Proceed to continue.

If you want a Desktop icon that skips the IDE and opens Terminus in your browser:

```bash
make install-desktop-launcher
```

That creates `~/Desktop/Launch Terminus.command`. Double-clicking it starts the backend if needed and opens [https://localhost:8073](https://localhost:8073) in your default browser.

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

After Terminus starts:

1. Switch to the `terminus` persona.
2. If you want recurring synthesis, enable `Terminus Daily Brief` in Continuity.
3. Upload the Markdown notes in [seed/coherence-lab/knowledge/](seed/coherence-lab/knowledge/) into Mind > Knowledge for richer long-term context.

This is the useful connection to Terminus: not "continuous learning" in the weight-update sense, but persistent prompt state, memory, knowledge, goals, and scheduled continuity as a scaffold around a stateless model.

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
make launch              # Start Terminus (Electron + Python backend)
make launch-browser      # Start Terminus and open it in your browser
make install-desktop-launcher  # Install a Desktop launcher on macOS
make stop                # Stop Terminus
make logs                # Tail runtime logs
make setup               # Check prerequisites and configure
make seed-coherence-lab  # Install the Coherence Lab seed pack
make health              # Run the 11-point health check
make backup-state        # Snapshot user/ continuity state
make verify              # SHERLOG preflight check
make doctor              # SHERLOG feature health
make gaps                # SHERLOG gap detection
make hygiene             # SHERLOG code quality scan
```

## Configuration

Edit [.env](.env) before starting:

- `SAPPHIRE_NATIVE_DIR`: path to the native Terminus installation (legacy variable name, default: `/Volumes/My Passport/Sapphire-native`)
- `TZ`: your timezone
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`
- `ELEVENLABS_API_KEY`: for ElevenLabs TTS
- `LMSTUDIO_BASE_URL`: if you run LM Studio locally

## Upstream References

- [Upstream Sapphire repository](https://github.com/ddxfish/sapphire)
- [Attribution Notice](NOTICE)
