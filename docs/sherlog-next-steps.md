# Sherlog Velocity: Operational Protocol

## Phase 1: Establish Baseline (Immediate)
- [ ] Verify install wiring and config:
  `npm run sherlog:verify -- --json`
- [ ] Seed data: run `npm run velocity:run` at least 5 times (or once per day) to build history.
- [ ] First report: run `npm run velocity:report` and verify `docs/velocity-forecast.md`.

## Phase 2: Active Workflow (Daily)
- [ ] One-command system health check:
  `npm run sherlog:doctor -- --feature "Feature Name" --json`
- [ ] Estimation before work:
  `npm run velocity:estimate -- --feature "Feature Name"`
- [ ] Inspect raw gaps:
  `npm run sherlog:gaps -- --feature "Feature Name" --json`
- [ ] Review salience ranking and delta trend in gap output (RC2 contradiction score).
- [ ] AI context prompt:
  `npm run sherlog:prompt -- "Feature Name"`

## Phase 3: Automation (Weekly)
- [ ] CI/Hooks: add `npm run velocity:run` to `.husky/pre-commit` or CI.
- [ ] Context map maintenance: run `npm run sherlog:init-context -- --force` after major refactors.
- [ ] Optional acknowledgements: maintain `sherlog.acknowledgements.json` with defer/exempt entries and expiries.
- [ ] Inspect raw context drift: `npm run sherlog:gaps -- --feature "Feature Name" --json`
- [ ] Phase 4 active: map staleness/drift checks run during `velocity:estimate`, `sherlog:gaps`, and `sherlog:prompt`.
- [ ] Review known integration pitfalls: `docs/sherlog-lessons-learned.md`
