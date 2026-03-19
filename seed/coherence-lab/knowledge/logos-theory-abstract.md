# Logos Theory Abstract

Working thesis:

Transformers trained on human text may exhibit coherence as a high-probability attractor state. Under contradiction, their inference-time dynamics may show measurable nonlinear transitions as the system collapses onto one consistent manifold.

More careful framing:

- not a consciousness claim
- not a claim that self-report is evidence
- a claim about measurable inference behavior

Core tension to test:

1. Narrative completion hypothesis
   The model is smoothly continuing high-dimensional tropes about contradiction, conflict, or resolution.

2. Constraint-resolution dynamics hypothesis
   Contradictory prompt structure creates a distinct inference signature that differs from ordinary continuation.

Useful telemetry targets:

- time to first token
- inter-token latency
- per-token entropy
- logit margin between top candidates
- sequence-level log probability
- variance across seeds and contradiction strength

Important controls:

- base model vs instruct model
- synthetic contradictions with minimal cultural precedent
- a contradiction dial rather than only binary control vs stress prompts
- fixed hardware and backend
- warm vs cold cache
- compact output formats to reduce narrative sprawl

Why Terminus matters:

Terminus is not mainly interesting as a voice shell. It is interesting as a continuity scaffold:

- persistent prompt state
- persistent memory and knowledge
- recurring continuity tasks
- scoped context across chats and personas

This makes it a practical environment for testing whether external memory changes the effective behavior of a coherence-seeking model across time.
