const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { generateStaticBounds } = require('../src/core/boundary-mapper');
const { readJson } = require('../src/core/shared');

function makeRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-bounds-${label}-`));
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

describe('generateStaticBounds', () => {
  test('loads default repo-root context and maps matched files to safe_touch with contracts', () => {
    const repoRoot = makeRepoRoot('default-context');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Core',
            paths: ['src/**'],
            belief: 'Keep the core code path healthy.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = generateStaticBounds('Static Bounds', [
      path.join(repoRoot, 'src', 'index.js'),
    ], makeConfig(repoRoot));

    assert.equal(result.feature_target, 'Static Bounds');
    assert.equal(result.confidence_score, 80);
    assert.deepStrictEqual(result.topology.recommended_entrypoints, [
      {
        file: 'src/index.js',
        priority: 1,
        reason: 'Matched context zone: Core',
      },
    ]);
    assert.deepStrictEqual(result.topology.safe_touch, [
      {
        file: 'src/index.js',
        confidence: 90,
        reason: 'Matched context zone: Core',
      },
    ]);
    assert.deepStrictEqual(result.obligations.contracts_relevant, [
      {
        description: 'Keep the core code path healthy.',
        strictness: 'absolute',
      },
    ]);
    assert.deepStrictEqual(result.obligations.verifications_required, [
      {
        type: 'context_check',
        description: 'Validate edits against zone belief: Core',
        mandatory: true,
      },
    ]);

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('respects config-resolved context path and sends unmatched files to risky_touch', () => {
    const repoRoot = makeRepoRoot('config-context');
    fs.mkdirSync(path.join(repoRoot, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'custom.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Libraries',
            paths: ['lib/**'],
            belief: 'Shared library seams must stay stable.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = generateStaticBounds('Config Bounds', ['src/missing.js'], makeConfig(repoRoot, {
      context: {
        mode: 'sherlog-map',
        map_file: 'custom.context.json',
      },
    }));

    assert.deepStrictEqual(result.topology.safe_touch, []);
    assert.deepStrictEqual(result.topology.risky_touch, [
      {
        file: 'src/missing.js',
        blast_radius: 'medium',
        constraints: 'Unmapped territory: validate ownership and tests before editing.',
      },
    ]);
    assert.deepStrictEqual(result.obligations.verifications_required, [
      {
        type: 'ownership_check',
        description: 'Confirm ownership for unmapped files before editing',
        mandatory: true,
      },
    ]);
    assert.deepStrictEqual(result.obligations.evidence_required, [
      'Context confirmation for unmapped file: src/missing.js',
    ]);

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('handles missing or invalid context maps gracefully', () => {
    const repoRoot = makeRepoRoot('missing-context');
    const result = generateStaticBounds('Missing Context', ['src/app.js'], makeConfig(repoRoot, {
      context: {
        mode: 'sherlog-map',
        map_file: 'missing.context.json',
      },
    }));

    assert.deepStrictEqual(result.topology.safe_touch, []);
    assert.equal(result.topology.risky_touch.length, 1);

    fs.writeFileSync(path.join(repoRoot, 'broken.context.json'), '{ not json', 'utf8');
    const invalidResult = generateStaticBounds('Broken Context', ['src/app.js'], makeConfig(repoRoot, {
      context: {
        mode: 'sherlog-map',
        map_file: 'broken.context.json',
      },
    }));

    assert.deepStrictEqual(invalidResult.topology.safe_touch, []);
    assert.equal(invalidResult.topology.risky_touch.length, 1);
    fs.rmSync(repoRoot, { recursive: true });
  });

  test('supports touch_policy overrides and vessel-prefixed patterns', () => {
    const repoRoot = makeRepoRoot('touch-policy');
    fs.mkdirSync(path.join(repoRoot, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src', 'legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Reference Docs',
            paths: ['vessel/src/docs/**'],
            touch_policy: 'reference_only',
            belief: 'Use these docs for context only.',
          },
          {
            name: 'Legacy Core',
            paths: ['src/legacy/**'],
            touch_policy: 'do_not_touch',
            belief: 'Legacy branch is frozen.',
          },
          {
            name: 'Core',
            paths: ['src/core/**'],
            belief: 'Core is safe to edit.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const result = generateStaticBounds('Policies', [
      'src/core/app.js',
      'src/docs/reference.md',
      'src/legacy/frozen.js',
    ], makeConfig(repoRoot));

    assert.deepStrictEqual(result.topology.safe_touch, [
      {
        file: 'src/core/app.js',
        confidence: 90,
        reason: 'Matched context zone: Core',
      },
    ]);
    assert.deepStrictEqual(result.topology.reference_only, [
      {
        file: 'src/docs/reference.md',
        context_value: 'Use these docs for context only.',
      },
    ]);
    assert.deepStrictEqual(result.topology.do_not_touch, [
      {
        file: 'src/legacy/frozen.js',
        reason: 'Legacy branch is frozen.',
      },
    ]);

    fs.rmSync(repoRoot, { recursive: true });
  });
});

describe('bounds CLI', () => {
  test('emits valid JSON only on stdout', () => {
    const repoRoot = makeRepoRoot('cli');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Core',
            paths: ['src/**'],
            belief: 'Keep the core code path healthy.',
          },
        ],
      }, null, 2),
      'utf8'
    );

    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'bounds.js');
    const raw = run(`node "${scriptPath}" --feature "CLI Bounds" --files "src/index.js,src/index.js"`, repoRoot);
    const payload = JSON.parse(raw);

    assert.equal(payload.feature_target, 'CLI Bounds');
    assert.deepStrictEqual(payload.topology.safe_touch, [
      {
        file: 'src/index.js',
        confidence: 90,
        reason: 'Matched context zone: Core',
      },
    ]);

    const schema = readJson(path.join(__dirname, '..', 'schemas', 'sherlog.bounds-output.schema.json'));
    assert.equal(schema.title, 'Sherlog Bounds Output');
    fs.rmSync(repoRoot, { recursive: true });
  });
});
