#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { pruneAll, DEFAULT_RAW_DAYS } = require('../core/pruner');

function parseArgs(argv) {
  const out = {
    rawDays: null,
    dryRun: false,
    noRollup: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--no-rollup') out.noRollup = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if ((arg === '--older-than' || arg === '--days') && argv[i + 1]) {
      const d = Number(argv[++i]);
      if (Number.isFinite(d) && d > 0) out.rawDays = d;
    }
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/prune.js [options]');
  console.log('');
  console.log('Rolls up JSONL artifact entries older than a threshold into monthly');
  console.log('archive summaries, then rewrites each source file with only recent rows.');
  console.log('');
  console.log('Options:');
  console.log('  --older-than <days>   age threshold in days (default: from config or 30)');
  console.log('  --dry-run             report what would be pruned without writing any files');
  console.log('  --no-rollup           drop old rows without building archive summaries');
  console.log('  --json                emit structured JSON output');
  console.log('  --help, -h            show this message');
  console.log('');
  console.log('Archive location: sherlog-velocity/data/archive/<source>-archive.jsonl');
  console.log('Each archive line is a compact monthly rollup record.');
}

function formatResult(result) {
  if (result.skipped) {
    return `  ${result.source}: skipped (${result.reason})`;
  }
  const action = result.dry_run ? '[dry-run] would prune' : 'pruned';
  return `  ${result.source}: ${action} ${result.pruned_count} rows across ${result.months_rolled_up} month(s), kept ${result.kept_count}`;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Sherlog config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }

  const config = runtime.config;
  const rawDays = args.rawDays
    ?? config?.settings?.retention?.raw_days
    ?? DEFAULT_RAW_DAYS;

  const { results, summary } = pruneAll(config, {
    rawDays,
    dryRun: args.dryRun,
    rollup: !args.noRollup,
  });

  if (args.json) {
    console.log(JSON.stringify({ results, summary }, null, 2));
    return;
  }

  const label = args.dryRun ? '[dry-run] Prune report' : 'Prune complete';
  console.log(`${label} — threshold: ${rawDays} days, rollup: ${!args.noRollup}`);
  console.log('');
  for (const result of results) {
    console.log(formatResult(result));
  }
  console.log('');
  console.log(`Total: ${summary.total_rows_pruned} rows pruned → ${summary.months_rolled_up} monthly archive records written, ${summary.total_rows_kept} rows kept`);

  if (summary.total_rows_pruned > 0 && !args.dryRun && !args.noRollup) {
    console.log('');
    console.log('Archive: sherlog-velocity/data/archive/<source>-archive.jsonl');
  }
}

main();
