# Sherlog Operational Lessons Learned

This file captures failure patterns seen during real cross-repo installations.

## Failure Patterns

1. UI component exists but is not mounted
- `VelocityPanel` can exist in source while never being rendered in the app.
- Result: people think Sherlog UI is broken when it is just unmounted.

2. AGENTS instructions drift from actual scripts
- `AGENTS.md` may tell agents to run `sherlog:doctor`, but host `package.json` does not define it.
- Result: AI preflight fails before any useful analysis.

3. Empty or broad `source_roots`
- Missing or overly broad roots (for example `"."`) cause false `missing_implementation` and noisy matches.
- Result: low trust in gap output.

4. Archive folders pollute feature scanning
- Archived/legacy directories can contain feature-like tokens and inflate `context_drift`.
- Result: contradictions appear where none exist in active code.

## Operational Guardrail

Run this sequence after install and before feature planning:

```bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
```

If `sherlog:verify` reports warnings/failures, fix those before relying on estimates.
