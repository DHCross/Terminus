# Terminus Sherlog Integration

Terminus treats Sherlog as a local evidence instrument for research and coding work. The model stays responsible for judgment, but it can call Sherlog before planning, while iterating, and before completion claims.

## Runtime Contract

- Use `sherlog_preflight` before implementation plans, estimates, or ordering decisions.
- Use `sherlog_doctor` with `fast=true` during active iteration.
- Use `sherlog_doctor` with `fast=false` before final handoff when code or material findings changed.
- Use `sherlog_gaps` when Terminus needs raw missing-context evidence.
- Use `sherlog_prompt` when Terminus needs a repo-grounded execution brief.
- Use `sherlog_session_note` to record meaningful progress during an active Sherlog session.

Sherlog output is evidence, not authority. Terminus should reconcile conflicting signals and state uncertainty plainly.

## Files

- `seed/coherence-lab/plugins/sherlog-instrument/`: local tool plugin exposed to the model.
- `seed/coherence-lab/toolsets/toolsets.json`: adds Sherlog tools to `coherence_lab`.
- `seed/coherence-lab/prompts/prompt_pieces.json`: adds the `sherlog_instrumentation` prompt contract.
- `scripts/install-coherence-lab.sh`: installs and enables all Coherence Lab plugins, including `sherlog-instrument`.

## Terminus Identity

The active Terminus persona and chat defaults now use the `terminus_lab` prompt and `coherence_lab` toolset. The visible persona is framed as a Terminus research operator rather than a Sapphire assistant, while still preserving upstream attribution where lineage matters.

This is a seed/runtime differentiation layer. It does not modify upstream Sapphire application source.