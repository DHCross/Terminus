# Why Sherlog

Sherlog is a context-intelligence layer for planning and execution.

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
