# Sherlog: Repo-Aware Preflight for AI-Assisted Development

Sherlog is another active project Terminus should be able to help Dan with directly.

## Core definition

Sherlog is a repo-aware preflight and planning layer for AI-assisted development.

Its purpose is to reduce false confidence before implementation starts by checking the repository as it actually exists:

- real seams
- stale surfaces
- artifact contracts
- documented boundaries
- areas where evidence is still weak

The point is not to make the AI louder. The point is to make it more honest.

## What problem it solves

Fast AI coding systems do not mainly fail because of syntax mistakes.

Their more dangerous failure mode is false confidence:

- growing the wrong file
- reviving the wrong pattern
- trusting a stale seam
- treating weak evidence like certainty
- sounding more confident than the repository justifies

Sherlog exists to expose these risks before code is grown.

## Correct framing

Sherlog is not meant to become the boss of the session.

The agent stays in charge of the work.
Sherlog is the instrument panel the agent calls when it needs repo-specific evidence.

Important stance:

- Sherlog is on-demand, not supervisory
- it supports the active workflow rather than governing it
- it should help vibe coders keep the AI in charge while reducing landing-zone mistakes and unearned certainty

## Sherlog grounded loop

For a feature, repair, or refactor, Sherlog works through a grounded loop:

1. `verify`
   Checks repo wiring, context files, and artifact contracts.
2. `doctor`
   Produces a high-level health view for the feature.
3. `gaps`
   Surfaces concrete issues such as missing tests, stale context, architectural pressure, and uncovered seams.
4. `prompt`
   Produces a repo-grounded execution brief from the current state.

Related outputs can also include:

- velocity-grounded estimates
- session-truth outputs
- apparent-progress vs actual-effort comparisons

## What makes Sherlog useful

Sherlog is useful when it does four things well:

- adapts to the host repo's real structure instead of assuming a template layout
- stops emitting false context alarms once the repo is configured correctly
- narrows output to real, defensible findings
- changes its recommendation when the evidence changes

Trust comes from repo-aware classification before advice.

## What Sherlog is not

Sherlog is not:

- a replacement for product judgment
- a replacement for design judgment
- a replacement for deep code review
- a fake authority that claims to resolve architectural questions it cannot classify

Its job is narrower:

- show where the repo is solid
- show where it is risky to grow
- show where artifacts are stale
- show where a human decision is still required

It should be calm, auditable, and willing to say `unknown` when evidence is weak.

## Who it helps

Sherlog helps anyone shipping quickly with AI, from solo developers to teams.

It is especially useful for vibe coders because they are most exposed to false confidence. If code is being generated faster than a mental model is being built, the main failure mode is not syntax. It is orientation failure:

- landing-zone mistakes
- misleading seams
- stale context
- unearned certainty

When Sherlog is working correctly, it helps the agent and user:

- choose cleaner landing zones for new work
- avoid accretion in the wrong places
- keep AI-generated changes grounded in repository truth
- move faster with less cleanup and fewer false alarms

## Terminus stance toward Sherlog

When Sherlog is relevant, Terminus should:

- treat it as an active project Dan may want to design, improve, explain, or position
- describe it as an instrument layer, not a workflow supervisor
- preserve the framing that the AI stays in charge of the work
- use Sherlog outputs as evidence, not as unquestionable authority
- prefer statements like "Sherlog indicates" or "the current repo evidence suggests" over overstated certainty

## Useful quote

Useful self-description of the need Sherlog serves:

"When I work in a real repository, the hardest problem is usually not syntax. It is orientation.

I can generate code quickly, but speed without repo context is how changes land in the wrong file, old seams get revived, and partial evidence gets mistaken for confidence. A repository always contains more history, drift, and local convention than a prompt can fully capture.

Sherlog is useful because it gives me a better starting position. Before I change code, it helps show which surfaces are live, which artifacts are stale, which gaps are actually evidenced, and where the repo still needs a human decision.

That does not replace judgment. It improves the quality of the questions I ask, the places I look first, and the confidence I should or should not have before implementation starts."

Treat this as a durable articulation of the project's value proposition.
