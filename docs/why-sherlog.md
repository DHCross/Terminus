# Why Sherlog

Sherlog is a context-intelligence layer for planning and execution.

It should be treated as an on-demand instrument the agent calls, not a supervising background process. The goal is to help vibe coders keep the AI in charge of the active workflow while still giving that AI sharper delivery grounding, gap detection, and context control.

1. Personalized velocity:
   it uses your repository history to estimate timelines from real delivery pace.
2. Explicit gaps:
   it turns vague uncertainty into concrete missing pieces (implementation/tests/docs/context).
3. Context drift detection:
   it compares code changes against your context map and flags stale or uncovered areas.

Use this command first when planning a feature:

```bash
npm run sherlog:doctor -- --feature "Feature Name" --json
```
