#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const { readJson, resolveRuntimeConfig } = require('../core/shared');
const { generateStaticBounds } = require('../core/boundary-mapper');

function parseArgs(argv) {
  const out = {
    feature: 'Current Task',
    files: [],
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--files' && argv[i + 1]) {
      out.files = argv[++i]
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    }
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/bounds.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --feature "Name"      feature or task label (default: "Current Task")');
  console.log('  --files "a,b,c"       comma-separated target files');
  console.log('  --help, -h            show this message');
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  if (!config) {
    throw new Error('Config not found. Run `node sherlog-velocity/install.js` first.');
  }
  return resolveRuntimeConfig(config);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const bounds = generateStaticBounds(args.feature, args.files, config);
  process.stdout.write(`${JSON.stringify(bounds, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  loadConfig,
};
