#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { readJson, resolveRuntimeConfig, toPortableConfig } = require('../core/shared');
const { scanHygiene } = require('../core/hygiene');

function parseArgs(argv) {
  const out = {
    json: false,
    types: [],
    help: false,
    record: true,
    autoTune: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--type' && argv[i + 1]) out.types.push(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-record') out.record = false;
    else if (arg === '--auto-tune') out.autoTune = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/hygiene.js [options]');
  console.log('');
  console.log('Scan for code hygiene issues and architectural flags.');
  console.log('');
  console.log('Options:');
  console.log('  --type <type>   Filter by finding type (repeatable)');
  console.log('                  Types: todo_cluster, console_log, excessive_any, monolith, monolith_size, nesting_depth, missing_docs');
  console.log('  --json          Machine-readable JSON output');
  console.log('  --no-record     Skip writing to hygiene history');
  console.log('  --auto-tune     Apply suggested threshold adjustments to config');
  console.log('  --help, -h      Show this message');
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  if (!config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return resolveRuntimeConfig(config);
}

const TYPE_LABELS = {
  todo_cluster: 'TODO/FIXME Clusters',
  console_log: 'Console Log Leftovers',
  excessive_any: 'Excessive `any` Usage',
  monolith: 'Large Files (Line Count)',
  monolith_size: 'Large Files (File Size)',
  nesting_depth: 'Nesting Depth Hotspots',
  missing_docs: 'Missing Documentation',
};

function formatFinding(f) {
  if (f.type === 'monolith') return `  ${f.file} (${f.lines} lines)`;
  if (f.type === 'monolith_size') return `  ${f.file} (${f.size_kb} KB)`;
  if (f.type === 'nesting_depth') return `  ${f.file} (depth ${f.depth}, threshold ${f.threshold})`;
  if (f.type === 'missing_docs') return `  ${f.file} (${f.lines} lines, no corresponding doc)`;
  return `  ${f.file} (${f.count} occurrences)`;
}

function applyTuning(suggestions) {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  if (!config) return false;

  if (!config.settings) config.settings = {};
  if (!config.settings.hygiene) config.settings.hygiene = {};

  for (const s of suggestions) {
    config.settings.hygiene[s.key] = s.suggested;
  }

  fs.writeFileSync(configPath, JSON.stringify(toPortableConfig(config), null, 2) + '\n', 'utf8');
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const options = { record: args.record };
  if (args.types.length > 0) options.types = args.types;

  const result = scanHygiene(config, options);

  // Auto-tune: apply suggestions to config
  if (args.autoTune && result.tuning.length > 0) {
    const applied = applyTuning(result.tuning);
    if (applied && !args.json) {
      console.log('Auto-tune: applied threshold adjustments to config.');
      result.tuning.forEach(s => {
        console.log(`  ${s.key}: ${s.current} -> ${s.suggested} (${s.reason.split(':')[0]})`);
      });
      console.log('');
    }
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('SHERLOG HYGIENE SCAN');
  console.log(`Scanned files: ${result.summary.scanned_files}`);
  console.log(`Total findings: ${result.summary.total_findings}`);
  if (result.gaps.length > 0) {
    console.log(`Gaps: ${result.gaps.join(', ')}`);
  }
  console.log('');

  if (result.findings.length === 0) {
    console.log('No hygiene issues detected.');
  } else {
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
  }

  // Trend summary
  if (result.trends && result.trends.overall !== 'insufficient_data') {
    const parts = [];
    for (const [type, info] of Object.entries(result.trends.by_type)) {
      if (info.current === 0 && info.avg === 0) continue;
      const sign = info.delta > 0 ? '+' : '';
      parts.push(`${type}: ${info.trend}(${sign}${info.delta})`);
    }
    console.log(`Trend: ${result.trends.overall} (${result.trends.runs} runs)`);
    if (parts.length > 0) {
      console.log(`  ${parts.join(', ')}`);
    }
    console.log('');
  } else if (result.trends) {
    console.log(`Trend: collecting data (${result.trends.runs} run(s), need ${2} for trends)`);
    console.log('');
  }

  // Tuning suggestions
  if (result.tuning.length > 0 && !args.autoTune) {
    console.log('Tuning suggestions:');
    result.tuning.forEach(s => {
      console.log(`  ${s.key}: ${s.current} -> ${s.suggested} (${s.reason.split(':')[0]})`);
    });
    console.log('  Run with --auto-tune to apply.');
    console.log('');
  }
}

if (require.main === module) main();
