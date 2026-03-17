#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const {
  detectBranchHead,
  ensureFile,
  getGitWindowMetrics,
  readJson,
  resolveRuntimeConfig,
} = require('./shared');

function parseArgs(argv, defaultDays) {
  const out = { days: defaultDays };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) {
      out.days = Math.max(1, parseInt(argv[++i], 10) || defaultDays);
    }
  }
  return out;
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

function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv, config.settings?.window_days || 7);
  const metrics = getGitWindowMetrics(config.repo_root, args.days);
  const { branch, head } = detectBranchHead(config.repo_root);

  const row = {
    id: `run_${Date.now()}`,
    timestamp: new Date().toISOString(),
    repo_root: config.repo_root,
    branch,
    head,
    ...metrics,
  };

  ensureFile(config.paths.velocity_log, '');
  fs.appendFileSync(config.paths.velocity_log, JSON.stringify(row) + '\n', 'utf8');

  console.log('Velocity snapshot written');
  console.log(`- commits: ${row.total_commits}`);
  console.log(`- commits/day (window): ${row.commits_per_day_window.toFixed(2)}`);
  console.log(`- commits/hour (active): ${row.commits_per_hour_active.toFixed(2)}`);
  console.log(`- log: ${config.paths.velocity_log}`);
}

if (require.main === module) main();
