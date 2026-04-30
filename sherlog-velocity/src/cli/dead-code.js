#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { scanDeadCode } = require('../core/dead-code');

// ── Arg parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    feature: null,
    types: [],
    staleOnly: false,
    json: false,
    record: true,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--type' && argv[i + 1]) out.types.push(argv[++i]);
    else if (arg === '--stale-only') out.staleOnly = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--no-record') out.record = false;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: sherlog dead-code [options]');
  console.log('');
  console.log('Scan for dead code: unreachable statements, unused variables,');
  console.log('unused internal functions, and branch conditions that can never execute.');
  console.log('');
  console.log('Options:');
  console.log('  --feature <name>  Restrict scan to files matching the feature name');
  console.log('  --type <type>     Filter by finding type (repeatable)');
  console.log('                    Types: unreachable_code, unused_variable,');
  console.log('                           unused_function, dead_branch');
  console.log('  --stale-only      Only report findings in git-stale files (> stale threshold)');
  console.log('  --json            Machine-readable JSON output');
  console.log('  --no-record       Skip writing to dead-code history');
  console.log('  --help, -h        Show this message');
  console.log('');
  console.log('Gap keys emitted:');
  console.log('  dead_code_unreachable      — unreachable statements found');
  console.log('  dead_code_unused_symbol    — unused variables or functions');
  console.log('  dead_code_dead_branch      — always-false/true or contradictory conditions');
  console.log('  dead_code_stale_module     — file is Dead in the self-model');
  console.log('  dead_code_misleading_module — file is Misleading in the self-model');
}

// ── Formatting ───────────────────────────────────────────────────────

const TYPE_LABELS = {
  unreachable_code: 'Unreachable Code After Exit Statement',
  unused_variable:  'Unused Local Variables',
  unused_function:  'Unused Internal Functions',
  dead_branch:      'Dead Branches (Tautological Conditions)',
};

function formatFinding(f) {
  const staleTag = f.stale ? ` [stale ${f.days_since_last_commit}d]` : '';
  const livenessTag = f.liveness && f.liveness !== 'Active' ? ` [liveness:${f.liveness}]` : '';
  const base = `  ${f.file}${staleTag}${livenessTag}`;

  if (f.type === 'unreachable_code') {
    return `${base} — ${f.count} unreachable line(s) at: ${f.lines.slice(0, 5).join(', ')}${f.lines.length > 5 ? '...' : ''}`;
  }
  if (f.type === 'unused_variable' || f.type === 'unused_function') {
    const symbolList = f.symbols.slice(0, 5).join(', ') + (f.symbols.length > 5 ? '...' : '');
    return `${base} — ${f.count} unused: ${symbolList}`;
  }
  if (f.type === 'dead_branch') {
    const patternList = [...new Set(f.patterns)].join(', ');
    return `${base} — ${f.count} dead branch(es) [${patternList}] at line(s): ${f.lines.slice(0, 5).join(', ')}`;
  }
  return base;
}

// ── Main ─────────────────────────────────────────────────────────────

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const options = {
    record: args.record,
    staleOnly: args.staleOnly,
  };
  if (args.feature) options.feature = args.feature;
  if (args.types.length > 0) options.types = args.types;

  const result = scanDeadCode(config, options);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const scope = args.feature ? `feature: ${args.feature}` : 'repo-wide';
  console.log('SHERLOG DEAD CODE SCAN');
  console.log(`Scope: ${scope}`);
  console.log(`Scanned files: ${result.summary.scanned_files}`);
  console.log(`Total findings: ${result.summary.total_findings}`);
  if (result.gaps.length > 0) {
    console.log(`Gaps: ${result.gaps.join(', ')}`);
  }
  console.log('');

  if (result.findings.length === 0) {
    console.log('No dead code detected.');
    return;
  }

  const grouped = {};
  result.findings.forEach(f => {
    if (!grouped[f.type]) grouped[f.type] = [];
    grouped[f.type].push(f);
  });

  for (const [type, findings] of Object.entries(grouped)) {
    console.log(`${TYPE_LABELS[type] || type} (${findings.length}):`);
    findings.forEach(f => console.log(formatFinding(f)));
    console.log('');
  }

  // History note
  if (result.history.length > 0) {
    const prev = result.history[result.history.length - 1];
    const prevTotal = prev?.summary?.total_findings ?? null;
    if (prevTotal !== null) {
      const delta = result.summary.total_findings - prevTotal;
      const sign = delta > 0 ? '+' : '';
      console.log(`Trend: ${sign}${delta} vs previous scan (${result.history.length} run(s) recorded)`);
      console.log('');
    }
  }
}

if (require.main === module) main();
