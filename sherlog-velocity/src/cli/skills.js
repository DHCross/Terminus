#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * sherlog skills - Identify and generate VS Code Agent Skills for this repo.
 *
 * Sherlog is not an LLM and cannot judge "value" on its own, but it CAN
 * produce a structured evidence brief from its existing analysis artifacts
 * (self-model, gap history, hygiene, context map). An AI agent running in
 * this repo can read that brief to decide which Agent Skills to install or
 * generate - and this command can also write the .skill files directly,
 *               plus compatibility SKILL.md mirrors for IDE loaders that
 *               still expect the folder-based layout.
 * using rule-based templates mapped to detected evidence patterns.
 *
 * Modes:
 *   --suggest   (default) Output a JSON skill brief: repo fingerprint +
 *               ranked skill recommendations with rationale. Output is
 *               persisted to sherlog-velocity/data/skills-suggest.json so
 *               --generate can replay it without re-running analysis.
 *   --generate  Write .skill files to .github/skills/ (or --output dir).
 *               Reads the persisted suggest artifact when available.
 *
 * Usage:
 *   node sherlog-velocity/src/cli/skills.js [--suggest] [--json] [--no-persist]
 *   node sherlog-velocity/src/cli/skills.js --generate [--output <dir>] [--force] [--fresh]
 */

const fs = require('fs');
const path = require('path');
const { readJson, readJsonLines, resolveRepoRoot } = require('../core/shared');
const { getSelfModel } = require('../core/self-model');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  if (!config) {
    return { config: null, configPath };
  }
  return { config, configPath };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    suggest: false,
    generate: false,
    output: null,
    force: false,
    fresh: false,      // --generate: re-run analysis even if artifact exists
    noPersist: false,  // --suggest: skip writing the artifact
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--suggest') out.suggest = true;
    else if (arg === '--generate') out.generate = true;
    else if ((arg === '--output' || arg === '-o') && argv[i + 1]) out.output = argv[++i];
    else if (arg === '--force') out.force = true;
    else if (arg === '--fresh') out.fresh = true;
    else if (arg === '--no-persist') out.noPersist = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  // default to suggest if neither mode is given
  if (!out.suggest && !out.generate) out.suggest = true;

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/skills.js [options]');
  console.log('');
  console.log('Modes (default: --suggest):');
  console.log('  --suggest            Output a JSON skill brief for this repo');
  console.log('  --generate           Write .skill files to .github/skills/');
  console.log('');
  console.log('Options:');
  console.log('  -o, --output <dir>   Output directory for --generate (default: .github/skills)');
  console.log('  --force              Overwrite existing .skill files');
  console.log('  --fresh              Re-run analysis even if a suggest artifact exists (--generate)');
  console.log('  --no-persist         Skip saving the suggest artifact (--suggest)');
  console.log('  --json               Force JSON output in --suggest mode');
  console.log('  --help, -h           Show this message');
}

// ---------------------------------------------------------------------------
// Evidence loading
// ---------------------------------------------------------------------------

function loadEvidence(config, repoRoot) {
  const evidence = {
    self_model: null,
    gap_history: [],
    hygiene_history: [],
    context_map: null,
    config,
  };

  // self-model (read from persisted cache; do not regenerate - that's for index-sync/init-context)
  try {
    const result = getSelfModel(repoRoot, { config, persist: false });
    evidence.self_model = result.model;
  } catch {
    evidence.self_model = null;
  }

  // gap history
  if (config.paths?.gap_history_log) {
    const gapPath = path.isAbsolute(config.paths.gap_history_log)
      ? config.paths.gap_history_log
      : path.join(repoRoot, config.paths.gap_history_log);
    evidence.gap_history = readJsonLines(gapPath);
  }

  // hygiene history
  if (config.paths?.hygiene_history_log) {
    const hygienePath = path.isAbsolute(config.paths.hygiene_history_log)
      ? config.paths.hygiene_history_log
      : path.join(repoRoot, config.paths.hygiene_history_log);
    evidence.hygiene_history = readJsonLines(hygienePath);
  }

  // context map
  const ctxPath = config.paths?.context_map
    ? (path.isAbsolute(config.paths.context_map)
        ? config.paths.context_map
        : path.join(repoRoot, config.paths.context_map))
    : path.join(repoRoot, 'sherlog.context.json');
  evidence.context_map = readJson(ctxPath, null);

  return evidence;
}

// ---------------------------------------------------------------------------
// Repo fingerprint (machine-readable summary for the skill brief)
// ---------------------------------------------------------------------------

function buildFingerprint(evidence) {
  const sm = evidence.self_model;
  const cm = evidence.context_map;
  const config = evidence.config;

  const zones = Array.isArray(cm?.zones)
    ? cm.zones.map(z => ({ name: z.name, belief: z.belief || null, ship_ready: z.ship_ready || false }))
    : [];

  // Aggregate gap type frequency from gap history
  const gapFreq = {};
  for (const entry of evidence.gap_history) {
    const gapList = Array.isArray(entry.gaps) ? entry.gaps : [];
    for (const g of gapList) {
      gapFreq[g] = (gapFreq[g] || 0) + 1;
    }
  }
  const topGapTypes = Object.entries(gapFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => ({ type, count }));

  // Hygiene trend from most recent hygiene history entry
  const latestHygiene = evidence.hygiene_history.length > 0
    ? evidence.hygiene_history[evidence.hygiene_history.length - 1]
    : null;
  const hygieneTrend = latestHygiene?.trends?.overall || 'insufficient_data';
  const hygieneFindings = latestHygiene?.summary?.total_findings ?? null;

  return {
    source_roots: config.paths?.source_roots || [],
    zone_count: zones.length,
    zones,
    liveness: sm?.summary?.liveness_counts || null,
    fragile_file_count: sm?.summary?.fragile_file_count ?? null,
    dead_or_scaffold_files: sm?.summary?.dead_or_scaffold_files ?? null,
    total_modules: sm?.summary?.total_modules ?? null,
    top_gap_types: topGapTypes,
    gap_history_entries: evidence.gap_history.length,
    hygiene_trend: hygieneTrend,
    hygiene_findings: hygieneFindings,
    context_mode: config.context?.mode || 'none',
    session_autostart: config.settings?.session_autostart_on_feature_commands || false,
  };
}

// ---------------------------------------------------------------------------
// Skill definitions (templates)
// ---------------------------------------------------------------------------

const SKILL_TEMPLATES = {
  'sherlog-preflight': {
    name: 'sherlog-preflight',
    description: (fp) => {
      const zoneNote = fp.zone_count > 0 ? `${fp.zone_count} declared zone${fp.zone_count !== 1 ? 's' : ''}` : 'no declared zones';
      return `Required preflight gate for this repo (${zoneNote}, ${fp.context_mode} context mode). Run before implementing any feature, proposing a plan, or estimating effort.`;
    },
    priority: 'required',
    trigger: 'before implementing a feature, proposing a plan, or estimating effort',
    template: (fingerprint) => {
      const cmds = [
        'task verify',
        'task doctor -- --feature "<Feature Name>"',
        'task gaps -- --feature "<Feature Name>"',
        'task prompt -- "<Feature Name>"',
      ];
      const zoneList = fingerprint.zones.length > 0
        ? '\n\nDeclared zones in this repo:\n' + fingerprint.zones.map(z => `- **${z.name}**${z.belief ? ': ' + z.belief : ''}`).join('\n')
        : '';
      return `# Sherlog Preflight

## When to Load This Skill

- Always - this is a required gate before any feature work in this repo
- Before implementing a feature in any of the ${fingerprint.zone_count || 0} declared zone${fingerprint.zone_count !== 1 ? 's' : ''}
- Before proposing an implementation plan, task ordering, or estimate
- When \`task verify\` has not been run in the current session
- When asked to plan, scope, or begin work on any named feature

Before proposing implementation plans, estimates, or task ordering for any feature, run the Sherlog preflight sequence. Sherlog reads the actual repository state - velocity history, gap evidence, context map, and hygiene - and surfaces grounded facts that prevent false confidence.

## Preflight Sequence

Replace \`<Feature Name>\` with the name of the feature or task you are about to work on.

\`\`\`bash
${cmds.join('\n')}
\`\`\`

## How to Read the Output

- **\`verify\`** - confirms Sherlog wiring is intact; if it fails, stop and repair before continuing.
- **\`doctor\`** - returns \`recommendation.action\`. Act on \`seed_velocity_history\`, \`initialize_context_map\`, or \`repair_context_map\` before continuing.
- **\`gaps\`** - lists detected gaps by type. Blocking gaps (e.g., \`critical_artifact_missing\`, \`security_exposure\`) must be resolved before shipping.
- **\`prompt\`** - generates the execution brief. Feed this output into your implementation plan.

## Rules

- Do NOT propose an implementation plan before running \`doctor\` and \`gaps\`.
- Do NOT enable scheduled GitHub Actions workflows automatically.
- If \`verify\` exits non-zero, fix the wiring first.
${zoneList}`;
    },
  },

  'sherlog-gaps': {
    name: 'sherlog-gaps',
    description: (fp) => {
      if (fp.top_gap_types.length > 0) {
        const top3 = fp.top_gap_types.slice(0, 3).map(g => g.type).join(', ');
        return `Interpret and resolve Sherlog gap evidence in this repo. Recurring gaps in history: ${top3}. Use before declaring any feature complete or ready to ship.`;
      }
      return 'Interpret and resolve Sherlog gap evidence for missing tests, docs, and implementation. Use before declaring any feature done or proposing a ship.';
    },
    priority: 'high',
    trigger: 'when gap evidence is present, coverage is missing, or before declaring a feature complete',
    template: (fingerprint) => {
      const topGaps = fingerprint.top_gap_types.slice(0, 5).map(g => `- \`${g.type}\` (seen ${g.count}x in gap history)`).join('\n') || '- No gap history recorded yet - run `task gaps -- --feature "<Feature Name>"` to start building evidence';
      const routingGapNote = fingerprint.top_gap_types.length > 0
        ? `- When \`${fingerprint.top_gap_types[0].type}\` appears in output (most frequent in this repo)`
        : '- When `task gaps` output shows any open findings';
      return `# Sherlog Gap Analysis

## When to Load This Skill

- When \`task gaps\` or \`task doctor\` output shows open gap findings
- Before declaring any feature complete, done, or ready to merge
- When \`doctor\` recommendation is \`add_tests\` or \`start_implementation\`
${routingGapNote}
- When a feature's \`ship_ready\` flag is true and blocking gaps are present

Gap evidence tells you what is missing before you ship. Use this skill when \`task gaps\` output shows open gaps, or when declaring a feature complete.

## Interpreting Gap Output

\`\`\`bash
task gaps -- --feature "<Feature Name>"
\`\`\`

### Gap Tiers

**Blocking** - must resolve before shipping:
- \`critical_artifact_missing\` - a required file declared in the context map is absent
- \`security_exposure\` - security-relevant gap detected
- \`data_integrity\` - data safety concern
- \`build_break\` - build will fail

**Advisory** - should resolve; degrades velocity if ignored:
- \`missing_implementation\` - feature files not found
- \`missing_tests\` / \`test_coverage\` - implementation exists but tests do not
- \`documentation\` - undocumented feature
- \`stale_context\` / \`context_drift\` - context map has drifted from reality
- \`arch_monolith\` / \`architectural_limit_exceeded\` - structural debt

## Common Gap Patterns in This Repo

Based on recorded gap history:
${topGaps}

## Resolving Gaps

1. Run \`task gaps -- --feature "<Feature Name>"\` to see current evidence.
2. For \`missing_tests\` / \`test_coverage\`: add tests to the matching test root before marking done.
3. For \`stale_context\` / \`context_drift\`: run \`task init-context -- --force\` to rebuild the context map when that maintenance is intended.
4. For \`missing_implementation\`: run \`task prompt -- "<Feature Name>"\` to get an execution brief.
5. For \`arch_monolith\`: use \`task bounds -- --feature "<Feature Name>"\` to find safe edit scope.

## Checking Gap History

Gap history is stored in \`sherlog-velocity/data/gap-history.jsonl\` - each line is a snapshot. Review it to see which gaps are persistent vs one-off.`;
    },
  },

  'sherlog-session': {
    name: 'sherlog-session',
    description: (fp) => `Track invisible discovery work and rework in this repo (${fp.total_modules ?? '?'} modules across ${fp.zone_count} zone${fp.zone_count !== 1 ? 's' : ''}). Use when starting or ending any feature coding session.`,
    priority: 'high',
    trigger: 'when starting or ending a coding session, feature implementation, or discovery phase',
    template: (fingerprint) => `# Sherlog Session Tracking

## When to Load This Skill

- When starting a new feature coding session in this repo
- When switching from discovery to implementation work on a feature
- When asked to log progress, check velocity, or generate a status summary
- When a previous session ended unexpectedly and needs to be closed

Sherlog sessions capture the invisible work - discovery, debugging, rework - that doesn't show in commits but drives real velocity. This repo has ${fingerprint.total_modules ?? '?'} indexed modules across ${fingerprint.zone_count} declared zone${fingerprint.zone_count !== 1 ? 's' : ''}; session data keeps velocity estimates grounded.

## Session Lifecycle

\`\`\`bash
# Start a session before coding
task session:start -- "<Feature Name>" --type discovery

# Log discoveries as you work
task session:note -- "Found that X depends on Y, rethinking approach"

# Check what you've captured
task session:status

# Generate a session prompt (includes invisible work multiplier)
task session:prompt -- --lookback 5

# End the session when done
task session:end
\`\`\`

## Session Types

- \`discovery\` - research, investigation, debugging unknown behavior
- \`implementation\` - writing code with a clear plan

Start as \`discovery\` if you don't yet know the scope; switch with \`task session:update -- --type implementation\` once the approach is clear.

## What Sessions Feed Into

- **Invisible work multiplier** - \`session:prompt\` shows how much real time exceeded apparent time
- **Wasted-time ledger** - rework commits (fix, revert, hotfix) are detected automatically
- **Boss-ready summary** - one-paragraph status generated from session data
- **\`task prompt\`** output - session context is included in execution briefs

## Rules

- Always start an explicit session for a feature rather than inheriting a stale active session.
- Run \`task session:status\` to check if a session is already active before starting a new one.
- If a session ended unexpectedly, run \`task session:end\` to close it cleanly before starting a new one.`,
  },

  'sherlog-hygiene': {
    name: 'sherlog-hygiene',
    description: (fp) => {
      if (fp.hygiene_trend === 'worsening') {
        const count = fp.hygiene_findings !== null ? ` (${fp.hygiene_findings} findings)` : '';
        return `Hygiene trend is worsening in this repo${count}. Use immediately when adding code or before any merge to prevent compounding quality debt.`;
      }
      if (fp.hygiene_findings !== null && fp.hygiene_findings > 0) {
        return `${fp.hygiene_findings} hygiene findings active in this repo (TODO clusters, console.log, TypeScript any, monoliths). Use before releasing or merging.`;
      }
      return 'Scan and resolve code hygiene issues (TODO clusters, console.log, TypeScript any, monoliths). Use before releasing or after rapid feature development.';
    },
    priority: 'medium',
    trigger: 'when code quality is degrading, before a release, or after rapid feature development',
    template: (fingerprint) => {
      const trendNote = fingerprint.hygiene_trend === 'worsening'
        ? '> **Warning**: Hygiene trend is currently **worsening** in this repo. Address findings before they compound.\n\n'
        : fingerprint.hygiene_trend === 'improving'
          ? '> Hygiene trend is **improving**. Continue the pattern.\n\n'
          : '';
      const routingTrendLine = fingerprint.hygiene_trend === 'worsening'
        ? '- When adding any new code (trend is worsening - every session matters)'
        : '- When hygiene trend changes to `worsening` in `task doctor` output';
      return `# Sherlog Hygiene Scan
${trendNote}
## When to Load This Skill

- When \`task doctor\` recommendation is \`run_hygiene_scan\`
${routingTrendLine}
- Before any release, merge to main, or sprint review
- After rapid feature development where quality shortcuts were taken
- When hygiene output shows findings above threshold

Hygiene scans detect structural code quality issues that accumulate during fast development cycles.

## Running a Scan

\`\`\`bash
task hygiene -- --json
\`\`\`

## Issue Types

| Type | What It Means | Default Threshold |
|------|---------------|-------------------|
| \`todo_cluster\` | 3+ TODO/FIXME markers near each other | 3 per cluster |
| \`console_log_spam\` | Unguarded console.log in source | 0 allowed |
| \`any_usage\` | TypeScript \`any\` without suppression comment | 5 per file |
| \`monolith\` | File exceeds line or size limit | 500 lines / 150KB |
| \`missing_docs\` | 100+ line file without JSDoc | configurable |

## Resolving Findings

1. **\`todo_cluster\`**: Convert TODO groups to tracked issues or implement them. Don't leave clusters growing.
2. **\`console_log_spam\`**: Remove or replace with a logger abstraction before merging.
3. **\`any_usage\`**: Add proper types or \`// eslint-disable-next-line @typescript-eslint/no-explicit-any\` with a rationale comment.
4. **\`monolith\`**: Split the file at natural seam boundaries. Use \`task bounds -- --feature "<Feature Name>"\` to find safe edit scope.

## Tuning Thresholds

Edit \`sherlog-velocity/config/sherlog.config.json\` under \`settings.hygiene\`:
\`\`\`json
"hygiene": {
  "todo_cluster_threshold": 3,
  "console_log_max": 0,
  "any_usage_max": 5,
  "monolith_line_threshold": 500
}
\`\`\``;
    },
  },

  'sherlog-fragility': {
    name: 'sherlog-fragility',
    description: (fp) => {
      const count = fp.fragile_file_count ?? 0;
      if (count > 0) {
        return `${count} fragile file${count !== 1 ? 's' : ''} detected in self-model. Use before touching high-churn or highly-coupled modules in this repo.`;
      }
      return 'Guide for safely refactoring fragile files. Use when touching modules with high churn, high coupling, or elevated fragility scores in the self-model.';
    },
    priority: 'medium',
    trigger: 'when refactoring risky or frequently-changed files, or before touching high-churn modules',
    template: (fingerprint) => {
      const fragileCount = fingerprint.fragile_file_count ?? 0;
      const misleadingCount = fingerprint.liveness?.Misleading ?? 0;
      const countNote = fragileCount > 0
        ? `This repo currently has **${fragileCount} fragile file${fragileCount !== 1 ? 's' : ''}** above the fragility threshold.\n\n`
        : '';
      const misleadingLine = misleadingCount > 0
        ? `- When touching any of the ${misleadingCount} Misleading files (stubs that are already wired into the dependency graph)`
        : '- When a file has placeholder signals (TODO/stub) but is already imported by other modules';
      return `# Sherlog Fragility - Safe Refactoring Guide
${countNote}
## When to Load This Skill

- When touching files listed in \`fragile_files[]\` in \`sherlog-velocity/data/self-model.json\`
- When a file appears in \`churn_hotspots\` (many recent commits = actively contested)
- Before refactoring a dependency hub (high \`inbound_count\` = many consumers break if interface changes)
${misleadingLine}
- When refactoring any module larger than 400 lines or with more than 10 exports

Sherlog's self-model scores every file on fragility: a composite of line count, export count, coupling, and recent churn. High-fragility files carry the most risk during changes.

## Finding Fragile Files

\`\`\`bash
# Rebuild the self-model index
task index-sync

# The self-model is at:
# sherlog-velocity/data/self-model.json
# Look at: fragile_files[], dependency_hubs[], churn_hotspots[]
\`\`\`

## Fragility Score

| Score | Label | Risk |
|-------|-------|------|
| 5-7 | HIGH | Risky to touch without tests; consider splitting |
| 3-4 | MEDIUM | Elevated care required |
| 0-2 | LOW | Routine changes safe |

## Before Touching a High-Fragility File

1. Run \`task gaps -- --feature "<Feature Name>"\` - if \`test_coverage\` is a gap, add tests first.
2. Run \`task bounds -- --feature "<Feature Name>"\` to see safe edit scope.
3. Check \`churn_hotspots\` in \`self-model.json\` - files with many recent commits are actively changing.
4. Check \`dependency_hubs\` - files with high inbound count break many consumers if their interface changes.

## Coupling and Liveness

- **Misleading**: file has placeholder signals (TODO/stub) AND is wired (imported by others). Fix the stubs before relying on it.
- **Dead**: no inbound, no outbound, no churn, stale. Consider removing or archiving.
- **Scaffold**: incomplete but not yet wired. Safe to rework without cascading breakage.`;
    },
  },
};

// ---------------------------------------------------------------------------
// Skill recommendation engine (rule-based, with confidence + evidence)
// ---------------------------------------------------------------------------

/**
 * Evidence thresholds for each skill. A skill is emitted only when its
 * minimum evidence requirements are met; otherwise it is marked 'skip' so
 * callers can see why it was withheld rather than silently omitted.
 *
 * Confidence levels:
 *   high   - multiple independent evidence sources confirm the need
 *   medium - one solid evidence source or partial corroboration
 *   low    - inferred from thin data (e.g., only defaults, no history yet)
 */
const SKILL_EVIDENCE_THRESHOLDS = {
  'sherlog-preflight': {
    // Always emit - Sherlog being installed IS the evidence
    minGapHistoryEntries: 0,
    minZones: 0,
  },
  'sherlog-gaps': {
    // Emit when there is any recorded gap history OR declared zones
    minGapHistoryEntries: 0,
    minZones: 0,
  },
  'sherlog-session': {
    // Useful once the repo has some modules to track
    minTotalModules: 3,
  },
  'sherlog-hygiene': {
    // Emit only when we have at least one hygiene scan on record
    // OR there is gap history referencing hygiene gap types
    minHygieneHistoryEntries: 1,
    hygieneGapTypes: ['hygiene_any_abuse', 'hygiene_complexity_hotspot'],
  },
  'sherlog-fragility': {
    // Emit only when self-model has actually identified fragile files
    minFragileFiles: 1,
  },
};

/**
 * Build the evidence payload for a given skill from the fingerprint.
 * Returns { sources: string[], confidence: 'high'|'medium'|'low', skip: boolean, skipReason?: string }
 */
function assessEvidence(skillName, fingerprint, evidenceRaw) {
  const sources = [];
  let confidence = 'low';
  let skip = false;
  let skipReason;

  switch (skillName) {
    case 'sherlog-preflight': {
      // Structural: config file present means Sherlog is wired
      sources.push('sherlog_config_present');
      if (fingerprint.zone_count > 0) sources.push(`${fingerprint.zone_count}_declared_zones`);
      if (fingerprint.gap_history_entries > 0) sources.push(`${fingerprint.gap_history_entries}_gap_history_entries`);
      confidence = 'high'; // always confident - preflight is axiomatic
      break;
    }
    case 'sherlog-gaps': {
      if (fingerprint.gap_history_entries > 0) {
        sources.push(`gap_history_${fingerprint.gap_history_entries}_entries`);
        confidence = fingerprint.gap_history_entries >= 5 ? 'high' : 'medium';
      }
      if (fingerprint.zone_count > 0) {
        sources.push(`${fingerprint.zone_count}_context_zones`);
        if (confidence === 'low') confidence = 'medium';
      }
      if (fingerprint.top_gap_types.length > 0) {
        sources.push(`top_gap_types:${fingerprint.top_gap_types.slice(0, 3).map(g => g.type).join(',')}`);
        confidence = 'high';
      }
      // Never skip gaps - structural requirement
      break;
    }
    case 'sherlog-session': {
      const minModules = SKILL_EVIDENCE_THRESHOLDS['sherlog-session'].minTotalModules;
      if (fingerprint.total_modules !== null && fingerprint.total_modules >= minModules) {
        sources.push(`${fingerprint.total_modules}_indexed_modules`);
        confidence = fingerprint.total_modules >= 20 ? 'high' : 'medium';
      } else {
        skip = true;
        skipReason = fingerprint.total_modules === null
          ? 'self-model not yet built - run `task index-sync` first'
          : `only ${fingerprint.total_modules} module(s) indexed (threshold: ${minModules})`;
      }
      if (fingerprint.gap_history_entries > 0) {
        sources.push(`${fingerprint.gap_history_entries}_gap_history_entries`);
        confidence = 'high';
      }
      break;
    }
    case 'sherlog-hygiene': {
      const thresh = SKILL_EVIDENCE_THRESHOLDS['sherlog-hygiene'];
      const hasHygieneHistory = evidenceRaw.hygiene_history.length >= thresh.minHygieneHistoryEntries;
      const hygieneGapTypes = thresh.hygieneGapTypes;
      const hasHygieneGaps = fingerprint.top_gap_types.some(g => hygieneGapTypes.includes(g.type));

      if (fingerprint.hygiene_trend === 'worsening') {
        sources.push('hygiene_trend_worsening');
        confidence = 'high';
      }
      if (fingerprint.hygiene_findings > 0) {
        sources.push(`hygiene_findings_${fingerprint.hygiene_findings}`);
        confidence = confidence === 'low' ? 'medium' : confidence;
      }
      if (hasHygieneHistory) {
        sources.push(`hygiene_history_${evidenceRaw.hygiene_history.length}_entries`);
        confidence = confidence === 'low' ? 'medium' : confidence;
      }
      if (hasHygieneGaps) {
        const matched = fingerprint.top_gap_types.filter(g => hygieneGapTypes.includes(g.type)).map(g => g.type);
        sources.push(`hygiene_gap_types:${matched.join(',')}`);
        confidence = 'high';
      }
      if (sources.length === 0) {
        skip = true;
        skipReason = 'no hygiene scan history and no hygiene-related gap types recorded - run `task hygiene -- --json` first';
      }
      break;
    }
    case 'sherlog-fragility': {
      const fragileCount = fingerprint.fragile_file_count ?? 0;
      if (fragileCount >= SKILL_EVIDENCE_THRESHOLDS['sherlog-fragility'].minFragileFiles) {
        sources.push(`fragile_files_${fragileCount}`);
        confidence = fragileCount >= 5 ? 'high' : 'medium';
        if (fingerprint.liveness?.Misleading > 0) {
          sources.push(`misleading_files_${fingerprint.liveness.Misleading}`);
        }
      } else {
        skip = true;
        skipReason = fragileCount === 0
          ? 'self-model reports no fragile files above threshold'
          : 'self-model not yet built - run `task index-sync` first';
      }
      break;
    }
    default:
      skip = true;
      skipReason = 'unknown skill name';
  }

  return { sources, confidence, skip, skipReason };
}

function recommendSkills(fingerprint, evidenceRaw) {
  const skillNames = [
    'sherlog-preflight',
    'sherlog-gaps',
    'sherlog-session',
    'sherlog-hygiene',
    'sherlog-fragility',
  ];

  const recommendations = [];
  const skipped = [];

  for (const name of skillNames) {
    const tmpl = SKILL_TEMPLATES[name];
    if (!tmpl) continue;

    const ev = assessEvidence(name, fingerprint, evidenceRaw);

    if (ev.skip) {
      skipped.push({
        name,
        action: 'skip',
        reason: ev.skipReason || 'evidence below threshold',
        evidence_sources: ev.sources,
      });
      continue;
    }

    // Derive priority from confidence + template priority
    const basePriority = typeof tmpl.priority === 'string' ? tmpl.priority : 'medium';
    const effectivePriority = ev.confidence === 'low' && basePriority !== 'required'
      ? 'low'
      : basePriority;

    recommendations.push({
      name,
      action: 'recommend',
      priority: effectivePriority,
      confidence: ev.confidence,
      evidence_sources: ev.sources,
      rationale: buildRationale(name, fingerprint, ev),
      trigger: tmpl.trigger,
    });
  }

  return { recommendations, skipped };
}

function buildRationale(skillName, fingerprint, ev) {
  switch (skillName) {
    case 'sherlog-preflight':
      return `Sherlog is wired in this repo (${fingerprint.zone_count} zone${fingerprint.zone_count !== 1 ? 's' : ''}, ${fingerprint.gap_history_entries} gap history entries). Preflight is the required entry gate.`;
    case 'sherlog-gaps':
      if (fingerprint.top_gap_types.length > 0) {
        const top = fingerprint.top_gap_types.slice(0, 3).map(g => `${g.type}(${g.count}x)`).join(', ');
        return `${fingerprint.gap_history_entries} gap history entries; recurring types: ${top}.`;
      }
      return 'Gap detection applies to every feature - use before declaring any feature done.';
    case 'sherlog-session':
      return `${fingerprint.total_modules} indexed modules across ${fingerprint.zone_count} zone${fingerprint.zone_count !== 1 ? 's' : ''}. Session tracking captures discovery and rework that velocity metrics miss.`;
    case 'sherlog-hygiene':
      if (fingerprint.hygiene_trend === 'worsening') {
        return `Hygiene trend is worsening (${fingerprint.hygiene_findings ?? '?'} findings). Each cycle of ignored findings compounds the debt.`;
      }
      if (fingerprint.hygiene_findings > 0) {
        return `${fingerprint.hygiene_findings} hygiene findings on record. Systematic resolution prevents accumulation.`;
      }
      {
        const hygieneGapSources = ev.sources.filter(s => s.startsWith('hygiene_gap_types'));
        if (hygieneGapSources.length > 0) {
          return `Hygiene-related gap types in history: ${hygieneGapSources.join(', ')}.`;
        }
        return 'Hygiene scan history exists; use this skill before merges or after rapid feature development.';
      }
    case 'sherlog-fragility':
      return `${fingerprint.fragile_file_count} fragile file${fingerprint.fragile_file_count !== 1 ? 's' : ''} in self-model. Agents need safe-refactoring guidance before touching these modules.`;
    default:
      return 'See evidence sources.';
  }
}

// ---------------------------------------------------------------------------
// Skill brief (the structured output an agent uses to decide)
// ---------------------------------------------------------------------------

function buildSkillBrief(fingerprint, recommendations, skipped) {
  const requiredSkills = recommendations.filter(r => r.priority === 'required').map(r => r.name);
  const highSkills = recommendations.filter(r => r.priority === 'high').map(r => r.name);

  const lines = [
    'This repo has Sherlog installed.',
    `It has ${fingerprint.zone_count} declared context zone(s) and ${fingerprint.total_modules ?? '?'} indexed source modules.`,
  ];

  if (fingerprint.fragile_file_count > 0) {
    lines.push(`${fingerprint.fragile_file_count} file(s) have elevated fragility scores.`);
  }
  if (fingerprint.top_gap_types.length > 0) {
    const topTypes = fingerprint.top_gap_types.slice(0, 3).map(g => g.type).join(', ');
    lines.push(`Most frequent gap types in history: ${topTypes}.`);
  }
  if (fingerprint.hygiene_trend === 'worsening') {
    lines.push('Hygiene trend is worsening - address before compounding.');
  }

  lines.push('');
  lines.push(`Required skills: ${requiredSkills.join(', ') || 'none'}.`);
  lines.push(`High-priority skills: ${highSkills.join(', ') || 'none'}.`);
  if (skipped && skipped.length > 0) {
    lines.push(`Skipped (insufficient evidence): ${skipped.map(s => s.name).join(', ')}.`);
  }
  lines.push('');
  lines.push('An agent working in this repo should load the sherlog-preflight skill before any feature work.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Skill generation
// ---------------------------------------------------------------------------

function renderSkillMd(skillName, fingerprint) {
  const tmpl = SKILL_TEMPLATES[skillName];
  if (!tmpl) return null;
  const description = typeof tmpl.description === 'function'
    ? tmpl.description(fingerprint)
    : tmpl.description;
  const body = tmpl.template(fingerprint);
  return `---\nname: "${tmpl.name}"\ndescription: "${description}"\n---\n\n${body}\n`;
}

function syncFlatSkillsToCompatDirs(outputDir, force) {
  const written = [];
  const skippedFiles = [];

  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.skill')) continue;

    const skillName = path.basename(entry.name, '.skill');
    const flatPath = path.join(outputDir, entry.name);
    const compatPath = path.join(outputDir, skillName, 'SKILL.md');

    if (fs.existsSync(compatPath) && !force) {
      skippedFiles.push(compatPath);
      continue;
    }

    const content = fs.readFileSync(flatPath, 'utf8');
    fs.mkdirSync(path.dirname(compatPath), { recursive: true });
    fs.writeFileSync(compatPath, content, 'utf8');
    written.push(compatPath);
  }

  return { written, skipped: skippedFiles };
}

function generateSkillFiles(recommendations, fingerprint, outputDir, force) {
  fs.mkdirSync(outputDir, { recursive: true });
  const written = [];
  const skippedFiles = [];

  for (const rec of recommendations) {
    const skillName = rec.name;
    if (!SKILL_TEMPLATES[skillName]) continue;

    const filename = `${skillName}.skill`;
    const outPath = path.join(outputDir, filename);

    if (fs.existsSync(outPath) && !force) {
      skippedFiles.push(outPath);
      continue;
    }

    const content = renderSkillMd(skillName, fingerprint);
    fs.writeFileSync(outPath, content, 'utf8');
    written.push(outPath);
  }

  const compat = syncFlatSkillsToCompatDirs(outputDir, force);
  return {
    written: [...written, ...compat.written],
    skipped: [...skippedFiles, ...compat.skipped],
  };
}

// ---------------------------------------------------------------------------
// Artifact persistence helpers
// ---------------------------------------------------------------------------

function getArtifactPath(config, repoRoot) {
  const dataDir = config.paths?.data_dir
    ? (path.isAbsolute(config.paths.data_dir) ? config.paths.data_dir : path.join(repoRoot, config.paths.data_dir))
    : path.resolve(__dirname, '../../data');
  return path.join(dataDir, 'skills-suggest.json');
}

function loadArtifact(artifactPath) {
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch {
    return null;
  }
}

function persistArtifact(artifactPath, output) {
  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(output, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let config;
  let repoRoot;

  const { config: loadedConfig, configPath } = loadConfig();
  if (!loadedConfig) {
    console.error(`Sherlog config not found at ${configPath}. Run 'task init-context -- --force' first.`);
    process.exit(1);
  }
  config = loadedConfig;
  repoRoot = resolveRepoRoot(config.repo_root);

  const artifactPath = getArtifactPath(config, repoRoot);

  if (args.generate) {
    // --generate: prefer the persisted suggest artifact unless --fresh forces re-analysis
    let fingerprintForGenerate;
    let recommendationsForGenerate;
    let skippedForGenerate;
    let artifactAge = null;

    const artifact = !args.fresh ? loadArtifact(artifactPath) : null;
    if (artifact && artifact.repo_fingerprint && artifact.recommended_skills) {
      fingerprintForGenerate = artifact.repo_fingerprint;
      recommendationsForGenerate = artifact.recommended_skills.filter(r => r.action === 'recommend');
      skippedForGenerate = artifact.skipped_skills || [];
      artifactAge = artifact.timestamp
        ? Math.round((Date.now() - new Date(artifact.timestamp).getTime()) / 60000)
        : null;
    } else {
      const evidence = loadEvidence(config, repoRoot);
      fingerprintForGenerate = buildFingerprint(evidence);
      const result = recommendSkills(fingerprintForGenerate, evidence);
      recommendationsForGenerate = result.recommendations;
      skippedForGenerate = result.skipped;
    }

    const outputDir = args.output
      ? path.resolve(process.cwd(), args.output)
      : path.join(repoRoot, '.github', 'skills');

    const { written, skipped: skippedFiles } = generateSkillFiles(
      recommendationsForGenerate, fingerprintForGenerate, outputDir, args.force,
    );

    if (args.json) {
      console.log(JSON.stringify({
        output_dir: outputDir,
        written,
        skipped_files: skippedFiles,
        skipped_skills: skippedForGenerate,
        artifact_used: !args.fresh && artifact !== null,
        artifact_age_minutes: artifactAge,
      }, null, 2));
    } else {
      if (artifact && !args.fresh) {
        const ageNote = artifactAge !== null ? ` (artifact from ${artifactAge}m ago)` : '';
        console.log(`SHERLOG SKILLS - Using persisted suggest artifact${ageNote}. Run with --fresh to re-analyze.`);
      } else {
        console.log('SHERLOG SKILLS - Analysed from live evidence.');
      }
      console.log(`Output: ${outputDir}`);
      if (written.length > 0) {
        console.log('Written:');
        written.forEach(p => console.log(`  + ${path.relative(repoRoot, p)}`));
      }
      if (skippedFiles.length > 0) {
        console.log('Skipped (already exist; use --force to overwrite):');
        skippedFiles.forEach(p => console.log(`  - ${path.relative(repoRoot, p)}`));
      }
      if (skippedForGenerate.length > 0) {
        console.log('Skills skipped (evidence below threshold):');
        skippedForGenerate.forEach(s => console.log(`  ~ ${s.name}: ${s.reason}`));
      }
      if (written.length === 0 && skippedFiles.length === 0) {
        console.log('No skills generated.');
      }
    }
    return;
  }

  // --suggest mode: run analysis, emit output, persist artifact
  const evidence = loadEvidence(config, repoRoot);
  const fingerprint = buildFingerprint(evidence);
  const { recommendations, skipped } = recommendSkills(fingerprint, evidence);
  const brief = buildSkillBrief(fingerprint, recommendations, skipped);

  const output = {
    version: 2,
    timestamp: new Date().toISOString(),
    repo_fingerprint: fingerprint,
    recommended_skills: recommendations.map(r => ({
      ...r,
      output_path: `.github/skills/${r.name}.skill`,
      available_template: Boolean(SKILL_TEMPLATES[r.name]),
    })),
    skipped_skills: skipped,
    skill_brief: brief,
    generate_command: 'node sherlog-velocity/src/cli/skills.js --generate',
    artifact_path: path.relative(repoRoot, artifactPath),
  };

  if (!args.noPersist) {
    const saved = persistArtifact(artifactPath, output);
    output._persisted = saved;
  }

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  buildFingerprint,
  recommendSkills,
  buildSkillBrief,
  renderSkillMd,
};
