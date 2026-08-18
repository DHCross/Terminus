#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function readEntries(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function rolling(entries, limit = 10) {
  const slice = entries.slice(-limit);
  if (!slice.length) return null;
  const commits = slice.reduce((a, e) => a + (e.total_commits || 0), 0);
  const seconds = slice.reduce((a, e) => a + (e.totalDurationSeconds || 0), 0);
  const cph = seconds > 0 ? commits / (seconds / 3600) : 0;
  return { sample: slice.length, commits, seconds, commits_per_hour: cph };
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const cwd = process.cwd();
  const logPath = path.resolve(cwd, process.env.VELOCITY_LOG_PATH || '.logs/velocity-log.jsonl');
  const reportPath = path.resolve(cwd, 'docs/velocity-forecast.md');
  const summaryPath = path.resolve(cwd, 'velocity-artifacts/velocity-summary.json');

  const entries = readEntries(logPath);
  const latest = entries[entries.length - 1] || null;
  const roll = rolling(entries, 10);

  ensureDir(reportPath);
  ensureDir(summaryPath);

  if (!latest) {
    fs.writeFileSync(reportPath, '# Velocity Forecast\n\nNo data yet. Run `npm run velocity:run`.\n', 'utf8');
    fs.writeFileSync(summaryPath, JSON.stringify({ latest: null, rolling: null }, null, 2), 'utf8');
    console.log('No entries found; wrote placeholder artifacts.');
    return;
  }

  const md = [
    '# Velocity Forecast',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Latest Snapshot',
    `- Commits: **${latest.total_commits}**`,
    `- Duration: **${fmtDuration(latest.totalDurationSeconds)}**`,
    `- Velocity: **${(latest.commits_per_hour || 0).toFixed(2)} commits/hour**`,
    `- Window: ${latest.start || 'n/a'} -> ${latest.end || 'n/a'}`,
    '',
    '## Rolling (last 10 runs)',
    roll
      ? `- ${roll.commits} commits over ${fmtDuration(roll.seconds)} => **${roll.commits_per_hour.toFixed(2)} commits/hour** (sample ${roll.sample})`
      : '- Not enough data yet.',
    '',
  ].join('\n');

  fs.writeFileSync(reportPath, md, 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify({ latest, rolling: roll }, null, 2), 'utf8');

  console.log(`Wrote: ${reportPath}`);
  console.log(`Wrote: ${summaryPath}`);
}

if (require.main === module) main();
