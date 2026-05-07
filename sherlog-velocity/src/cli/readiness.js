#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { computeReadiness, overallStatus } = require('../core/readiness');

const STATUS_ICONS = {
  reliable: '✓',
  degraded: '~',
  offline:  '✗',
};

const STATUS_LABELS = {
  reliable: 'reliable',
  degraded: 'degraded',
  offline:  'offline ',
};

function parseArgs(argv) {
  const out = { json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:readiness [-- --json]');
  console.log('');
  console.log('Reports which Sherlog analysis capabilities are available in the current context.');
  console.log('');
  console.log('Options:');
  console.log('  --json        emit structured JSON');
  console.log('  --help, -h    show this message');
}

function printHuman(capabilities, overall) {
  console.log('SHERLOG READINESS');
  console.log('');

  const nameWidth = Math.max(...Object.keys(capabilities).map(k => k.length));

  for (const [name, cap] of Object.entries(capabilities)) {
    const icon = STATUS_ICONS[cap.status] || '?';
    const label = STATUS_LABELS[cap.status] || cap.status.padEnd(8);
    const paddedName = name.padEnd(nameWidth);
    const line = `  ${icon}  ${paddedName}  ${label}  ${cap.detail}`;
    console.log(line);
    if (cap.note) {
      console.log(`     ${' '.repeat(nameWidth)}             ${cap.note}`);
    }
  }

  console.log('');
  console.log(`overall: ${overall}`);
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }

  const capabilities = computeReadiness(runtime.repoRoot, runtime.config);
  const overall = overallStatus(capabilities);

  if (args.json) {
    console.log(JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      repo_root: runtime.repoRoot,
      overall,
      capabilities,
    }, null, 2));
    return;
  }

  printHuman(capabilities, overall);
}

if (require.main === module) main();

module.exports = { parseArgs };
