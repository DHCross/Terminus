#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const out = { days: Number(process.env.VELOCITY_WINDOW_DAYS || 7) };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) {
      out.days = Math.max(1, parseInt(argv[++i], 10) || 7);
    }
  }
  return out;
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readGitMetrics(days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cmd = `git log --since="${since}" --pretty=format:"%H|%ai|%s"`;
  const raw = execSync(cmd, { encoding: 'utf8' }).trim();

  if (!raw) {
    return {
      window_days: days,
      total_commits: 0,
      totalDurationSeconds: 0,
      commits_per_hour: 0,
      start: null,
      end: null,
      samples: [],
    };
  }

  const rows = raw.split('\n').map(line => {
    const [sha, date, subject] = line.split('|');
    return { sha, date, subject };
  }).filter(Boolean);

  const dates = rows.map(r => new Date(r.date).getTime()).filter(Number.isFinite);
  const startMs = Math.min(...dates);
  const endMs = Math.max(...dates);
  const durationSec = Math.max(1, Math.round((endMs - startMs) / 1000));
  const commitsPerHour = rows.length / (durationSec / 3600);

  return {
    window_days: days,
    total_commits: rows.length,
    totalDurationSeconds: durationSec,
    commits_per_hour: commitsPerHour,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    samples: rows.slice(0, 20),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const workingDir = process.cwd();

  const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const logPath = path.resolve(workingDir, process.env.VELOCITY_LOG_PATH || '.logs/velocity-log.jsonl');

  const metrics = readGitMetrics(args.days);
  const row = {
    id: `run_${Date.now()}`,
    timestamp: new Date().toISOString(),
    repo_root: workingDir,
    branch,
    head,
    ...metrics,
  };

  ensureFile(logPath);
  fs.appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8');

  console.log('Velocity snapshot written:');
  console.log(`- commits: ${row.total_commits}`);
  console.log(`- commits/hour: ${row.commits_per_hour.toFixed(2)}`);
  console.log(`- log: ${logPath}`);
}

if (require.main === module) main();
