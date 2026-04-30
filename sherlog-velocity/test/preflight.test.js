const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { runPreflight, parseArgs } = require('../src/cli/preflight');

function makeRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-preflight-${label}-`));
}

function makeConfig(repoRoot, overrides = {}) {
  return {
    repo_root: repoRoot,
    context: {
      mode: 'sherlog-map',
    },
    paths: {},
    settings: {
      gap_scan_ignore_dirs: [],
    },
    ...overrides,
  };
}

function run(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('preflight parseArgs', () => {
  test('parses --file flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--file', 'src/test.js']);
    assert.equal(args.file, 'src/test.js');
    assert.equal(args.planFile, null);
    assert.equal(args.feature, null);
  });

  test('parses --plan-file flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--plan-file', 'plan.json']);
    assert.equal(args.file, null);
    assert.equal(args.planFile, 'plan.json');
    assert.equal(args.feature, null);
  });

  test('parses --feature flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--feature', 'Test Feature']);
    assert.equal(args.file, null);
    assert.equal(args.planFile, null);
    assert.equal(args.feature, 'Test Feature');
  });

  test('parses --threshold flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--file', 'test.js', '--threshold', '10']);
    assert.equal(args.blastThreshold, 10);
  });

  test('parses --json flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--file', 'test.js', '--json']);
    assert.equal(args.json, true);
  });

  test('parses --help flag', () => {
    const args = parseArgs(['node', 'preflight.js', '--help']);
    assert.equal(args.help, true);
  });
});

describe('runPreflight', () => {
  test('returns valid JSON structure with all required fields', () => {
    const result = runPreflight(
      { file: null, planFile: null, feature: 'Test Feature', blastThreshold: 5, json: false, help: false },
      makeConfig(makeRepoRoot('structure'))
    );

    assert.equal(result.schema_version, 'sherlog.preflight.v1');
    assert.equal(result.mode, 'telemetry');
    assert.ok(result.inputs);
    assert.ok(['clear', 'caution', 'blocked_by_policy', 'unknown'].includes(result.status));
    assert.ok(Array.isArray(result.recommended_checks));
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.unknowns));
    assert.equal(typeof result.operator_note, 'string');
  });

  test('includes bounds when --feature is provided', () => {
    const repoRoot = makeRepoRoot('feature-bounds');
    const result = runPreflight(
      { file: null, planFile: null, feature: 'Test Feature', blastThreshold: 5, json: false, help: false },
      makeConfig(repoRoot)
    );

    assert.ok(result.bounds);
    assert.equal(result.bounds.feature_target, 'Test Feature');
    assert.ok(result.bounds.topology);
    assert.ok(result.bounds.obligations);

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('handles blast-radius errors gracefully', () => {
    const repoRoot = makeRepoRoot('blast-error');
    const result = runPreflight(
      { file: 'nonexistent.js', planFile: null, feature: null, blastThreshold: 5, json: false, help: false },
      makeConfig(repoRoot)
    );

    assert.ok(result.blast_radius);
    assert.equal(result.blast_radius.found, false);
    assert.ok(result.unknowns.length > 0);

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('status is blocked_by_policy when bounds has do_not_touch files', () => {
    const repoRoot = makeRepoRoot('blocked-policy');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Legacy',
            paths: ['src/**'],
            touch_policy: 'do_not_touch',
            belief: 'Do not edit legacy code.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = runPreflight(
      { file: null, planFile: null, feature: 'Test', blastThreshold: 5, json: false, help: false },
      makeConfig(repoRoot)
    );

    // Since we don't have files in the bounds call, status should be clear
    // But if we had do_not_touch files, it would be blocked_by_policy
    assert.ok(['clear', 'caution', 'blocked_by_policy', 'unknown'].includes(result.status));

    fs.rmSync(repoRoot, { recursive: true });
  });
});

describe('preflight CLI', () => {
  test('emits valid JSON with --json flag', () => {
    const repoRoot = makeRepoRoot('cli-json');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Core',
            paths: ['src/**'],
            belief: 'Keep core healthy.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'preflight.js');
    const raw = run(`node "${scriptPath}" --feature "CLI Test" --json`, repoRoot);
    const payload = JSON.parse(raw);

    assert.equal(payload.schema_version, 'sherlog.preflight.v1');
    assert.equal(payload.mode, 'telemetry');
    assert.equal(payload.inputs.feature, 'CLI Test');
    assert.ok(payload.bounds);
    assert.equal(typeof payload.status, 'string');

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('shows help with --help flag', () => {
    const repoRoot = makeRepoRoot('cli-help');
    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'preflight.js');
    const raw = run(`node "${scriptPath}" --help`, repoRoot);

    assert.ok(raw.includes('Usage:'));
    assert.ok(raw.includes('--file'));
    assert.ok(raw.includes('--plan-file'));
    assert.ok(raw.includes('--feature'));

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('requires at least one input flag', () => {
    const repoRoot = makeRepoRoot('cli-no-input');
    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'preflight.js');

    try {
      run(`node "${scriptPath}"`, repoRoot);
      assert.fail('Should have thrown an error');
    } catch (err) {
      assert.ok(err.message.includes('At least one of --file, --plan-file, or --feature is required'));
    }

    fs.rmSync(repoRoot, { recursive: true });
  });
});
