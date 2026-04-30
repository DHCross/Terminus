const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// gap-detector only exports `detectGaps` — test its integration behavior
// by feeding it a minimal temp repo structure with a mock config.

const { detectGaps } = require('../src/core/gap-detector');
const { readJson } = require('../src/core/shared');

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

// ── Config & schema validation ──────────────────────────────────────

describe('gap-weights.json', () => {
  test('is valid JSON with expected keys', () => {
    const weights = readJson(path.join(__dirname, '..', 'config', 'gap-weights.json'));
    assert.ok(weights, 'gap-weights.json should be parseable');
    const table = weights.weights && typeof weights.weights === 'object' ? weights.weights : weights;
    const readWeight = value => (typeof value === 'number' ? value : Number(value?.weight));
    assert.ok(Number.isFinite(readWeight(table.missing_implementation)));
    assert.ok(Number.isFinite(readWeight(table.test_coverage)));
    assert.ok(Number.isFinite(readWeight(table.documentation)));
    assert.ok(Number.isFinite(readWeight(table.stale_context)));
  });

  test('all weights are positive numbers', () => {
    const weights = readJson(path.join(__dirname, '..', 'config', 'gap-weights.json'));
    const table = weights.weights && typeof weights.weights === 'object' ? weights.weights : weights;
    for (const [key, value] of Object.entries(table)) {
      if (key.startsWith('_')) continue;
      const numeric = typeof value === 'number' ? value : Number(value?.weight);
      assert.ok(Number.isFinite(numeric) && numeric > 0, `${key} should be a positive number, got ${value}`);
    }
  });
});

describe('sherlog.config.json', () => {
  test('is valid JSON with required fields', () => {
    const config = readJson(path.join(__dirname, '..', 'config', 'sherlog.config.json'));
    assert.ok(config, 'config should be parseable');
    assert.ok(config.version, 'version required');
    assert.ok(config.paths, 'paths required');
    assert.ok(Array.isArray(config.paths.source_roots), 'source_roots must be array');
  });
});

// ── Schema files ────────────────────────────────────────────────────

describe('schemas', () => {
  const schemasDir = path.join(__dirname, '..', 'schemas');

  test('context schema is valid JSON', () => {
    const schema = readJson(path.join(schemasDir, 'sherlog.context.schema.json'));
    assert.ok(schema, 'context schema should parse');
    assert.strictEqual(schema.type, 'object');
  });

  test('gaps-output schema is valid JSON', () => {
    const schema = readJson(path.join(schemasDir, 'sherlog.gaps-output.schema.json'));
    assert.ok(schema, 'gaps schema should parse');
  });

  test('doctor-output schema is valid JSON', () => {
    const schema = readJson(path.join(schemasDir, 'sherlog.doctor-output.schema.json'));
    assert.ok(schema, 'doctor schema should parse');
  });

  test('sonar-report schema is valid JSON', () => {
    const schema = readJson(path.join(schemasDir, 'sherlog.sonar-report.schema.json'));
    assert.ok(schema, 'sonar report schema should parse');
    assert.equal(schema.title, 'Sherlog Sonar Report');
  });
});

// ── detectGaps smoke test ───────────────────────────────────────────

describe('detectGaps', () => {
  test('returns gap results for a feature name', () => {
    // Uses the real repo root so git history is available
    const repoRoot = path.resolve(__dirname, '..', '..');
    const configPath = path.join(__dirname, '..', 'config', 'sherlog.config.json');
    const config = readJson(configPath);

    if (!config) {
      // Skip if config not found (e.g. in CI without full repo)
      return;
    }

    const result = detectGaps('Starter Kit', config);
    assert.ok(result, 'detectGaps should return a result');
    assert.ok(Array.isArray(result.gaps), 'result.gaps should be an array');
    assert.ok(result.evidence, 'result.evidence should exist');
    assert.ok(Array.isArray(result.evidence.tokens), 'tokens should be an array');
  });
});

function makeConfig(repoRoot, overrides = {}) {
  return {
    repo_root: repoRoot,
    bundler: { type: null, bundles: [] },
    context: { mode: 'none', map_file: path.join(repoRoot, 'sherlog.context.json') },
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
      context_map: path.join(repoRoot, 'sherlog.context.json'),
    },
    settings: {
      gap_scan_ignore_dirs: [],
    },
    ...overrides,
  };
}

describe('detectGaps advanced behavior', () => {
  test('maps hygiene findings into gaps and resolves legacy weight aliases', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-hygiene-alias-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'payments-engine.js'),
      [
        '// TODO: implement phase 1',
        '// FIXME: reconcile edge case',
        '// TODO: remove temporary fallback',
        'export const ok = true;',
      ].join('\n') + '\n',
      'utf8'
    );

    const gapWeightsPath = path.join(repoRoot, 'gap-weights.json');
    fs.writeFileSync(
      gapWeightsPath,
      JSON.stringify({
        incomplete_implementation: 17,
        unknown: 10,
      }, null, 2),
      'utf8'
    );

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
        context_map: path.join(repoRoot, 'sherlog.context.json'),
        gap_weights: gapWeightsPath,
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    const result = detectGaps('Payments', config, { record: false });
    assert.ok(result.gaps.includes('hygiene_todo_cluster'));

    const ranked = Array.isArray(result.salience?.ranked) ? result.salience.ranked : [];
    const hygieneGap = ranked.find(item => item.gap === 'hygiene_todo_cluster');
    assert.ok(hygieneGap, 'hygiene_todo_cluster should be present in salience ranking');
    assert.equal(hygieneGap.base_weight, 17);
  });

  test('treats date-only last_updated as day-granularity (no same-day stale false positive)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-stale-day-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-engine.js'), 'export const ok = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Core',
            paths: ['src/**'],
            last_updated: '2026-01-10',
          },
        ],
      }, null, 2),
      'utf8'
    );

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-10T23:00:00Z');

    const config = makeConfig(repoRoot, {
      context: { mode: 'sherlog-map', map_file: path.join(repoRoot, 'sherlog.context.json') },
    });

    const sameDay = detectGaps('Payments', config, { record: false });
    assert.equal(sameDay.evidence.context_map.stale_areas.length, 0);
    assert.ok(!sameDay.gaps.includes('stale_context'));

    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-engine.js'), 'export const ok = false;\n', 'utf8');
    commitAll(repoRoot, 'next-day-change', '2026-01-11T01:00:00Z');

    const nextDay = detectGaps('Payments', config, { record: false });
    assert.equal(nextDay.evidence.context_map.stale_areas.length, 1);
    assert.ok(nextDay.gaps.includes('stale_context'));
  });

  test('applies gap_scan_ignore_dirs entries as path prefixes (not only basenames)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-ignore-prefix-'));
    fs.mkdirSync(path.join(repoRoot, 'scratch', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'scratch', 'archive', 'alias-feature.js'), 'const x = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-12T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: { source_roots: ['.'], docs_dir: 'docs' },
      settings: { gap_scan_ignore_dirs: ['scratch/archive'] },
    });

    const result = detectGaps('Alias Feature', config, { record: false });
    assert.equal(result.evidence.feature_file_count, 0);
  });

  test('flags stale changelog coverage after implementation changes', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-changelog-stale-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n## [2026-01-01] - Seed\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-feature.js'), 'export const paymentsFeature = true;\n', 'utf8');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed changelog', '2026-01-01T10:00:00Z');

    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-feature.js'), 'export const paymentsFeature = false;\n', 'utf8');
    commitAll(repoRoot, 'change implementation only', '2026-01-02T10:00:00Z');

    const result = detectGaps('Payments Feature', makeConfig(repoRoot), { record: false });
    assert.ok(result.gaps.includes('changelog_stale_after_feature_change'));
    assert.ok(result.gaps.includes('changelog_update_missing'));
    assert.deepEqual(result.evidence.changelog.implementation_changes, ['src/payments-feature.js']);
    assert.equal(result.evidence.changelog.status, 'update_missing');
  });

  test('flags changelog scope mismatch when changelog updates land without supporting evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-changelog-mismatch-'));
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n## [2026-01-01] - Seed\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'note.md'), '# note\n', 'utf8');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed changelog', '2026-01-01T10:00:00Z');

    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n## [2026-01-02] - Docs only\n', 'utf8');
    commitAll(repoRoot, 'changelog only', '2026-01-02T10:00:00Z');

    const result = detectGaps('Docs only', makeConfig(repoRoot), { record: false });
    assert.ok(result.gaps.includes('changelog_scope_mismatch'));
    assert.deepEqual(result.evidence.changelog.last_update_supporting_files, []);
    assert.equal(result.evidence.changelog.status, 'scope_mismatch');
  });

  test('auto-ignores nested .claude/worktrees content', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-ignore-worktrees-'));
    fs.mkdirSync(path.join(repoRoot, '.claude', 'worktrees', 'Shipyard', 'archive'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, '.claude', 'worktrees', 'Shipyard', 'archive', 'robustness-feature.md'),
      '# note\n',
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-13T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: { source_roots: ['.'], docs_dir: 'docs' },
    });

    const result = detectGaps('Robustness Feature', config, { record: false });
    assert.equal(result.evidence.feature_file_count, 0);
  });

  test('emits uncovered-file notes and warning threshold when feature files are outside context map', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-context-warning-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-bridge.js'), 'export const z = 1;\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Narrow Zone',
            paths: ['src/covered/**'],
            last_updated: '2026-01-10T00:00:00Z',
          },
        ],
      }, null, 2),
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-14T10:00:00Z');

    const config = makeConfig(repoRoot, {
      context: { mode: 'sherlog-map', map_file: path.join(repoRoot, 'sherlog.context.json') },
      settings: {
        gap_scan_ignore_dirs: [],
        feature_files_outside_context_map_warning_threshold: 1,
      },
    });

    const result = detectGaps('Payments', config, { record: false });
    const notes = result.evidence.context_map.notes || [];
    const warnings = result.evidence.context_map.warnings || [];

    assert.ok(notes.some(note => note === 'feature_files_outside_context_map:src/payments-bridge.js'));
    assert.ok(notes.some(note => note.startsWith('warning_threshold_reached:feature_files_outside_context_map:')));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'feature_files_outside_context_map');
  });

  test('supports feature aliases and metadata tokens for implementation/test/doc probes', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-alias-meta-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'billing-engine.js'), 'export const billed = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'compliance.spec.js'), 'test("ok", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'audit-notes.md'), '# audit\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-15T10:00:00Z');

    const baseConfig = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
    });

    const withoutProbeHints = detectGaps('Invoice Settlement', baseConfig, { record: false });
    assert.equal(withoutProbeHints.evidence.has_implementation, false);
    assert.equal(withoutProbeHints.evidence.has_tests, false);
    assert.equal(withoutProbeHints.evidence.has_docs, false);

    const hintedConfig = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
        feature_aliases: {
          'invoice settlement': ['billing'],
        },
        feature_metadata: {
          'invoice settlement': {
            test_tokens: ['compliance'],
            doc_tokens: ['audit'],
          },
        },
      },
    });

    const withProbeHints = detectGaps('Invoice Settlement', hintedConfig, { record: false });
    assert.equal(withProbeHints.evidence.has_implementation, true);
    assert.equal(withProbeHints.evidence.has_tests, true);
    assert.equal(withProbeHints.evidence.has_docs, true);
  });

  test('honors configured test_roots instead of treating source roots as tests', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-test-roots-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'custom-tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'repo-customization.js'), 'export const ready = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, 'custom-tests', 'repo-customization.test.js'),
      'test("repo customization", () => {});\n',
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-15T12:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        test_roots: ['custom-tests'],
        docs_dir: 'docs',
      },
    });

    const result = detectGaps('Repo customization', config, { record: false });
    assert.equal(result.evidence.has_implementation, true);
    assert.equal(result.evidence.has_tests, true);
    assert.deepEqual(result.evidence.test_roots, ['custom-tests']);
  });

  test('resolves feature profiles before scanning and exposes intent evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-feature-profile-'));
    fs.mkdirSync(path.join(repoRoot, 'src', 'billing'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'billing', 'settlement-engine.js'),
      [
        'export function createSettlement() {',
        '  return "ok";',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'billing', 'settlement-callsite.js'),
      [
        'import { createSettlement } from "./settlement-engine.js";',
        'export const run = () => createSettlement();',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoRoot, 'tests', 'settlement.spec.js'), 'test("settlement", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'settlement.md'), '# settlement\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
        feature_profiles: {
          'invoice-safety-net': {
            aliases: ['Invoice Settlement'],
            implementation_tokens: ['settlement'],
            test_tokens: ['settlement'],
            doc_tokens: ['settlement'],
            export_hints: ['createSettlement'],
            callsite_hints: ['createSettlement'],
            implementation_path_hints: ['src/billing/**'],
            test_path_hints: ['tests/**'],
            doc_path_hints: ['docs/**'],
          },
        },
      },
    });

    const result = detectGaps('Invoice Settlement', config, { record: false });
    assert.equal(result.evidence.intent.profile_key, 'invoice-safety-net');
    assert.equal(result.evidence.intent.profile_source, 'feature-alias');
    assert.equal(result.evidence.has_implementation, true);
    assert.equal(result.evidence.convergence.signals.implementation.meets, true);
  });

  test('treats vessel-prefixed context paths and repo-relative feature paths as the same scope', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-vessel-context-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'raven-export.js'),
      [
        'export function exportRavenFallback() {',
        '  return "ok";',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.context.json'),
      JSON.stringify({
        zones: [
          {
            name: 'Raven Export',
            paths: ['vessel/src/**'],
            belief: 'Legacy path prefix should still map to the repo root.',
            last_updated: '2026-01-16',
          },
        ],
      }, null, 2),
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      context: { mode: 'sherlog-map', map_file: path.join(repoRoot, 'sherlog.context.json') },
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
        context_map: path.join(repoRoot, 'sherlog.context.json'),
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    const result = detectGaps('Raven Export', config, { record: false });
    assert.deepStrictEqual(result.evidence.context_map.uncovered_feature_files, []);
    assert.ok(result.evidence.context_map.covered_feature_files.includes('src/raven-export.js'));
  });

  test('loads feature profiles from sherlog.feature-profiles.json', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-feature-profiles-file-'));
    fs.mkdirSync(path.join(repoRoot, 'src', 'raven'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'raven', 'fallback-export.js'),
      [
        'export function exportRavenFallback() {',
        '  return "ok";',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'raven', 'consumer.js'),
      'import { exportRavenFallback } from "./fallback-export.js";\nexport const run = () => exportRavenFallback();\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoRoot, 'tests', 'raven.spec.js'), 'test("raven", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'raven.md'), '# raven\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.feature-profiles.json'),
      JSON.stringify({
        feature_profiles: {
          'raven-fallback-export-reliability': {
            aliases: ['Raven Fallback and Export Reliability'],
            implementation_path_hints: ['src/raven/**'],
            test_path_hints: ['tests/**'],
            doc_path_hints: ['docs/**'],
            export_hints: ['exportRavenFallback'],
            callsite_hints: ['exportRavenFallback'],
          },
        },
      }, null, 2),
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    const result = detectGaps('Raven Fallback and Export Reliability', config, { record: false });
    assert.equal(result.evidence.intent.profile_key, 'raven-fallback-export-reliability');
    assert.notEqual(result.evidence.intent.profile_source, 'none');
    assert.equal(result.evidence.has_implementation, true);
    assert.equal(result.evidence.convergence.signals.implementation.meets, true);
  });

  test('loads bounded scope mode from feature profiles', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-feature-profile-scope-'));
    fs.mkdirSync(path.join(repoRoot, 'src', 'raven'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'raven', 'full-read.js'), 'export const fullRead = () => "ok";\n', 'utf8');
    fs.writeFileSync(
      path.join(repoRoot, 'sherlog.feature-profiles.json'),
      JSON.stringify({
        feature_profiles: {
          'raven-scaffolded-full-read': {
            aliases: ['Raven Scaffolded Full Read'],
            scope_mode: 'bounded',
            implementation_path_hints: ['src/raven/**'],
          },
        },
      }, null, 2),
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    const result = detectGaps('Raven Scaffolded Full Read', config, { record: false });
    assert.equal(result.evidence.intent.profile_key, 'raven-scaffolded-full-read');
    assert.equal(result.evidence.probe_scope.mode, 'bounded');
    assert.equal(result.evidence.scope.enforced, true);
  });

  test('bounded scope ignores out-of-scope matches and reports spillover', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-bounded-scope-'));
    fs.mkdirSync(path.join(repoRoot, 'src', 'billing'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests', 'billing'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'billing', 'settlement-engine.js'),
      'export function createSettlement() {\n  return "ok";\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'shared', 'settlement-engine.js'),
      'export function createSettlement() {\n  return "wrong seam";\n}\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'tests', 'billing', 'settlement.spec.js'),
      'test("settlement", () => {});\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoRoot, 'docs', 'settlement.md'), '# settlement\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-16T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        test_roots: ['tests'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
        feature_profiles: {
          'invoice-safety-net': {
            aliases: ['Invoice Settlement'],
            scope_mode: 'bounded',
            implementation_tokens: ['settlement'],
            test_tokens: ['settlement'],
            doc_tokens: ['settlement'],
            export_hints: ['createSettlement'],
            callsite_hints: ['createSettlement'],
            implementation_path_hints: ['src/billing/**'],
            test_path_hints: ['tests/billing/**'],
            doc_path_hints: ['docs/**'],
          },
        },
      },
    });

    const result = detectGaps('Invoice Settlement', config, { record: false });
    assert.equal(result.evidence.intent.profile_key, 'invoice-safety-net');
    assert.deepEqual(result.evidence.feature_files_strict, ['src/billing/settlement-engine.js']);
    assert.equal(result.evidence.scope.enforced, true);
    assert.deepEqual(result.evidence.scope.ignored_out_of_scope.feature, ['src/shared/settlement-engine.js']);
    assert.deepEqual(result.evidence.scope.ignored_out_of_scope.implementation, ['src/shared/settlement-engine.js']);
    assert.equal(result.evidence.convergence.signals.implementation.meets, true);
  });

  test('treats relaxed legacy lanes as weak evidence instead of strict implementation', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-lane-relaxed-'));
    fs.mkdirSync(path.join(repoRoot, 'legacy'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'legacy', 'payments-engine.js'),
      [
        'export function runPayments() {',
        '  return "legacy";',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-17T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src', 'legacy'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
        path_lanes_default: 'core',
        path_lanes: [
          { name: 'core', mode: 'strict', include: [] },
          { name: 'legacy', mode: 'relaxed', include: ['legacy/**'] },
        ],
      },
    });

    const result = detectGaps('Payments', config, { record: false });
    assert.equal(result.evidence.has_implementation, false);
    assert.ok(result.evidence.convergence.signals.implementation.components.path.by_mode.relaxed > 0);
    assert.equal(result.evidence.feature_file_count, 0);
    assert.ok(result.evidence.feature_file_count_relaxed > 0);
  });

  test('tracks convergence delta between recorded runs', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-convergence-delta-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-engine.js'), 'const value = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-18T10:00:00Z');

    const historyPath = path.join(repoRoot, 'gap-history.jsonl');
    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
        gap_history_log: historyPath,
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    const first = detectGaps('Payments Engine', config, { record: true });
    assert.equal(first.salience.summary.convergence_trend, 'new');

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'payments-engine.js'),
      [
        'export function runPayments() {',
        '  return 1;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'payments-callsite.js'),
      'import { runPayments } from "./payments-engine.js";\nexport const result = runPayments();\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoRoot, 'tests', 'payments.spec.js'), 'test("payments", () => expect(true).toBe(true));\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'docs', 'payments.md'), '# payments engine\n', 'utf8');
    commitAll(repoRoot, 'improve signals', '2026-01-19T10:00:00Z');

    const second = detectGaps('Payments Engine', config, { record: true });
    assert.ok(Number.isFinite(second.salience.summary.convergence_score));
    assert.ok(Number.isFinite(second.salience.summary.previous_convergence_score));
    assert.ok(second.salience.summary.convergence_delta > 0);
    assert.equal(second.salience.summary.convergence_trend, 'improving');
    assert.equal(second.salience.summary.convergence_entropy_trend, 'improving');
  });

  test('stays read-only unless history or self-model persistence is requested', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-gap-readonly-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-engine.js'), 'export const value = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-18T10:00:00Z');

    const historyPath = path.join(repoRoot, 'gap-history.jsonl');
    const selfModelPath = path.join(repoRoot, 'sherlog-velocity', 'data', 'self-model.json');
    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
        gap_history_log: historyPath,
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    });

    detectGaps('Payments Engine', config, { record: false, persistSelfModel: false });
    assert.equal(fs.existsSync(historyPath), false);
    assert.equal(fs.existsSync(selfModelPath), false);

    detectGaps('Payments Engine', config, { record: true, persistSelfModel: true });
    assert.equal(fs.existsSync(historyPath), true);
    assert.equal(fs.existsSync(selfModelPath), true);
  });

  test('maps hygiene nesting depth findings to arch_complexity_hotspot', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-nesting-gap-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments-flow.js'), [
      'export function settle(tx) {',
      '  if (tx) {',
      '    for (const item of tx.items || []) {',
      '      while (item.pending) {',
      '        try {',
      '          if (item.retryable) {',
      '            if (item.needsAudit) {',
      '              process(item);',
      '            }',
      '          }',
      '        } catch (e) {',
      '          handle(e);',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n') + '\n', 'utf8');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-20T10:00:00Z');

    const config = makeConfig(repoRoot, {
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
    });

    const result = detectGaps('Payments', config, { record: false });
    assert.ok(result.gaps.includes('arch_complexity_hotspot'));
  });

  test('suppresses dead scaffold noise while escalating stale live code rot', () => {
    const activeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-live-rot-'));
    fs.mkdirSync(path.join(activeRepo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(activeRepo, 'src', 'payments-engine.js'),
      [
        'export function runPayments() { return 1; }',
        'export function settlePayments() { return 2; }',
        'export function refundPayments() { return 3; }',
        'export function auditPayments() { return 4; }',
        'export function listPayments() { return 5; }',
        'export function archivePayments() { return 6; }',
        'export function verifyPayments() { return 7; }',
        'export function authorizePayments() { return 8; }',
        'export function syncPayments() { return 9; }',
        'export function hydratePayments() { return 10; }',
        'export function closePayments() { return 11; }',
        'export function reopenPayments() { return 12; }',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(activeRepo, 'src', 'payments-page.js'),
      'import { runPayments } from "./payments-engine.js";\nexport const page = () => runPayments();\n',
      'utf8'
    );
    initGitRepo(activeRepo);
    commitAll(activeRepo, 'seed', '2026-01-01T10:00:00Z');

    const deadRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-dead-scaffold-'));
    fs.mkdirSync(path.join(deadRepo, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(deadRepo, 'src', 'payments-scaffold.js'),
      [
        '// TODO: implement payments service',
        'export function runPayments() {',
        '  return null;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    initGitRepo(deadRepo);
    commitAll(deadRepo, 'seed', '2026-01-01T10:00:00Z');

    const activeResult = detectGaps('Payments', makeConfig(activeRepo), { record: false });
    const deadResult = detectGaps('Payments', makeConfig(deadRepo), { record: false });
    const activeGap = activeResult.salience.ranked.find(item => item.gap === 'test_coverage');
    const deadGap = deadResult.salience.ranked.find(item => item.gap === 'test_coverage');

    assert.ok(activeGap);
    assert.ok(deadGap);
    assert.ok(Number(activeGap.code_rot_multiplier || 1) > 1);
    assert.ok(Number(deadGap.noise_multiplier || 1) < 1);
    assert.ok(Number(activeGap.score || 0) > Number(deadGap.score || 0));
    assert.equal(activeResult.evidence.code_index.feature_risk.summary.dead_or_scaffold_files, 0);
    assert.equal(deadResult.evidence.code_index.feature_risk.summary.dead_or_scaffold_files, 1);
  });
});
