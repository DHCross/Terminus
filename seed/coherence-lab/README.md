## Coherence Lab Seed Pack

This seed pack turns Terminus into a continuity scaffold for Dan's work on:

- coherence engines
- Logos Theory
- contradiction dynamics in transformers
- continuity and memory as external state
- local open-model experimentation
- falsifiable research design over anthropomorphic drift

It does not modify the native app source code. It seeds Terminus's mounted `user/` data with:

- one persona: `terminus`
- one prompt preset: `terminus_lab`
- a custom merged toolset: `coherence_lab`
- one disabled continuity task you can enable later
- project-aware prompt framing for multiple active domains
- eleven Markdown knowledge notes you can upload into Mind > Knowledge

Install from this repo with:

```bash
./scripts/install-coherence-lab.sh
```

Then in Terminus:

1. Start Terminus normally.
2. Switch to the `terminus` persona.
3. If you want autonomous continuity, enable `Terminus Daily Brief` in Continuity.
4. If you want richer long-term context, upload the files in `seed/coherence-lab/knowledge/` into Mind > Knowledge.

Design choice:

- prompts and persona shape the stance
- toolset enables research plus memory
- continuity task gives an optional recurring synthesis loop
- knowledge notes hold the durable project context that should outlive any one chat
- prompt pieces encode how Terminus should frame different projects during planning and implementation
