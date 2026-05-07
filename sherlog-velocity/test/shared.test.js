const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  readJson,
  readJsonLines,
  ensureDir,
  ensureFile,
  rolling,
  confidenceFromSample,
  findRuntimeConfigPath,
  repoRelativePathVariants,
  resolveRepoRoot,
  resolveSherlogStateRoot,
  resolveRuntimeConfig,
  toPortableConfig,
} = require('../src/core/shared');

// ── readJson ────────────────────────────────────────────────────────

describe('readJson', () => {
  test('parses valid JSON file', () => {
    const tmp = path.join(os.tmpdir(), `sherlog-test-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ hello: 'world' }));
    const result = readJson(tmp);
    assert.deepStrictEqual(result, { hello: 'world' });
    fs.unlinkSync(tmp);
  });

  test('returns fallback for missing file', () => {
    const result = readJson('/nonexistent/path.json', { default: true });
    assert.deepStrictEqual(result, { default: true });
  });

  test('returns fallback for malformed JSON', () => {
    const tmp = path.join(os.tmpdir(), `sherlog-test-${Date.now()}.json`);
    fs.writeFileSync(tmp, 'not json {{{');
    const result = readJson(tmp, null);
    assert.strictEqual(result, null);
    fs.unlinkSync(tmp);
  });
});

// ── readJsonLines ───────────────────────────────────────────────────

describe('readJsonLines', () => {
  test('parses JSONL file', () => {
    const tmp = path.join(os.tmpdir(), `sherlog-test-${Date.now()}.jsonl`);
    fs.writeFileSync(tmp, '{"a":1}\n{"b":2}\n');
    const result = readJsonLines(tmp);
    assert.deepStrictEqual(result, [{ a: 1 }, { b: 2 }]);
    fs.unlinkSync(tmp);
  });

  test('returns empty array for missing file', () => {
    const result = readJsonLines('/nonexistent/path.jsonl');
    assert.deepStrictEqual(result, []);
  });

  test('skips malformed lines', () => {
    const tmp = path.join(os.tmpdir(), `sherlog-test-${Date.now()}.jsonl`);
    fs.writeFileSync(tmp, '{"ok":true}\nnot json\n{"also":"ok"}\n');
    const result = readJsonLines(tmp);
    assert.deepStrictEqual(result, [{ ok: true }, { also: 'ok' }]);
    fs.unlinkSync(tmp);
  });
});

// ── ensureDir / ensureFile ──────────────────────────────────────────

describe('ensureDir', () => {
  test('creates nested directory', () => {
    const tmp = path.join(os.tmpdir(), `sherlog-test-${Date.now()}`, 'a', 'b');
    ensureDir(tmp);
    assert.ok(fs.existsSync(tmp));
    fs.rmSync(path.join(os.tmpdir(), path.basename(path.dirname(path.dirname(tmp)))), { recursive: true });
  });
});

describe('ensureFile', () => {
  test('creates file with default content', () => {
    const dir = path.join(os.tmpdir(), `sherlog-test-${Date.now()}`);
    const file = path.join(dir, 'test.txt');
    ensureFile(file, 'hello');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello');
    fs.rmSync(dir, { recursive: true });
  });

  test('does not overwrite existing file', () => {
    const dir = path.join(os.tmpdir(), `sherlog-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'test.txt');
    fs.writeFileSync(file, 'original');
    ensureFile(file, 'overwrite attempt');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'original');
    fs.rmSync(dir, { recursive: true });
  });
});

// ── rolling ─────────────────────────────────────────────────────────

describe('rolling', () => {
  test('aggregates velocity entries', () => {
    const entries = [
      { total_commits: 5, total_duration_seconds: 3600, window_days: 7 },
      { total_commits: 3, total_duration_seconds: 1800, window_days: 7 },
    ];
    const result = rolling(entries);
    assert.strictEqual(result.commits, 8);
    assert.strictEqual(result.seconds, 5400);
    assert.strictEqual(result.days, 14);
    assert.strictEqual(result.sample, 2);
  });

  test('returns null for empty entries', () => {
    assert.strictEqual(rolling([]), null);
  });

  test('respects limit parameter', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      total_commits: 1,
      total_duration_seconds: 100,
      window_days: 1,
    }));
    const result = rolling(entries, 5);
    assert.strictEqual(result.sample, 5);
    assert.strictEqual(result.commits, 5);
  });
});

// ── confidenceFromSample ────────────────────────────────────────────

describe('confidenceFromSample', () => {
  test('returns high for >= 5 samples', () => {
    assert.strictEqual(confidenceFromSample(5), 'high');
    assert.strictEqual(confidenceFromSample(100), 'high');
  });

  test('returns medium for 3-4 samples', () => {
    assert.strictEqual(confidenceFromSample(3), 'medium');
    assert.strictEqual(confidenceFromSample(4), 'medium');
  });

  test('returns low for < 3 samples', () => {
    assert.strictEqual(confidenceFromSample(0), 'low');
    assert.strictEqual(confidenceFromSample(2), 'low');
  });
});

describe('resolveRepoRoot', () => {
  test('falls back to the runtime cwd when configured root is dead', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-root-fallback-'));
    const resolved = resolveRepoRoot('/definitely/not/a/real/sherlog/root', repoRoot);
    assert.strictEqual(resolved, repoRoot);
    fs.rmSync(repoRoot, { recursive: true });
  });
});

describe('repoRelativePathVariants', () => {
  test('normalizes legacy vessel-prefixed paths to the same repo-relative variants', () => {
    assert.deepStrictEqual(
      repoRelativePathVariants('vessel/src/raven/export.ts'),
      ['vessel/src/raven/export.ts', 'src/raven/export.ts']
    );
    assert.deepStrictEqual(
      repoRelativePathVariants('src/raven/export.ts'),
      ['src/raven/export.ts', 'vessel/src/raven/export.ts']
    );
  });
});

describe('resolveRuntimeConfig', () => {
  test('resolves relative config paths against the fallback repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-runtime-config-'));
    const resolved = resolveRuntimeConfig({
      repo_root: '/dead/absolute/root',
      context: {
        map_file: 'sherlog.context.json',
      },
      paths: {
        velocity_log: 'sherlog-velocity/data/velocity-log.jsonl',
        gap_acknowledgements: 'sherlog.acknowledgements.json',
      },
    }, { cwd: repoRoot });

    assert.strictEqual(resolved.repo_root, repoRoot);
    assert.strictEqual(resolved.context.map_file, path.join(repoRoot, 'sherlog.context.json'));
    assert.strictEqual(
      resolved.paths.velocity_log,
      path.join(repoRoot, 'sherlog-velocity/data/velocity-log.jsonl')
    );
    assert.strictEqual(
      resolved.paths.gap_acknowledgements,
      path.join(repoRoot, 'sherlog.acknowledgements.json')
    );
    fs.rmSync(repoRoot, { recursive: true });
  });
});

describe('runtime layout', () => {
  test('resolves repo-local sherlog state for installed-package mode', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-runtime-layout-'));
    const packageRoot = path.join(os.tmpdir(), `sherlog-package-${Date.now()}`);
    fs.mkdirSync(path.join(repoRoot, 'sherlog-velocity', 'config'), { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    const expectedConfig = path.join(repoRoot, 'sherlog-velocity', 'config', 'sherlog.config.json');
    fs.writeFileSync(expectedConfig, JSON.stringify({ repo_root: '.' }), 'utf8');

    const stateRoot = resolveSherlogStateRoot(repoRoot, { packageRoot });
    const runtime = findRuntimeConfigPath({ cwd: repoRoot, packageRoot });

    assert.strictEqual(stateRoot, path.join(repoRoot, 'sherlog-velocity'));
    assert.strictEqual(runtime.configPath, expectedConfig);
    assert.equal(runtime.installedPackageMode, true);

    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  });
});

describe('toPortableConfig', () => {
  test('serializes repo-rooted absolute paths back to relative config values', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-portable-config-'));
    const portable = toPortableConfig({
      repo_root: repoRoot,
      context: {
        map_file: path.join(repoRoot, 'sherlog.context.json'),
      },
      paths: {
        velocity_log: path.join(repoRoot, 'sherlog-velocity/data/velocity-log.jsonl'),
        source_roots: [path.join(repoRoot, 'src')],
      },
    }, repoRoot);

    assert.strictEqual(portable.repo_root, '.');
    assert.strictEqual(portable.context.map_file, 'sherlog.context.json');
    assert.strictEqual(portable.paths.velocity_log, 'sherlog-velocity/data/velocity-log.jsonl');
    assert.deepStrictEqual(portable.paths.source_roots, ['src']);
    fs.rmSync(repoRoot, { recursive: true });
  });
});
