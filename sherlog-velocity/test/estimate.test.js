const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { createEstimatePayload, renderPrompt } = require('../src/core/estimate');

function run(cmd, cwd, env = {}) {
  return execSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initGitRepo(repoRoot) {
  run('git init', repoRoot);
  run('git config user.email "sherlog@test.local"', repoRoot);
  run('git config user.name "Sherlog Test"', repoRoot);
}

function commitAll(repoRoot, message, isoTimestamp) {
  run('git add .', repoRoot);
  const env = isoTimestamp
    ? { GIT_AUTHOR_DATE: isoTimestamp, GIT_COMMITTER_DATE: isoTimestamp }
    : {};
  run(`git commit -m "${message}"`, repoRoot, env);
}

function makeConfig(repoRoot) {
  return {
    repo_root: repoRoot,
    bundler: { type: null, bundles: [] },
    context: { mode: 'sherlog-map', map_file: path.join(repoRoot, 'sherlog.context.json') },
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
      context_map: path.join(repoRoot, 'sherlog.context.json'),
      gap_weights: path.join(repoRoot, 'gap-weights.json'),
      velocity_log: path.join(repoRoot, 'velocity-log.jsonl'),
      gap_history_log: path.join(repoRoot, 'gap-history.jsonl'),
      gap_acknowledgements: path.join(repoRoot, 'sherlog.acknowledgements.json'),
      hygiene_history_log: path.join(repoRoot, 'hygiene-history.jsonl'),
    },
    settings: {
      gap_scan_ignore_dirs: [],
      hygiene: {
        todo_cluster_threshold: 3,
        console_log_max: 0,
        any_usage_threshold: 5,
        monolith_line_threshold: 500,
        monolith_size_kb_threshold: 150,
        missing_docs_line_threshold: 100,
        nesting_depth_threshold: 5,
      },
    },
  };
}

function seedRepo(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

  fs.writeFileSync(
    path.join(repoRoot, 'src', 'feature.ts'),
    [
      'export function runFeature(payload: any): any {',
      '  return payload as any;',
      '}',
    ].join('\n') + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'feature.md'),
    '# feature docs\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoRoot, 'sherlog.context.json'),
    JSON.stringify({
      zones: [
        {
          name: 'Core',
          paths: ['src/**'],
          belief: 'Keep the core path typed and test-backed.',
          last_updated: '2026-02-20',
        },
      ],
    }, null, 2) + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoRoot, 'gap-weights.json'),
    JSON.stringify({
      unknown: 10,
      test_coverage: 15,
      missing_implementation: 20,
      documentation: 5,
      type_orphan: 2,
    }, null, 2) + '\n',
    'utf8'
  );
}

function seedSessionLog(repoRoot) {
  const rows = [
    {
      feature: 'Renderer cleanup',
      type: 'implementation',
      startTime: '2026-02-24T09:00:00Z',
      endTime: '2026-02-24T10:00:00Z',
      durationSeconds: 3600,
      notes: [],
    },
    {
      feature: 'Renderer cleanup',
      type: 'debugging',
      startTime: '2026-02-24T10:15:00Z',
      endTime: '2026-02-24T11:00:00Z',
      durationSeconds: 2700,
      notes: [{ timestamp: '2026-02-24T10:40:00Z', text: 'fix again after regression' }],
    },
    {
      feature: 'Prompt wiring',
      type: 'discovery',
      startTime: '2026-02-24T11:30:00Z',
      endTime: '2026-02-24T12:00:00Z',
      durationSeconds: 1800,
      notes: [{ timestamp: '2026-02-24T11:45:00Z', text: 'mapped existing flow' }],
    },
  ];
  fs.writeFileSync(
    path.join(repoRoot, 'session-log.jsonl'),
    rows.map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8'
  );
}

describe('estimate payload fallback', () => {
  test('builds an initial scan bundle when velocity history is absent', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-estimate-initial-'));
    seedRepo(repoRoot);
    seedSessionLog(repoRoot);
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed repo', '2026-02-24T10:00:00Z');

    const config = makeConfig(repoRoot);
    const payload = createEstimatePayload({
      feature: 'Typed Refactor',
      config,
      autoGaps: true,
    });

    assert.equal(payload.historical.runs, 0);
    assert.equal(payload.historical.baseline, 'initial_scan');
    assert.ok(payload.self_model, 'self-model payload should be present');
    assert.ok(payload.self_model.summary.total_modules >= 1);
    assert.ok(payload.initial_scan, 'initial scan payload should be present');
    assert.equal(payload.initial_scan.label, 'initial scan — no velocity baseline yet');
    assert.ok(Array.isArray(payload.initial_scan.source.gaps));
    assert.ok(payload.initial_scan.source.gaps.length > 0);
    assert.ok(Array.isArray(payload.initial_scan.source.architectural_rules));
    assert.ok(payload.initial_scan.source.architectural_rules.length >= 1);
    assert.ok(Array.isArray(payload.initial_scan.source.recent_commits));
    assert.ok(payload.initial_scan.source.recent_commits.length >= 1);

    const prompt = renderPrompt(payload);
    assert.ok(prompt.includes('CODEBASE SELF-MODEL'));
    assert.ok(prompt.includes('STATUS: initial scan — no velocity baseline yet'));
    assert.ok(prompt.includes('INITIAL SCAN SOURCES:'));
    assert.ok(prompt.includes('Recent git log sample'));
    assert.ok(prompt.includes('SESSION TRACKING OUTPUT FEATURES:'));
    assert.ok(prompt.includes('Invisible work multiplier:'));
    assert.ok(prompt.includes('Wasted time ledger:'));
    assert.ok(prompt.includes('Velocity tracker reality check:'));
    assert.ok(prompt.includes('AI timeline bias:'));
    assert.ok(prompt.includes('Boss-ready report headline:'));
  });

  test('omits initial scan section when velocity history is provided', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-estimate-history-'));
    seedRepo(repoRoot);
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed repo', '2026-02-24T10:00:00Z');

    const config = makeConfig(repoRoot);
    const entries = [
      {
        id: 'run_1',
        timestamp: '2026-02-24T11:00:00Z',
        total_commits: 6,
        total_duration_seconds: 3600,
        window_days: 7,
        commits_per_hour_active: 6,
        commits_per_day_window: 0.86,
      },
    ];

    const payload = createEstimatePayload({
      feature: 'Typed Refactor',
      config,
      entries,
      autoGaps: true,
    });

    assert.equal(payload.historical.runs, 1);
    assert.equal(payload.historical.baseline, 'velocity_history');
    assert.equal(payload.initial_scan, null);

    const prompt = renderPrompt(payload);
    assert.ok(!prompt.includes('initial scan — no velocity baseline yet'));
    assert.ok(!prompt.includes('INITIAL SCAN SOURCES:'));
  });
});
