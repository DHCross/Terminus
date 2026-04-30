# Sherlog Velocity (Drop Package)

A self-assimilating velocity tracker and context intelligence unit.

## Quick Start

1. Drop this folder into your repo root.
2. Install: `node sherlog-velocity/install.js`
3. Run: `npm run velocity:run` (accumulate history)
4. Review or rebuild context map: `npm run sherlog:init-context -- --force` (optional)

Installer flags:

- `--source-root <path>` (repeatable) to override source root detection
- `--force-context` to rebuild `sherlog.context.json` during install

## Commands

You can run commands via `npm run sherlog:<cmd>` or use the included `Taskfile.yml`.

### Taskfile (Recommended) ✅
This starter includes a `Taskfile.yml` configuration for [Task](https://taskfile.dev). Using Task is the recommended, lightweight way to run Sherlog commands and keep them organized outside `package.json`.

**Quick setup:**
1. Install the Task CLI (system package manager):
   - macOS (Homebrew): `brew install go-task/tap/go-task`
   - Linux: follow https://taskfile.dev/installation/
   - Verify: `task --version`
2. (Optional) Install the **Task** VS Code extension for better UI integration: https://marketplace.visualstudio.com/items?itemName=active-c.task
3. Keep `Taskfile.yml` at the repository root (this repo already includes one).

**VS Code Tasks integration & example:**
- We include a sample `.vscode/tasks.json` with common `task` commands (e.g. `task verify`, `task doctor`, `task gaps`, `task prompt`, `task run`, `task test`). Open the Command Palette → `Tasks: Run Task` and select any Task.
- If you prefer different defaults or arguments, edit `.vscode/tasks.json` to add `args` or tweak `presentation` settings.

**Common gotchas & troubleshooting 🔧**
- If VS Code or `task --list` reports `Taskfile not found` or a YAML parse error, run `task --list` in the repo root to see the CLI error (it will show the failing line number and message).
- A frequent cause is an unquoted or broken `desc:` value that contains an unescaped newline or unescaped quotes. Fix by quoting or using a folded scalar (`>`):

  ```yaml
  desc: "Start a new tracking session. Usage: task session:start -- \"Feature Name\" [--type discovery|implementation]"
  # or
  desc: >
    Start a new tracking session. Usage: task session:start -- "Feature Name" [--type discovery|implementation]
  ```

- Line endings/tabs: ensure `Taskfile.yml` uses LF and spaces for indentation (no tabs). Convert CRLF to LF if coming from Windows.
- If you're in a multi-root or `.code-workspace`, confirm the root folder containing `Taskfile.yml` is included in the workspace; otherwise `task` may not detect it.
- Use `task --debug` for verbose parsing diagnostics if needed.

**Examples:**
- `task verify` — verify install wiring
- `task doctor -- --feature "Refactor auth"` — run preflight health check for a feature (note the `--`)
- `task gaps -- --feature "Refactor auth" --json` — detect missing tests/docs (JSON output)
- `task gaps -- --feature "Billing" --vector "payments"` — scope gap analysis to a specific vector (alias for zone/area)
- `task report -- --bucket "api"` — generate velocity report for a specific bucket (filtered metadata)

VS Code will prompt you for the feature name and "Vector / Bucket / Zone" when you run **Sherlog: doctor by vector**, **Sherlog: gaps by vector**, etc. from the Tasks menu.

### Vector / Zone Filtering (`--zone`, `--vector`, `--bucket`, `--area`)

When your repo has a `sherlog.context.json` with named zones, you can scope analysis to specific vectors using `--zone`, `--vector`, `--bucket`, or `--area`.

- These are all aliases for the same scoping mechanism.
- Flags can be repeated: `--vector api --vector ui`
- If the name doesn't match any zone in `sherlog.context.json`, you'll see a `zone_filter_matched_nothing` note in the output
- You can force a feature profile match with `--profile "profile-name"`
- Probe hints can be supplied when feature naming is noisy: `--alias`, `--token`, `--implementation-token`, `--test-token`, `--doc-token`

| Task | NPM Script | Description |
| :--- | :--- | :--- |
| `task run` | `npm run velocity:run` | Take a snapshot of git history and momentum. |
| `task report` | `npm run velocity:report` | Generate `velocity-forecast.md` and artifacts. Supports `--vector`. |
| `task estimate -- ...` | `npm run velocity:estimate` | Estimate time by velocity and gaps. Supports `--vector`. |
| `task verify` | `npm run sherlog:verify` | Verify install wiring, source roots, and active context-map health. |
| `task preflight -- ...` | `npm run sherlog:preflight` | **Preferred AI-agent entry point.** Composes blast-radius, lint-plan, and bounds into a unified telemetry packet. |
| `task doctor -- ...` | `npm run sherlog:doctor` | Run preflight health check. Supports `--vector`. |
| `task gaps -- ...` | `npm run sherlog:gaps` | Return raw gap detector output. Supports `--vector`. |
| `task prompt -- ...` | `npm run sherlog:prompt` | Generate AI prompt with context. Supports `--vector`. |
| `task sonar -- ...` | `npm run sherlog:sonar` | Fetch SonarCloud analysis, write `velocity-artifacts/sonar-report.json`, and register open quality gaps. |
| `task init-context` | `npm run sherlog:init-context` | Rebuild `sherlog.context.json`. |
| `task setup -- ...` | `npm run sherlog:setup` | Guided setup wizard (plan by default, `--apply` to execute). |
| `task bridge -- ...` | `npm run sherlog:bridge` | Upgrade/repair Sherlog in repos already using it (`--dry-run` supported). |
| `task session:start` | `npm run sherlog:session:start` | Start tracking a working session. |
| `task session:end` | `npm run sherlog:session:end` | End the current session. |
| `task session:report` | `npm run sherlog:session:report` | Show aggregate session hours. |
| `task session:status` | `npm run sherlog:session:status` | Check activie session. |
| `task session:note` | `npm run sherlog:session:note` | Add a note to the active session. |
| `task session:prompt` | `npm run sherlog:session:prompt` | Show multiplier, wasted-time ledger, and boss-ready session summary. |

## Preflight: AI-Agent Entry Point

**`npm run sherlog:preflight`** (or `task preflight`) is the preferred entry point for AI agents before making code mutations. It composes existing Sherlog telemetry instruments into a single, unified JSON packet designed for agent consumption.

### Usage

```bash
# Analyze a file's blast radius
npm run sherlog:preflight -- --file src/app/api/raven-chat/protocolRules.ts --json

# Validate a plan file
npm run sherlog:preflight -- --plan-file plan.json --json

# Get bounds for a feature
npm run sherlog:preflight -- --feature "Add user authentication" --json
```

### Output Schema

Preflight returns a stable JSON packet with telemetry framing (not approval authority):

```json
{
  "schema_version": "sherlog.preflight.v1",
  "mode": "telemetry",
  "inputs": {
    "file": null,
    "plan_file": null,
    "feature": null
  },
  "status": "clear | caution | blocked_by_policy | unknown",
  "blast_radius": null,
  "plan_lint": null,
  "bounds": null,
  "recommended_checks": [],
  "warnings": [],
  "unknowns": [],
  "operator_note": "Sherlog is an instrument panel, not an approval authority. Use this packet to adjust the edit vector before mutation."
}
```

### Status Values

- **`clear`**: No blocking issues detected. Proceed with mutation.
- **`caution`**: Elevated blast radius or risky zones detected. Review recommended checks before proceeding.
- **`blocked_by_policy`**: Do-not-touch zones or explicit policy violations detected. Do not proceed without explicit override.
- **`unknown`**: Analysis failed or insufficient data. Requires manual review.

### Composed Instruments

Preflight orchestrates the following existing tools:

- **`--file`**: Runs blast-radius analysis via `analyzeBlastRadius()`
- **`--plan-file`**: Runs lint-plan validation via `lintPlan()`
- **`--feature`**: Runs bounds generation via `generateStaticBounds()`

The command does not duplicate core analysis logic—it imports and composes the existing exported functions from each instrument.

## Bridge Upgrade Runbook (for existing installs)

Use `bridge` when a repo already has Sherlog and you need to safely apply the latest wiring/config updates.

### Quick commands

```bash
# 1) Preview only (no file changes)
task bridge -- --dry-run --json

# 2) Apply upgrade + repair
task bridge -- --json

# 3) Enforce clean post-upgrade verify state (CI-friendly)
task bridge -- --strict --json
```

NPM equivalent:

```bash
npm run sherlog:bridge -- --dry-run --json
npm run sherlog:bridge -- --json
npm run sherlog:bridge -- --strict --json
```

### What bridge does

1. Runs a pre-upgrade verify snapshot.
2. Creates backups under `.logs/sherlog-bridge/<timestamp>/`.
3. Re-runs install wiring (unless `--no-install`).
4. Runs post-upgrade verify and reports pass/warn/fail delta.

### Key flags

- `--dry-run`: assess only, no writes.
- `--strict`: non-zero exit if post-bridge verify contains failures.
- `--force-context`: forces context regeneration through installer.
- `--no-install`: skip install.js rerun (diagnostic mode).
- `--repo-root <path>`: target another repo root explicitly.

### Updating other repos/customers

For external rollouts, send this exact sequence:

```bash
task bridge -- --dry-run --json
task bridge -- --json
task verify
```

Ask them to share the JSON output from dry-run/apply so you can review:

- pre/post verify counts,
- backup location,
- any reported errors.

This gives you a repeatable upgrade protocol without manually editing each client repo.

## Session Tracking

Sherlog now supports "Session Tracking" to build a ground-truth dataset of how long tasks actually take.

**Workflow (Task):**
1. Start work: `task session:start -- "Refactoring Login"`
   * Or: `task session:start -- "Layout Investigation" --type discovery`
2. Add insights: `task session:note -- "Found build script in sibling repo!"`
3. Correction: `task session:update -- --type discovery`
4. Check status: `task session:status`
5. Finish work: `task session:end`
6. Generate session output features: `task session:prompt`

**Workflow (NPM):**
1. Start work: `npm run sherlog:session:start -- "Refactoring Login"`
2. Add insights: `npm run sherlog:session:note -- "Found note..."`
...

**Features:**
- **Zero Overhead:** No background processes. State is stored in a static JSON file.
- **Context Aware:** Automatically captures your current git branch and working directory (`cwd`).
- **Discovery Mode:** Capture "Invisible Work" (debugging/research) that doesn't result in commits but is high-value.
- **Data Forward:** Logs are stored in `sherlog-velocity/data/session-log.jsonl` for future analysis or AI calibration.
- **Prompt Output Features:** `sherlog:prompt` now includes session-derived `invisible work multiplier`, `wasted time ledger`, and a concise `boss-ready report` summary.

## AI Preflight Contract

For any AI agent using this repo, run this sequence before proposing implementation order:

Task-first (when `Taskfile.yml` exists):
```bash
task verify
task doctor -- --feature "Feature Name"
task gaps -- --feature "Feature Name"
task prompt -- "Feature Name"
```

NPM fallback:
```bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
npm run sherlog:prompt -- "Feature Name"
```

- `doctor` gives machine-readable health + recommended next action.
- `gaps` provides raw evidence and salience ranking.
- `prompt` translates repository state into execution-ready AI instructions.
- `verify` catches broken install wiring and false-positive risk before planning.

On install, Sherlog also generates:

- `docs/sherlog-next-steps.md`
- `docs/why-sherlog.md`
- `docs/sherlog-lessons-learned.md`
- `AGENTS.md` (or updates it with a Sherlog preflight block)

## Operational Phase Checklist

### Phase 1: Seed

- Run `velocity:run` until you have 5+ data points.
- Verify `docs/velocity-forecast.md` is generating correctly.

### Phase 2: Integrate

- Use `sherlog:prompt` before every major feature.
- This feeds your velocity back into AI planning instead of generic timelines.

### Phase 3: Context Intelligence

- Preferred: `install.js` auto-creates `sherlog.context.json` in repo root (tool-agnostic context map).
- Rebuild map after major structural changes with `npm run sherlog:init-context -- --force`.
- Detector checks implementation/tests/docs plus context-map coverage, staleness, and drift.
- Phase 4 active: map staleness and drift checks are included in `velocity:estimate`, `sherlog:gaps`, and `sherlog:prompt`.
- RC2 active: unresolved contradictions accumulate salience via blast radius, temporal pressure, and persistence deltas.

Example setup:

```bash
npm run sherlog:init-context -- --force
npm run sherlog:gaps -- --feature "Feature Name" --json
```

## SonarCloud Integration

Sherlog can now ingest SonarCloud quality results directly into its artifact and gap loop.

### Quick commands

```bash
task sonar -- --dry-run
task sonar -- --pr 245

npm run sherlog:sonar -- --json
npm run sherlog:sonar -- --dry-run
```

### What gets written

1. `velocity-artifacts/sonar-report.json`
2. `sherlog.acknowledgements.json` open entries when the Quality Gate fails

### Why this matters

This keeps SonarCloud findings in the same decision surface as Sherlog gaps instead of forcing a second dashboard.

Sherlog now treats active `status: "open"` acknowledgement entries as first-class external gaps, which is how Sonar failures surface in `doctor` and `gaps`.

### Setup notes

1. Fill `settings.sonar.org` and `settings.sonar.project_key` in `config/sherlog.config.json`.
2. Set `SONARCLOUD_TOKEN`, `SONARCLOUD_ORG`, and `SONARCLOUD_PROJECT` in `.env.local`.
3. Run `npm run sherlog:sonar -- --dry-run` before enabling writes.

Full runbook: `docs/integrations/sonarcloud.md`

## Configuration

- Main config: `config/sherlog.config.json` (paths, settings)
- Gap weights: `config/gap-weights.json` (cost model per missing gap type)
- Context mode: `context.mode` (`sherlog-map`, `none`)
- Context map path: `context.map_file` / `paths.context_map`
- Gap history log: `paths.gap_history_log` (comparative salience baseline)
- Optional acknowledgements: `paths.gap_acknowledgements` (`deferred`/`exempt` with expiry or review cadence)
- External open-gap source: SonarCloud writes `status: "open"` acknowledgement entries that are surfaced directly by `detectGaps()`
- Acknowledgement template: `templates/sherlog.acknowledgements.example.json`
- Profile run history log: `paths.profile_run_history_log` (control-center profile run timeline)
- Profile run artifacts dir: `paths.profile_run_artifacts_dir` (full profile snapshots for handoff/diff review)
- Core suite history log: `paths.core_suite_history_log` (one-click suite run timeline)
- Gap scan archive filter: `settings.gap_scan_ignore_dirs` (exclude legacy/archive paths from drift matching)
- Core suite defaults: `settings.core_suite_features` (default feature list for one-click suite runs)
- Feature aliases: `settings.feature_aliases` (map feature name -> alias list for token probes)
- Feature probe metadata: `settings.feature_metadata` (`test_tokens`, `doc_tokens`, `implementation_tokens`)
- Feature profile registry: `settings.feature_profiles` (intent-first profile keys with aliases, path hints, signal hints, and optional `scope_mode: "bounded"` path enforcement)
- Repo-local feature profile overrides: `sherlog.feature-profiles.json` (preferred for host-repo seam customization)
- Path lanes: `settings.path_lanes` + `settings.path_lanes_default` (strict vs relaxed vs excluded quality surfaces)
- Lane multipliers: `settings.lane_multipliers` (default convergence weighting for strict/relaxed/excluded lanes)
- Convergence thresholds: `settings.convergence_thresholds` (`implementation`, `tests`, `docs`, `overall`)
- Convergence weights: `settings.convergence_weights` (weighted scoring for path/export/callsite/content signals)
- Outside-context warning threshold: `settings.feature_files_outside_context_map_warning_threshold` (default `1`)

Host-repo customization guide: `docs/sherlog-customization-guide.md`

When a profile uses `scope_mode: "bounded"`, `sherlog:gaps --json` also emits:

- `evidence.probe_scope` for the resolved scope mode
- `evidence.scope.path_hints` for the effective scoped allowlists
- `evidence.scope.ignored_out_of_scope` for spillover files that matched signals but were dropped for being outside scope

## Machine Contracts

- `schemas/sherlog.context.schema.json`: schema for `sherlog.context.json`
- `schemas/sherlog.sonar-report.schema.json`: schema for `velocity-artifacts/sonar-report.json`
- `schemas/sherlog.gaps-output.schema.json`: schema for `sherlog:gaps --json`
- `schemas/sherlog.doctor-output.schema.json`: schema for `sherlog:doctor --json`
