#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig, readJson } = require('../core/shared');
const { analyzeBlastRadius } = require('./blast-radius');
const { lintPlan } = require('./lint-plan');
const { generateStaticBounds } = require('../core/boundary-mapper');

function parseArgs(argv) {
  const out = {
    file: null,
    planFile: null,
    feature: null,
    blastThreshold: 5,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--file' || arg === '-f') && argv[i + 1]) out.file = argv[++i];
    else if (arg === '--plan-file' && argv[i + 1]) out.planFile = argv[++i];
    else if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--threshold' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.blastThreshold = n;
    }
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/preflight.js [options]');
  console.log('');
  console.log('Integrated pre-mutation telemetry that composes existing Sherlog instruments.');
  console.log('');
  console.log('Options:');
  console.log('  --file, -f <path>      Target file to analyze (runs blast-radius)');
  console.log('  --plan-file <path>     Path to a JSON plan file (runs lint-plan)');
  console.log('  --feature "Name"       Feature name for context (runs bounds)');
  console.log('  --threshold <n>        Consumer count threshold for blast warnings (default: 5)');
  console.log('  --json                 Emit JSON output');
  console.log('  --help, -h             Show this message');
  console.log('');
  console.log('Examples:');
  console.log('  npm run sherlog:preflight -- --file src/app/api/raven-chat/protocolRules.ts --json');
  console.log('  npm run sherlog:preflight -- --plan-file plan.json --json');
  console.log('  npm run sherlog:preflight -- --feature "Add user authentication" --json');
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    throw new Error('Config not found. Run `node sherlog-velocity/install.js` first.');
  }
  return runtime.config;
}

function readPlanFromFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = readJson(resolved, null);
  if (!raw) throw new Error(`Cannot read or parse plan file: ${filePath}`);
  return raw;
}

function mapVerdictToStatus(verdict) {
  // Convert lint-plan verdict to telemetry status
  // lint-plan uses: approved, warned, rejected
  // preflight uses: clear, caution, blocked_by_policy, unknown
  if (verdict === 'approved') return 'clear';
  if (verdict === 'warned') return 'caution';
  if (verdict === 'rejected') return 'blocked_by_policy';
  return 'unknown';
}

function mapBlastLevelToStatus(blastLevel, doNotTouchCount) {
  // Convert blast radius to telemetry status
  if (doNotTouchCount > 0) return 'blocked_by_policy';
  if (blastLevel === 'high') return 'caution';
  if (blastLevel === 'medium') return 'caution';
  if (blastLevel === 'low' || blastLevel === 'none') return 'clear';
  return 'unknown';
}

function computeOverallStatus(inputs) {
  const statuses = [];

  if (inputs.blast_radius) {
    const blastStatus = mapBlastLevelToStatus(
      inputs.blast_radius.blast_level,
      inputs.blast_radius.do_not_touch?.length || 0
    );
    statuses.push(blastStatus);
  }

  if (inputs.plan_lint) {
    const planStatus = mapVerdictToStatus(inputs.plan_lint.verdict);
    statuses.push(planStatus);
  }

  if (inputs.bounds) {
    if (inputs.bounds.topology?.do_not_touch?.length > 0) {
      statuses.push('blocked_by_policy');
    } else if (inputs.bounds.topology?.risky_touch?.length > 0) {
      statuses.push('caution');
    } else {
      statuses.push('clear');
    }
  }

  // Overall status is the most severe
  if (statuses.includes('blocked_by_policy')) return 'blocked_by_policy';
  if (statuses.includes('caution')) return 'caution';
  if (statuses.includes('clear')) return 'clear';
  return 'unknown';
}

function buildRecommendedChecks(inputs) {
  const checks = [];

  if (inputs.blast_radius) {
    const br = inputs.blast_radius;
    if (br.test_files?.length > 0) {
      checks.push(`Run tests for affected files: ${br.test_files.slice(0, 3).join(', ')}${br.test_files.length > 3 ? '...' : ''}`);
    }
    if (br.downstream_count > 0) {
      checks.push(`Verify ${br.downstream_count} downstream consumer(s) after mutation`);
    }
    if (br.do_not_touch?.length > 0) {
      checks.push(`Do-not-touch consumers detected: validate before editing target`);
    }
  }

  if (inputs.plan_lint) {
    const pl = inputs.plan_lint;
    if (pl.issues?.length > 0) {
      const scopeIssues = pl.issues.filter(i => i.rule === 'scope_violation');
      if (scopeIssues.length > 0) {
        checks.push('Plan includes do-not-touch files: review scope before execution');
      }
      const blastIssues = pl.issues.filter(i => i.rule === 'high_blast_radius');
      if (blastIssues.length > 0) {
        checks.push('Plan includes high blast-radius files: confirm test coverage');
      }
      const testIssues = pl.issues.filter(i => i.rule === 'missing_test_coverage');
      if (testIssues.length > 0) {
        checks.push('Plan lacks test coverage: add test steps before execution');
      }
    }
  }

  if (inputs.bounds) {
    const b = inputs.bounds;
    if (b.topology?.risky_touch?.length > 0) {
      checks.push('Target includes risky-touch files: validate ownership and tests');
    }
    if (b.obligations?.verifications_required?.length > 0) {
      checks.push('Context verifications required: check zone obligations');
    }
  }

  return checks;
}

function buildWarnings(inputs) {
  const warnings = [];

  if (inputs.blast_radius) {
    const br = inputs.blast_radius;
    if (br.blast_level === 'high') {
      warnings.push(`High blast radius: ${br.downstream_count} downstream consumer(s)`);
    }
  }

  if (inputs.plan_lint) {
    const pl = inputs.plan_lint;
    if (pl.issues?.length > 0) {
      const warningIssues = pl.issues.filter(i => 
        i.rule === 'high_blast_radius' || 
        i.rule === 'belief_contradiction' || 
        i.rule === 'obligation_conflict'
      );
      warningIssues.forEach(issue => {
        warnings.push(issue.message);
      });
    }
  }

  return warnings;
}

function buildUnknowns(inputs) {
  const unknowns = [];

  if (inputs.blast_radius && !inputs.blast_radius.found) {
    unknowns.push(`Target file not found in scan set: ${inputs.blast_radius.target_file}`);
  }

  if (inputs.feature && !inputs.bounds) {
    unknowns.push('Feature context provided but bounds analysis not available');
  }

  return unknowns;
}

function runPreflight(args, config) {
  const inputs = {
    file: args.file,
    plan_file: args.planFile,
    feature: args.feature,
  };

  const result = {
    schema_version: 'sherlog.preflight.v1',
    mode: 'telemetry',
    inputs,
    status: 'unknown',
    blast_radius: null,
    plan_lint: null,
    bounds: null,
    recommended_checks: [],
    warnings: [],
    unknowns: [],
    operator_note: 'Sherlog is an instrument panel, not an approval authority. Use this packet to adjust the edit vector before mutation.',
  };

  // Run blast-radius if --file is provided
  if (args.file) {
    try {
      result.blast_radius = analyzeBlastRadius(config, args.file, args.blastThreshold);
    } catch (err) {
      result.unknowns.push(`Blast-radius analysis failed: ${err.message}`);
      // Add a minimal fallback blast_radius object for telemetry
      result.blast_radius = {
        target_file: args.file,
        found: false,
        error: err.message,
        direct_consumers: [],
        transitive_consumers: [],
        test_files: [],
        do_not_touch: [],
        obligations: [],
        downstream_count: 0,
        blast_level: 'unknown',
      };
    }
  }

  // Run lint-plan if --plan-file is provided
  if (args.planFile) {
    try {
      const plan = readPlanFromFile(args.planFile);
      result.plan_lint = lintPlan(plan, config, args.blastThreshold);
    } catch (err) {
      result.unknowns.push(`Lint-plan analysis failed: ${err.message}`);
    }
  }

  // Run bounds if --feature is provided or if we have files from other analyses
  if (args.feature) {
    try {
      const files = [];
      if (args.file) files.push(args.file);
      if (args.planFile && result.plan_lint) {
        result.plan_lint.issues?.forEach(issue => {
          // Extract files from plan if available
        });
      }
      result.bounds = generateStaticBounds(args.feature, files, config);
    } catch (err) {
      result.unknowns.push(`Bounds analysis failed: ${err.message}`);
    }
  }

  // Compute overall status
  result.status = computeOverallStatus(result);

  // Build recommendations
  result.recommended_checks = buildRecommendedChecks(result);
  result.warnings = buildWarnings(result);
  result.unknowns = buildUnknowns(result);

  return result;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.file && !args.planFile && !args.feature) {
    console.error('Error: At least one of --file, --plan-file, or --feature is required.');
    console.error('');
    printHelp();
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const result = runPreflight(args, config);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  // Human-readable output
  console.log('SHERLOG PREFLIGHT');
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Mode: ${result.mode}`);
  console.log('');
  console.log('Inputs:');
  if (result.inputs.file) console.log(`  File: ${result.inputs.file}`);
  if (result.inputs.plan_file) console.log(`  Plan file: ${result.inputs.plan_file}`);
  if (result.inputs.feature) console.log(`  Feature: ${result.inputs.feature}`);
  console.log('');

  if (result.blast_radius) {
    console.log('Blast Radius:');
    console.log(`  Target: ${result.blast_radius.target_file}`);
    console.log(`  Level: ${result.blast_radius.blast_level}`);
    console.log(`  Downstream: ${result.blast_radius.downstream_count}`);
    if (result.blast_radius.test_files?.length > 0) {
      console.log(`  Test files: ${result.blast_radius.test_files.length}`);
    }
    console.log('');
  }

  if (result.plan_lint) {
    console.log('Plan Lint:');
    console.log(`  Verdict: ${result.plan_lint.verdict}`);
    console.log(`  Steps: ${result.plan_lint.step_count}`);
    console.log(`  Issues: ${result.plan_lint.issues.length}`);
    console.log('');
  }

  if (result.bounds) {
    console.log('Bounds:');
    console.log(`  Safe touch: ${result.bounds.topology?.safe_touch?.length || 0}`);
    console.log(`  Risky touch: ${result.bounds.topology?.risky_touch?.length || 0}`);
    console.log(`  Do not touch: ${result.bounds.topology?.do_not_touch?.length || 0}`);
    console.log('');
  }

  if (result.recommended_checks.length > 0) {
    console.log('Recommended Checks:');
    result.recommended_checks.forEach(check => console.log(`  - ${check}`));
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    result.warnings.forEach(warning => console.log(`  - ${warning}`));
    console.log('');
  }

  if (result.unknowns.length > 0) {
    console.log('Unknowns:');
    result.unknowns.forEach(unknown => console.log(`  - ${unknown}`));
    console.log('');
  }

  console.log('Note:');
  console.log(`  ${result.operator_note}`);
}

if (require.main === module) main();

module.exports = { runPreflight, parseArgs };
