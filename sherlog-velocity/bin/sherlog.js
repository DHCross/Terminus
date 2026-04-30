#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const COMMANDS = {
  analyze: 'src/core/analyzer.js',
  report: 'src/core/reporter.js',
  estimate: 'src/core/estimate.js',
  install: 'install.js',
  update: 'src/cli/update.js',
  init: 'src/cli/init-context.js',
  'init-context': 'src/cli/init-context.js',
  verify: 'src/cli/verify.js',
  doctor: 'src/cli/doctor.js',
  gaps: 'src/cli/gaps.js',
  digest: 'src/cli/digest.js',
  consumers: 'src/cli/consumers.js',
  bounds: 'src/cli/bounds.js',
  prompt: 'src/cli/prompt.js',
  hygiene: 'src/cli/hygiene.js',
  'dead-code': 'src/cli/dead-code.js',
  'index-sync': 'src/cli/index-sync.js',
  bridge: 'src/cli/bridge.js',
  setup: 'src/cli/setup.js',
  retrospective: 'src/cli/retrospective.js',
  sonar: 'src/cli/sonar.js',
  skills: 'src/cli/skills.js',
  session: 'src/cli/session.js',
};

function printHelp() {
  console.log('Usage: sherlog <command> [args]');
  console.log('');
  console.log('Commands:');
  Object.keys(COMMANDS).sort().forEach(command => console.log(`  ${command}`));
}

function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  const script = COMMANDS[command];
  if (!script) {
    console.error(`Unknown Sherlog command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const scriptPath = path.join(PACKAGE_ROOT, script);
  const result = spawnSync(process.execPath, [scriptPath, ...rest], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  process.exit(1);
}

main();
