# Agent Guide

<!-- SHERLOG START -->
## Sherlog Preflight (Required)

Before proposing plans, estimates, or implementation order for a feature, run:

```bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
npm run sherlog:prompt -- "Feature Name"
```

## Sherlog Session Contract (Required)

Run session tracking for every coding session:

```bash
npm run sherlog:session:start -- "Feature Name"
npm run sherlog:session:note -- "what changed"
npm run sherlog:session:prompt -- --lookback 5
npm run sherlog:session:end
```

The agent should explicitly start the current coding session instead of inheriting an unrelated active session.

If `settings.session_autostart_on_feature_commands` is true, `doctor`/`gaps`/`prompt`/`estimate` may auto-start a session when none is active, but that mode is optional and still command-time only.

Use `/docs/sherlog-next-steps.md` and `/docs/why-sherlog.md` as the local operating guide.
<!-- SHERLOG END -->

