# Sherlog Lessons Learned

These are the most common reasons Sherlog appears installed but is not truly operational.

## 1) UI exists but is not mounted
- Symptom: `VelocityPanel` file exists, but no route/page imports it.
- Fix: mount `VelocityPanel` in a real route if you want in-app visibility.

## 2) AGENTS instructions drift from scripts
- Symptom: `AGENTS.md` says run `sherlog:doctor`, but host `package.json` lacks that script.
- Fix: run `node sherlog-velocity/install.js` again, then `npm run sherlog:verify -- --json`.

## 3) Empty or over-broad source roots
- Symptom: constant `missing_implementation` false positives.
- Fix: set `paths.source_roots` to real code roots (for example `vessel/src`), avoid `.` when possible.

## 4) Forced repomix mode without matching artifacts
- Symptom: recurring `integration` / `missing_bundle` pressure even when feature code exists.
- Fix: only use repomix-compatible mode when manifest/config is present and maintained.

## 5) Archive directories inflate drift
- Symptom: `context_drift` triggered by legacy/archived files unrelated to current work.
- Fix: add archive paths to `settings.gap_scan_ignore_dirs` in Sherlog config.

## Operational Rule
Before planning features in a new repo, run:

```bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
```
