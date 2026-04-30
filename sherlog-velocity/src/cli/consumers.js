#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { analyzeConsumers } = require('../core/consumers');

function parseArgs(argv) {
  const out = {
    file: '',
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--file' || arg === '-f') && argv[i + 1]) out.file = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (!arg.startsWith('-')) out.file = out.file || arg;
  }

  return out;
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function groupChains(chains = []) {
  const grouped = new Map();
  chains.forEach(chain => {
    if (!Array.isArray(chain) || chain.length < 2) return;
    const prefix = chain.slice(0, -1).join(' -> ');
    const consumer = chain[chain.length - 1];
    if (!consumer) return;
    const set = grouped.get(prefix) || new Set();
    set.add(consumer);
    grouped.set(prefix, set);
  });
  return Array.from(grouped.entries()).map(([prefix, consumers]) => ({
    prefix,
    consumers: Array.from(consumers).sort((a, b) => a.localeCompare(b)),
  }));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error('Usage: node sherlog-velocity/src/cli/consumers.js <filepath> [--json]');
    process.exit(1);
  }

  const config = loadConfig();
  const { summary } = analyzeConsumers(config, args.file);
  if (!summary.target_file) {
    console.error(`Target file not found in scan set: ${args.file}`);
    process.exit(1);
  }

  const output = {
    target_file: summary.target_file,
    exports: summary.exports,
    downstream_count: summary.downstream_count,
    by_export: summary.by_export.map(entry => ({
      export: entry.export,
      chains: entry.chains,
      consumers: entry.consumers,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('SHERLOG CONSUMER TRACE');
  console.log(`Target: ${summary.target_file}`);
  console.log(`Named exports: ${summary.exports.length}`);
  console.log(`Downstream consumers: ${summary.downstream_count}`);
  console.log('');
  console.log('Chains:');

  if (!summary.by_export.length) {
    console.log('- none');
    return;
  }

  summary.by_export.forEach(entry => {
    const grouped = groupChains(entry.chains);
    if (!grouped.length) {
      console.log(`${entry.export}: ${summary.target_file}`);
      return;
    }
    grouped.forEach(group => {
      console.log(`${entry.export}: ${group.prefix} -> ${group.consumers.join(', ')}`);
    });
  });
}

if (require.main === module) main();
