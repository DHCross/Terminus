#!/usr/bin/env node
/* eslint-disable no-console */

const { execSync } = require('child_process');
const { createEstimatePayload } = require('../core/estimate');
const {
  ensureFile,
  loadRuntimeConfig,
  readJsonLines,
} = require('../core/shared');

function parseArgs(argv) {
  const out = {
    feature: '',
    fromRef: null,
    toRef: 'HEAD',
    since: null,
    until: null,
    token: [],
    json: false,
    record: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--from-ref' && argv[i + 1]) out.fromRef = argv[++i];
    else if (arg === '--to-ref' && argv[i + 1]) out.toRef = argv[++i];
    else if (arg === '--since' && argv[i + 1]) out.since = argv[++i];
    else if (arg === '--until' && argv[i + 1]) out.until = argv[++i];
    else if (arg === '--token' && argv[i + 1]) out.token.push(argv[++i]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--record') out.record = true;
    else if (!arg.startsWith('-')) out.feature = out.feature ? `${out.feature} ${arg}` : arg;
  }

  return out;
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) throw new Error('Config not found. Run `node sherlog-velocity/install.js` first.');
  return runtime.config;
}

function runGit(repoRoot, cmd) {
  return execSync(cmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function parseRows(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [sha, epoch, subject] = line.split('|');
      const ts = Number(epoch);
      return {
        sha,
        epoch: Number.isFinite(ts) ? ts : null,
        subject: subject || '',
      };
    })
    .filter(item => item.sha && Number.isFinite(item.epoch));
}

function quote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function buildLogCommand(args) {
  const parts = ['git log --pretty=format:"%H|%ct|%s"'];
  if (args.since) parts.push(`--since=${quote(args.since)}`);
  if (args.until) parts.push(`--until=${quote(args.until)}`);
  args.token.forEach(token => {
    parts.push(`--grep=${quote(token)}`);
  });
  if (args.fromRef) parts.push(`${args.fromRef}..${args.toRef || 'HEAD'}`);
  return parts.join(' ');
}

function computeWindow(args, rows, repoRoot) {
  if (!rows.length) {
    return {
      start_epoch: null,
      end_epoch: null,
      calendar_days: 0,
      active_days: 0,
    };
  }

  const epochs = rows.map(item => item.epoch);
  const startEpoch = Math.min(...epochs);
  const endEpoch = Math.max(...epochs);

  let calendarStart = startEpoch;
  let calendarEnd = endEpoch;

  try {
    if (args.fromRef) {
      const parsed = Number(runGit(repoRoot, `git show -s --format=%ct ${quote(args.fromRef)}`));
      if (Number.isFinite(parsed)) calendarStart = parsed;
    } else if (args.since) {
      const parsed = Math.floor(new Date(args.since).getTime() / 1000);
      if (Number.isFinite(parsed)) calendarStart = parsed;
    }
  } catch {
    // keep inferred epoch
  }

  try {
    if (args.toRef) {
      const parsed = Number(runGit(repoRoot, `git show -s --format=%ct ${quote(args.toRef)}`));
      if (Number.isFinite(parsed)) calendarEnd = parsed;
    } else if (args.until) {
      const parsed = Math.floor(new Date(args.until).getTime() / 1000);
      if (Number.isFinite(parsed)) calendarEnd = parsed;
    }
  } catch {
    // keep inferred epoch
  }

  const calendarDays = Math.max(1, (calendarEnd - calendarStart) / 86400);
  const activeDays = Math.max(1, (endEpoch - startEpoch) / 86400);

  return {
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    calendar_days: Number(calendarDays.toFixed(2)),
    active_days: Number(activeDays.toFixed(2)),
  };
}

function createRetrospective(args, config) {
  const repoRoot = config.repo_root || process.cwd();
  const entries = readJsonLines(config.paths.velocity_log);
  const feature = args.feature || 'Unnamed Feature';

  let estimate;
  try {
    estimate = createEstimatePayload({ feature, autoGaps: true, config, entries }).estimate;
  } catch (err) {
    throw new Error(`Unable to compute estimate baseline: ${err.message}`);
  }

  const command = buildLogCommand(args);
  const rows = parseRows(runGit(repoRoot, command));
  const window = computeWindow(args, rows, repoRoot);

  const actualCommits = rows.length;
  const actualCommitsPerDay = window.calendar_days > 0
    ? Number((actualCommits / window.calendar_days).toFixed(2))
    : 0;
  const predictedCommits = Number(estimate.commits || 0);
  const predictedDays = estimate.days;
  const commitDelta = actualCommits - predictedCommits;
  const commitErrorPct = predictedCommits > 0
    ? Number((((actualCommits - predictedCommits) / predictedCommits) * 100).toFixed(1))
    : null;

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    feature,
    scope: {
      from_ref: args.fromRef,
      to_ref: args.toRef,
      since: args.since,
      until: args.until,
      tokens: args.token,
      log_command: command,
    },
    estimate: {
      commits: predictedCommits,
      days: predictedDays,
      confidence: estimate.confidence,
      breakdown: estimate.breakdown,
      gap_source: estimate.gap_source,
    },
    actual: {
      commits: actualCommits,
      calendar_days: window.calendar_days,
      active_days: window.active_days,
      commits_per_day_calendar: actualCommitsPerDay,
      first_commit: window.start_epoch ? new Date(window.start_epoch * 1000).toISOString() : null,
      last_commit: window.end_epoch ? new Date(window.end_epoch * 1000).toISOString() : null,
      sample_commits: rows.slice(0, 20),
    },
    comparison: {
      commit_delta: commitDelta,
      commit_error_pct: commitErrorPct,
      interpretation: commitDelta > 0
        ? 'actual_exceeded_estimate'
        : commitDelta < 0
          ? 'actual_below_estimate'
          : 'actual_matches_estimate',
    },
    recommendation: [
      'Use 3-5 completed features before changing gap weights.',
      'Only tune weights in small increments and re-check error trend.',
      'Record closure refs (`--from-ref`, `--to-ref`) for repeatable retrospectives.',
    ],
  };
}

function maybeRecord(payload, config) {
  const logPath = config?.paths?.retrospective_log
    || path.join(config.repo_root || process.cwd(), 'sherlog-velocity/data/retrospective-log.jsonl');
  ensureFile(logPath, '');
  require('fs').appendFileSync(logPath, `${JSON.stringify(payload)}\n`, 'utf8');
  return logPath;
}

function printHuman(payload, recordPath = null) {
  console.log('SHERLOG RETROSPECTIVE');
  console.log(`Feature: ${payload.feature}`);
  console.log(`Estimate: ${payload.estimate.commits} commits (${payload.estimate.days ?? 'unknown'} day(s), ${String(payload.estimate.confidence).toUpperCase()})`);
  console.log(`Actual: ${payload.actual.commits} commits over ${payload.actual.calendar_days} calendar day(s)`);
  console.log(`Delta: ${payload.comparison.commit_delta >= 0 ? '+' : ''}${payload.comparison.commit_delta} commits (${payload.comparison.commit_error_pct ?? 'n/a'}%)`);
  console.log(`Interpretation: ${payload.comparison.interpretation}`);
  if (recordPath) console.log(`Recorded: ${recordPath}`);
}

function main() {
  const args = parseArgs(process.argv);
  let config;

  try {
    config = loadConfig();
    const payload = createRetrospective(args, config);
    const recordPath = args.record ? maybeRecord(payload, config) : null;
    if (args.json) {
      const out = {
        ...payload,
        record_path: recordPath,
      };
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    printHuman(payload, recordPath);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();
