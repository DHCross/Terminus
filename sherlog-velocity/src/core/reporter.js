#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const {
  confidenceFromSample,
  ensureDir,
  readJson,
  readJsonLines,
  resolveRuntimeConfig,
  rolling,
} = require('./shared');

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
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
  const args = { zones: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if ((arg === '--zone' || arg === '--area' || arg === '--vector' || arg === '--bucket') && process.argv[i + 1]) {
      args.zones.push(process.argv[++i]);
    }
  }

  const config = loadConfig();
  const entries = readJsonLines(config.paths.velocity_log);
  const latest = entries[entries.length - 1] || null;
  const roll = rolling(entries, 10);

  ensureDir(path.dirname(config.paths.report_output_markdown));
  ensureDir(path.dirname(config.paths.summary_output_json));

  const isFiltered = args.zones.length > 0;
  const zoneTitle = isFiltered ? ` (Zones: ${args.zones.join(', ')})` : '';

  if (!latest) {
    fs.writeFileSync(
      config.paths.report_output_markdown,
      `# Velocity Forecast${zoneTitle}\n\nNo data yet. Run \`npm run velocity:run\`.\n`,
      'utf8'
    );
    fs.writeFileSync(
      config.paths.summary_output_json,
      JSON.stringify({ latest: null, rolling: null, confidence: 'low', zones: args.zones }, null, 2),
      'utf8'
    );
    console.log('No entries found; wrote placeholder artifacts.');
    return;
  }

  const confidence = confidenceFromSample(entries.length);
  const md = [
    `# Velocity Forecast${zoneTitle}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Latest Snapshot',
    `- Commits: **${latest.total_commits}**`,
    `- Window: **${latest.window_days} day(s)**`,
    `- Velocity (window): **${(latest.commits_per_day_window || 0).toFixed(2)} commits/day**`,
    `- Velocity (active): **${(latest.commits_per_hour_active || 0).toFixed(2)} commits/hour**`,
    `- Active duration: **${fmtDuration(latest.total_duration_seconds)}**`,
    `- Range: ${latest.start || 'n/a'} -> ${latest.end || 'n/a'}`,
    '',
    '## Rolling (last 10 runs)',
    roll
      ? `- ${roll.commits} commits / ${roll.days} days => **${roll.commits_per_day_window.toFixed(2)} commits/day** (sample ${roll.sample})`
      : '- Not enough data yet.',
    '',
    '## Environment',
    `- Stack: ${config.stack?.language || 'unknown'}${config.stack?.framework ? ` (${config.stack.framework})` : ''}`,
    `- CI: ${config.ci || 'none'}`,
    `- Bundler: ${config.bundler?.type || 'none'}`,
    `- Confidence: **${confidence.toUpperCase()}**`,
    '',
  ].join('\n');

  fs.writeFileSync(config.paths.report_output_markdown, md, 'utf8');
  fs.writeFileSync(
    config.paths.summary_output_json,
    JSON.stringify({ latest, rolling: roll, confidence, runs: entries.length }, null, 2),
    'utf8'
  );

  console.log(`Wrote: ${config.paths.report_output_markdown}`);
  console.log(`Wrote: ${config.paths.summary_output_json}`);
}

if (require.main === module) main();
