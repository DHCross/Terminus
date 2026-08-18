#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig, readJson } = require('../core/shared');
const { generateStaticBounds } = require('../core/boundary-mapper');
const { buildConsumerGraph, summarizeConsumersForFile } = require('../core/consumers');

// ─── argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    planFile: null,
    blastThreshold: 5,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plan-file' && argv[i + 1]) out.planFile = argv[++i];
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
  console.log('Usage: node sherlog-velocity/src/cli/lint-plan.js [options]');
  console.log('');
  console.log('Reads a plan JSON from --plan-file or stdin, then validates it against current context constraints.');
  console.log('');
  console.log('Options:');
  console.log('  --plan-file <path>   Path to a JSON plan file (otherwise reads from stdin)');
  console.log('  --threshold <n>      Consumer count above which a blast-radius warning fires (default: 5)');
  console.log('  --json               Emit JSON output');
  console.log('  --help, -h           Show this message');
  console.log('');
  console.log('Plan format:');
  console.log('  { "feature": "...", "steps": [{ "action": "...", "files": ["..."], "type": "implementation|test|docs|..." }] }');
}

// ─── config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

// ─── plan reading ────────────────────────────────────────────────────────────

function readPlanFromFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = readJson(resolved, null);
  if (!raw) throw new Error(`Cannot read or parse plan file: ${filePath}`);
  return raw;
}

function readPlanFromStdin() {
  const raw = fs.readFileSync('/dev/stdin', 'utf8').trim();
  if (!raw) throw new Error('No plan JSON received on stdin.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON received on stdin.');
  }
}

function validatePlanSchema(plan) {
  const issues = [];
  if (!plan || typeof plan !== 'object') {
    issues.push('Plan must be a JSON object.');
    return issues;
  }
  if (!plan.feature || typeof plan.feature !== 'string' || !plan.feature.trim()) {
    issues.push('"feature" must be a non-empty string.');
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    issues.push('"steps" must be a non-empty array.');
  } else {
    plan.steps.forEach((step, idx) => {
      if (!step || typeof step !== 'object') {
        issues.push(`steps[${idx}]: must be an object.`);
        return;
      }
      if (!step.action || typeof step.action !== 'string' || !step.action.trim()) {
        issues.push(`steps[${idx}]: "action" must be a non-empty string.`);
      }
      if (!Array.isArray(step.files)) {
        issues.push(`steps[${idx}]: "files" must be an array.`);
      }
    });
  }
  return issues;
}

// ─── context helpers ─────────────────────────────────────────────────────────

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function pathMatchesGlob(relPath, pattern) {
  const file = normalizePath(relPath).toLowerCase();
  const glob = normalizePath(pattern).toLowerCase();
  if (!file || !glob) return false;

  const fileSegs = file.split('/').filter(Boolean);
  const globSegs = glob.split('/').filter(Boolean);
  if (!fileSegs.length || !globSegs.length) return false;

  function match(fi, gi) {
    if (gi >= globSegs.length) return fi >= fileSegs.length;
    const gs = globSegs[gi];
    if (gs === '**') {
      if (gi === globSegs.length - 1) return true;
      for (let index = fi; index <= fileSegs.length; index++) {
        if (match(index, gi + 1)) return true;
      }
      return false;
    }
    if (fi >= fileSegs.length) return false;
    const pat = `^${gs.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&').replace(/\\\*/g, '.*')}$`;
    if (!new RegExp(pat).test(fileSegs[fi])) return false;
    return match(fi + 1, gi + 1);
  }

  return match(0, 0);
}

function findBestZone(filePath, zones) {
  let best = null;
  let bestSpecificity = -1;
  for (const zone of zones) {
    const paths = Array.isArray(zone.paths) ? zone.paths : [];
    for (const pattern of paths) {
      if (pathMatchesGlob(filePath, pattern)) {
        const specificity = normalizePath(pattern).length;
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          best = zone;
        }
      }
    }
  }
  return best;
}

function loadContextZones(config) {
  const { resolveRuntimeConfig } = require('../core/shared');
  const repoRoot = resolveRuntimeConfig(config || {})?.repo_root || process.cwd();

  const candidates = [
    config?.paths?.generated_context_map,
    config?.context?.map_file,
    config?.paths?.context_map,
    path.join(repoRoot, 'sherlog.context.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const contextMap = readJson(candidate, null);
    if (contextMap && Array.isArray(contextMap.zones)) return contextMap.zones;
  }
  return [];
}

// ─── provenance ──────────────────────────────────────────────────────────────

const REQUIRED_VERIFIED_FIELDS = ['base_sha', 'zone', 'reused_symbols', 'red_first_test'];
const WARN_OK_ASSUMED_FIELDS = ['failure_layer'];

function checkProvenance(plan) {
  const issues = [];
  const ledgerEntries = [];
  const provenance = plan?.provenance;

  if (!provenance || typeof provenance !== 'object') {
    issues.push({
      step_index: -1,
      rule: 'unverified_declaration',
      message: 'Plan is missing provenance object. Every plan must declare what it knows with provenance tags (verified/assumed/unknown).',
    });
    return { issues, ledgerEntries };
  }

  const sha = String(plan?._sha || '');
  const feature = String(plan?.feature || '');
  const ts = new Date().toISOString();

  function ledger(field, state, source) {
    ledgerEntries.push({ ts, sha, feature, field, state, source: source || null });
  }

  const allFields = [...new Set([
    ...REQUIRED_VERIFIED_FIELDS,
    ...WARN_OK_ASSUMED_FIELDS,
    'new_symbols',
    ...Object.keys(provenance),
  ])];

  for (const field of allFields) {
    const entry = provenance[field];
    if (!entry) continue;
    const state = String(entry.state || 'unknown').trim().toLowerCase();
    const source = String(entry.source || '').trim();
    if (state === 'verified' && !source) {
      issues.push({
        step_index: -1,
        rule: 'unverified_declaration',
        message: `Provenance field "${field}" is marked "verified" but has no source. Verified fields require a non-empty source describing how they were checked.`,
      });
    }
    if (state === 'assumed' || state === 'unknown') {
      ledger(field, state, source);
    }
  }

  for (const field of REQUIRED_VERIFIED_FIELDS) {
    const entry = provenance[field];
    const state = entry ? String(entry.state || 'unknown').trim().toLowerCase() : 'unknown';
    if (state !== 'verified') {
      const reason = state === 'unknown'
        ? 'The agent could not fill this field.'
        : 'The agent stated this but Sherlog could not verify it.';
      issues.push({
        step_index: -1,
        rule: 'unverified_declaration',
        message: `Provenance field "${field}" is "${state}" but must be "verified". ${reason}`,
      });
    }
  }

  const newSymbols = provenance.new_symbols;
  const newSymbolsValue = Array.isArray(newSymbols?.value) ? newSymbols.value : [];
  if (newSymbolsValue.length > 0) {
    const missingJustification = newSymbolsValue.filter(
      entry => !entry?.justification || !String(entry.justification).trim()
    );
    if (missingJustification.length > 0) {
      const names = missingJustification.map(e => e?.name || '(unnamed)').join(', ');
      issues.push({
        step_index: -1,
        rule: 'unverified_declaration',
        message: `new_symbols entries [${names}] are missing justification. Each new symbol must explain why no existing contract fits.`,
      });
    }
  }

  const failureLayer = provenance.failure_layer;
  const failureLayerState = failureLayer
    ? String(failureLayer.state || 'unknown').trim().toLowerCase()
    : 'unknown';
  if (failureLayerState === 'assumed' || failureLayerState === 'unknown') {
    issues.push({
      step_index: -1,
      rule: 'unverified_declaration_warn',
      message: `Provenance field "failure_layer" is "${failureLayerState}". This is a diagnosis, not a fact — accepted with a warning.`,
    });
  }

  return { issues, ledgerEntries };
}

// ─── rules ───────────────────────────────────────────────────────────────────

/**
 * Rule 1: Scope check — are any files in a do_not_touch zone?
 */
function checkScope(steps, zones) {
  const issues = [];
  steps.forEach((step, idx) => {
    const files = Array.isArray(step.files) ? step.files : [];
    files.forEach(file => {
      const zone = findBestZone(file, zones);
      if (!zone) return;
      const policy = String(zone.touch_policy || '').trim().toLowerCase();
      if (policy === 'do_not_touch') {
        issues.push({
          step_index: idx,
          rule: 'scope_violation',
          message: `File "${file}" is in do-not-touch zone "${zone.name}": ${zone.belief || 'no belief recorded'}.`,
        });
      }
    });
  });
  return issues;
}

/**
 * Rule 2: Consumer blast check — does any file affect > threshold downstream consumers?
 */
function checkBlastRadius(steps, graph, blastThreshold) {
  const issues = [];
  const cache = new Map();

  steps.forEach((step, idx) => {
    const files = Array.isArray(step.files) ? step.files : [];
    files.forEach(file => {
      const key = normalizePath(file);
      if (!cache.has(key)) {
        const summary = summarizeConsumersForFile(graph, file);
        cache.set(key, summary);
      }
      const summary = cache.get(key);
      if (summary && summary.downstream_count >= blastThreshold) {
        issues.push({
          step_index: idx,
          rule: 'high_blast_radius',
          message: `File "${file}" has ${summary.downstream_count} downstream consumer(s) (threshold: ${blastThreshold}). Confirm test coverage before editing.`,
        });
      }
    });
  });

  return issues;
}

/**
 * Rule 3: Contradiction check — does this step contradict zone obligations or beliefs?
 */
function checkContradictions(steps, zones) {
  const issues = [];

  steps.forEach((step, idx) => {
    const files = Array.isArray(step.files) ? step.files : [];
    files.forEach(file => {
      const zone = findBestZone(file, zones);
      if (!zone) return;

      const beliefs = Array.isArray(zone.beliefs) ? zone.beliefs : [];
      const obligations = Array.isArray(zone.obligations) ? zone.obligations : [];

      const belief = String(zone.belief || '').trim();
      const action = String(step.action || '').toLowerCase();

      // Simple heuristic: if the zone belief mentions "do not" or "must not" and
      // the action contains conflicting keywords, surface a warning.
      const prohibitions = ['do not', "don't", 'must not', 'never', 'avoid', 'no direct'];
      if (belief) {
        for (const phrase of prohibitions) {
          if (belief.toLowerCase().includes(phrase)) {
            issues.push({
              step_index: idx,
              rule: 'belief_contradiction',
              message: `Zone "${zone.name}" belief may conflict with step action "${step.action}": "${belief}"`,
            });
            break;
          }
        }
      }

      // Surface declared obligations and beliefs
      [...beliefs, ...obligations].forEach(item => {
        const text = typeof item === 'string' ? item : String(item?.description || item?.text || '');
        if (!text) return;
        for (const phrase of prohibitions) {
          if (text.toLowerCase().includes(phrase)) {
            issues.push({
              step_index: idx,
              rule: 'obligation_conflict',
              message: `Zone "${zone.name}" has obligation that may conflict with step: "${text}"`,
            });
            break;
          }
        }
      });
    });
  });

  return issues;
}

/**
 * Rule 4: Gap-coverage check — does every implementation step have at least one corresponding test step?
 */
function checkGapCoverage(steps) {
  const issues = [];

  const implementationSteps = steps
    .map((step, idx) => ({ step, idx }))
    .filter(({ step }) => {
      const type = String(step.type || '').trim().toLowerCase();
      // Explicit non-implementation types: skip them
      if (type === 'test' || type === 'docs') return false;
      // Explicit implementation types
      if (type === 'implementation' || type === 'refactor' || type === 'config' || type === 'other') return true;
      // Untyped steps: only treat as implementation if the action doesn't look like a test or docs step
      if (!type) {
        const action = String(step.action || '').toLowerCase();
        return !action.includes('test') && !action.includes('spec') && !action.includes('coverage')
          && !action.includes('document') && !action.includes('readme') && !action.includes('changelog');
      }
      // Unknown types: conservative — treat as implementation
      return true;
    });

  const hasTestStep = steps.some(step => {
    const type = String(step.type || '').trim().toLowerCase();
    if (type === 'test') return true;
    const action = String(step.action || '').toLowerCase();
    return action.includes('test') || action.includes('spec') || action.includes('coverage');
  });

  if (implementationSteps.length > 0 && !hasTestStep) {
    issues.push({
      step_index: -1,
      rule: 'missing_test_coverage',
      message: `Plan has ${implementationSteps.length} implementation step(s) but no test step. Add a step with type "test" or an action that includes "test".`,
    });
  }

  return issues;
}

// ─── verdict ─────────────────────────────────────────────────────────────────

function computeVerdict(allIssues) {
  const hasRejection = allIssues.some(
    issue => issue.rule === 'scope_violation'
      || issue.rule === 'missing_test_coverage'
      || issue.rule === 'unverified_declaration'
  );
  if (hasRejection) return 'rejected';

  const hasWarning = allIssues.some(
    issue => issue.rule === 'high_blast_radius'
      || issue.rule === 'belief_contradiction'
      || issue.rule === 'obligation_conflict'
      || issue.rule === 'unverified_declaration_warn'
  );
  if (hasWarning) return 'warned';

  return 'approved';
}

// ─── main ────────────────────────────────────────────────────────────────────

function lintPlan(plan, config, blastThreshold) {
  const feature = String(plan.feature || 'unnamed feature');
  const steps = Array.isArray(plan.steps) ? plan.steps : [];

  const zones = loadContextZones(config);
  const graph = buildConsumerGraph(config);

  const scopeIssues = checkScope(steps, zones);
  const blastIssues = checkBlastRadius(steps, graph, blastThreshold);
  const contradictionIssues = checkContradictions(steps, zones);
  const gapCoverageIssues = checkGapCoverage(steps);
  const provenanceResult = checkProvenance(plan);

  const allIssues = [
    ...scopeIssues,
    ...blastIssues,
    ...contradictionIssues,
    ...gapCoverageIssues,
    ...provenanceResult.issues,
  ];

  const verdict = computeVerdict(allIssues);

  return {
    feature,
    verdict,
    step_count: steps.length,
    issues: allIssues,
    provenance_ledger: provenanceResult.ledgerEntries,
  };
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  let plan;
  try {
    if (args.planFile) {
      plan = readPlanFromFile(args.planFile);
    } else {
      plan = readPlanFromStdin();
    }
  } catch (err) {
    console.error(`Error reading plan: ${err.message}`);
    process.exit(1);
  }

  const schemaErrors = validatePlanSchema(plan);
  if (schemaErrors.length > 0) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        verdict: 'rejected',
        feature: String(plan?.feature || ''),
        step_count: 0,
        issues: schemaErrors.map(msg => ({ step_index: -1, rule: 'schema_error', message: msg })),
      }, null, 2)}\n`);
    } else {
      console.error('Plan schema errors:');
      schemaErrors.forEach(e => console.error(`  - ${e}`));
    }
    process.exit(1);
  }

  const config = loadConfig();
  const result = lintPlan(plan, config, args.blastThreshold);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log('SHERLOG LINT-PLAN');
  console.log(`Feature: ${result.feature}`);
  console.log(`Verdict: ${result.verdict.toUpperCase()}`);
  console.log(`Steps:   ${result.step_count}`);
  console.log(`Issues:  ${result.issues.length}`);

  if (result.issues.length === 0) {
    console.log('');
    console.log('No issues found. Plan is safe to execute.');
    return;
  }

  console.log('');
  console.log('Issues:');
  result.issues.forEach(issue => {
    const stepLabel = issue.step_index >= 0 ? `step[${issue.step_index}]` : 'plan';
    console.log(`  [${issue.rule}] ${stepLabel}: ${issue.message}`);
  });
}

if (require.main === module) main();

module.exports = { lintPlan, parseArgs, checkProvenance };
