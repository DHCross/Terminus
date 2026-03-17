const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { scanHygiene, computeTrends, suggestTuning } = require('../src/core/hygiene');
const { readJsonLines } = require('../src/core/shared');

function makeConfig(repoRoot, overrides = {}) {
  const historyPath = path.join(repoRoot, 'hygiene-history.jsonl');
  return {
    repo_root: repoRoot,
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
      hygiene_history_log: historyPath,
      ...overrides.paths,
    },
    settings: {
      gap_scan_ignore_dirs: [],
      hygiene: {},
      ...overrides.settings,
    },
    ...overrides,
    // Re-apply nested overrides that spread above would clobber
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
      hygiene_history_log: historyPath,
      ...(overrides.paths || {}),
    },
    settings: {
      gap_scan_ignore_dirs: [],
      hygiene: {},
      ...(overrides.settings || {}),
    },
  };
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-hygiene-${label}-`));
}

function seedHistory(historyPath, entries) {
  fs.writeFileSync(historyPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function makeHistoryEntry(byType, scannedFiles = 10) {
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  return {
    timestamp: new Date().toISOString(),
    summary: { total_findings: total, by_type: byType, scanned_files: scannedFiles },
    thresholds: { todo_cluster_threshold: 3, console_log_max: 0, any_usage_threshold: 5, monolith_line_threshold: 500, monolith_size_kb_threshold: 150, missing_docs_line_threshold: 100 },
    gaps: [],
  };
}

// ── TODO/FIXME cluster detection ─────────────────────────────────────

describe('todo_cluster', () => {
  test('flags file with TODO count at or above threshold', () => {
    const root = tmpDir('todo-above');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'messy.js'), [
      '// TODO: fix this',
      'const a = 1;',
      '// FIXME: broken',
      '/* TODO: refactor */',
      '// HACK: workaround',
      '// TODO: later',
      'module.exports = a;',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const todos = result.findings.filter(f => f.type === 'todo_cluster');
    assert.equal(todos.length, 1);
    assert.equal(todos[0].count, 5);
    assert.ok(result.gaps.includes('incomplete_implementation'));
  });

  test('does not flag file below threshold', () => {
    const root = tmpDir('todo-below');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'ok.js'), [
      '// TODO: minor',
      'const a = 1;',
      '// FIXME: small',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const todos = result.findings.filter(f => f.type === 'todo_cluster');
    assert.equal(todos.length, 0);
  });

  test('only counts TODOs in comment lines', () => {
    const root = tmpDir('todo-comments');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'mixed.js'), [
      'const msg = "TODO: this is a string, not a comment";',
      'const other = "FIXME in string";',
      'const code = "HACK value";',
      '// TODO: real comment',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const todos = result.findings.filter(f => f.type === 'todo_cluster');
    assert.equal(todos.length, 0);
  });
});

// ── console.log detection ────────────────────────────────────────────

describe('console_log', () => {
  test('flags console.log in source directory', () => {
    const root = tmpDir('console-src');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'debug.js'), [
      'function run() {',
      '  console.log("debug");',
      '  console.log("more debug");',
      '  return true;',
      '}',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const logs = result.findings.filter(f => f.type === 'console_log');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].count, 2);
    assert.ok(result.gaps.includes('debug_artifacts'));
  });

  test('does not flag console.log in test directory', () => {
    const root = tmpDir('console-test');
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'helper.js'), [
      'console.log("test output");',
      'console.log("more test output");',
    ].join('\n'), 'utf8');

    const config = makeConfig(root, { paths: { source_roots: ['.'], docs_dir: 'docs' } });
    const result = scanHygiene(config, { record: false });
    const logs = result.findings.filter(f => f.type === 'console_log');
    assert.equal(logs.length, 0);
  });
});

// ── excessive any ────────────────────────────────────────────────────

describe('excessive_any', () => {
  test('flags excessive any in TypeScript files', () => {
    const root = tmpDir('any-ts');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'loose.ts'), [
      'const a: any = 1;',
      'const b: any = "str";',
      'function foo(x: any): any {',
      '  return x as any;',
      '}',
      'const c: any[] = [];',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const anys = result.findings.filter(f => f.type === 'excessive_any');
    assert.equal(anys.length, 1);
    assert.ok(anys[0].count >= 5);
    assert.ok(result.gaps.includes('type_safety_risk'));
  });

  test('does not flag any in .js files', () => {
    const root = tmpDir('any-js');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'normal.js'), [
      'const a = "any value";',
      'const b = "any other";',
      'const c = "any more";',
      'const d = "any thing";',
      'const e = "any way";',
      'const f = "any how";',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const anys = result.findings.filter(f => f.type === 'excessive_any');
    assert.equal(anys.length, 0);
  });

  test('tracks suppressed any separately and does not use it as primary risk', () => {
    const root = tmpDir('any-eslint');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'suppressed.ts'), [
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'const a: any = 1;',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'const b: any = 2;',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'const c: any = 3;',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'const d: any = 4;',
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
      'const e: any = 5;',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const anys = result.findings.filter(f => f.type === 'excessive_any');
    assert.equal(anys.length, 0);
  });

  test('reports unsuppressed threshold crossings with suppressed split metadata', () => {
    const root = tmpDir('any-mixed-suppression');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'mixed.ts'), [
      'const a: any = 1;',
      'const b: any = 2;',
      'const c: any = 3;',
      'const d: any = 4;',
      'const e: any = 5;',
      '// @ts-expect-error intentional',
      'const f: any = 6;',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const anys = result.findings.filter(f => f.type === 'excessive_any');
    assert.equal(anys.length, 1);
    assert.equal(anys[0].count, 5);
    assert.equal(anys[0].total_count, 6);
    assert.equal(anys[0].suppressed_count, 1);
  });
});

// ── monolith detection ───────────────────────────────────────────────

describe('monolith', () => {
  test('flags file exceeding line threshold', () => {
    const root = tmpDir('mono-lines');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const bigContent = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'src', 'huge.js'), bigContent, 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const monos = result.findings.filter(f => f.type === 'monolith');
    assert.equal(monos.length, 1);
    assert.equal(monos[0].lines, 600);
    assert.ok(result.gaps.includes('architectural_limit_exceeded'));
  });

  test('does not flag file below line threshold', () => {
    const root = tmpDir('mono-small');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'small.js'), 'const a = 1;\n', 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const monos = result.findings.filter(f => f.type === 'monolith');
    assert.equal(monos.length, 0);
  });

  test('flags file exceeding size threshold', () => {
    const root = tmpDir('mono-size');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const bigContent = 'x'.repeat(160 * 1024);
    fs.writeFileSync(path.join(root, 'src', 'blob.js'), bigContent, 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const sizeFindings = result.findings.filter(f => f.type === 'monolith_size');
    assert.equal(sizeFindings.length, 1);
    assert.ok(sizeFindings[0].size_kb >= 150);
  });
});

// ── nesting depth hotspot detection ─────────────────────────────────

describe('nesting_depth', () => {
  test('flags file with brace nesting beyond threshold', () => {
    const root = tmpDir('nesting-hotspot');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'dense.js'), [
      'function run(input) {',
      '  if (input) {',
      '    for (const item of input) {',
      '      while (item.active) {',
      '        try {',
      '          if (item.deep) {',
      '            doWork(item);',
      '          }',
      '        } catch (err) {',
      '          handle(err);',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const findings = result.findings.filter(f => f.type === 'nesting_depth');
    assert.equal(findings.length, 1);
    assert.ok(findings[0].depth > findings[0].threshold);
    assert.ok(result.gaps.includes('architectural_limit_exceeded'));
  });

  test('does not flag nested braces inside strings/comments', () => {
    const root = tmpDir('nesting-noise');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'strings.js'), [
      'function run() {',
      '  const json = "{ \\\"a\\\": { \\\"b\\\": 1 } }";',
      '  // { { { comment braces should be ignored } } }',
      '  return json;',
      '}',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const findings = result.findings.filter(f => f.type === 'nesting_depth');
    assert.equal(findings.length, 0);
  });

  test('does not use suppressed blocks as primary nesting-depth risk', () => {
    const root = tmpDir('nesting-suppressed');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'suppressed-nesting.js'), [
      '// eslint-disable-next-line complexity',
      'function deep(input) {',
      '  if (input) {',
      '    if (input.a) {',
      '      if (input.b) {',
      '        if (input.c) {',
      '          if (input.d) {',
      '            return true;',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return false;',
      '}',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const findings = result.findings.filter(f => f.type === 'nesting_depth');
    assert.equal(findings.length, 0);
  });
});

// ── missing docs ─────────────────────────────────────────────────────

describe('missing_docs', () => {
  test('flags large source file with no corresponding doc', () => {
    const root = tmpDir('docs-missing');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const bigContent = Array.from({ length: 150 }, (_, i) => `const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'src', 'important.js'), bigContent, 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const docs = result.findings.filter(f => f.type === 'missing_docs');
    assert.equal(docs.length, 1);
    assert.ok(docs[0].file.includes('important'));
    assert.ok(result.gaps.includes('undocumented_module'));
  });

  test('does not flag small file', () => {
    const root = tmpDir('docs-small');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'tiny.js'), 'const a = 1;\n', 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const docs = result.findings.filter(f => f.type === 'missing_docs');
    assert.equal(docs.length, 0);
  });

  test('does not flag file when matching doc exists', () => {
    const root = tmpDir('docs-present');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const bigContent = Array.from({ length: 150 }, (_, i) => `const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'src', 'engine.js'), bigContent, 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'engine.md'), '# Engine docs\n', 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    const docs = result.findings.filter(f => f.type === 'missing_docs');
    assert.equal(docs.length, 0);
  });
});

// ── type filter ──────────────────────────────────────────────────────

describe('type filter', () => {
  test('filters findings to specified types only', () => {
    const root = tmpDir('filter');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const lines = Array.from({ length: 600 }, (_, i) => `const line${i} = ${i};`);
    lines[0] = 'console.log("debug");';
    fs.writeFileSync(path.join(root, 'src', 'big.js'), lines.join('\n'), 'utf8');

    const allResult = scanHygiene(makeConfig(root), { record: false });
    assert.ok(allResult.findings.some(f => f.type === 'monolith'));
    assert.ok(allResult.findings.some(f => f.type === 'console_log'));

    const filtered = scanHygiene(makeConfig(root), { types: ['monolith'], record: false });
    assert.ok(filtered.findings.every(f => f.type === 'monolith'));
    assert.ok(!filtered.findings.some(f => f.type === 'console_log'));
  });
});

// ── custom thresholds ────────────────────────────────────────────────

describe('custom thresholds', () => {
  test('respects overridden thresholds from config', () => {
    const root = tmpDir('thresh');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'todos.js'), [
      '// TODO: one',
      '// TODO: two',
      '// TODO: three',
      '// TODO: four',
      '// TODO: five',
    ].join('\n'), 'utf8');

    const defaultResult = scanHygiene(makeConfig(root), { record: false });
    assert.equal(defaultResult.findings.filter(f => f.type === 'todo_cluster').length, 1);

    const highThresh = makeConfig(root, {
      settings: { hygiene: { todo_cluster_threshold: 10 } },
    });
    const raisedResult = scanHygiene(highThresh, { record: false });
    assert.equal(raisedResult.findings.filter(f => f.type === 'todo_cluster').length, 0);
  });
});

// ── ignored dirs ─────────────────────────────────────────────────────

describe('ignored directories', () => {
  test('does not scan files in ignored directories', () => {
    const root = tmpDir('ignored');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), [
      '// TODO: 1',
      '// TODO: 2',
      '// TODO: 3',
      '// TODO: 4',
      'console.log("leftover");',
    ].join('\n'), 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    assert.equal(result.findings.length, 0);
    assert.equal(result.summary.scanned_files, 0);
  });
});

// ── summary structure ────────────────────────────────────────────────

describe('summary structure', () => {
  test('returns correct summary shape including trends and tuning', () => {
    const root = tmpDir('shape');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'empty.js'), 'const a = 1;\n', 'utf8');

    const result = scanHygiene(makeConfig(root), { record: false });
    assert.ok(Array.isArray(result.findings));
    assert.ok(typeof result.summary === 'object');
    assert.ok(typeof result.summary.total_findings === 'number');
    assert.ok(typeof result.summary.by_type === 'object');
    assert.ok(typeof result.summary.scanned_files === 'number');
    assert.ok(Array.isArray(result.gaps));
    assert.ok(typeof result.trends === 'object');
    assert.ok(Array.isArray(result.tuning));
  });
});

// ── History recording ────────────────────────────────────────────────

describe('history recording', () => {
  test('records scan to history when record is true', () => {
    const root = tmpDir('record-on');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("x");\n', 'utf8');

    const config = makeConfig(root);
    const historyPath = config.paths.hygiene_history_log;

    scanHygiene(config, { record: true });

    assert.ok(fs.existsSync(historyPath), 'history file should exist');
    const lines = readJsonLines(historyPath);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].timestamp);
    assert.ok(lines[0].summary);
    assert.ok(lines[0].thresholds);
  });

  test('does not record when record is false', () => {
    const root = tmpDir('record-off');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("x");\n', 'utf8');

    const config = makeConfig(root);
    const historyPath = config.paths.hygiene_history_log;

    scanHygiene(config, { record: false });

    assert.ok(!fs.existsSync(historyPath), 'history file should not exist');
  });

  test('appends multiple entries across runs', () => {
    const root = tmpDir('record-multi');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const x = 1;\n', 'utf8');

    const config = makeConfig(root);

    scanHygiene(config, { record: true });
    scanHygiene(config, { record: true });
    scanHygiene(config, { record: true });

    const lines = readJsonLines(config.paths.hygiene_history_log);
    assert.equal(lines.length, 3);
  });
});

// ── Trend computation ────────────────────────────────────────────────

describe('trend computation', () => {
  test('returns insufficient_data with fewer than 2 history entries', () => {
    const result = computeTrends([makeHistoryEntry({})], { console_log: 1 });
    assert.equal(result.overall, 'insufficient_data');
    assert.equal(result.runs, 1);
  });

  test('detects stable trend when counts stay the same', () => {
    const history = [
      makeHistoryEntry({ console_log: 2 }),
      makeHistoryEntry({ console_log: 2 }),
      makeHistoryEntry({ console_log: 2 }),
    ];
    const result = computeTrends(history, { console_log: 2 });
    assert.equal(result.overall, 'stable');
    assert.equal(result.by_type.console_log.trend, 'stable');
    assert.equal(result.by_type.console_log.delta, 0);
  });

  test('detects worsening when current exceeds average by >20%', () => {
    const history = [
      makeHistoryEntry({ console_log: 2 }),
      makeHistoryEntry({ console_log: 2 }),
      makeHistoryEntry({ console_log: 2 }),
    ];
    // avg = 2, current = 5 → 5 > 2*1.2 = 2.4 → worsening
    const result = computeTrends(history, { console_log: 5 });
    assert.equal(result.by_type.console_log.trend, 'worsening');
    assert.equal(result.overall, 'worsening');
  });

  test('detects improving when current is below average by >20%', () => {
    const history = [
      makeHistoryEntry({ console_log: 10 }),
      makeHistoryEntry({ console_log: 10 }),
      makeHistoryEntry({ console_log: 10 }),
    ];
    // avg = 10, current = 2 → 2 < 10*0.8 = 8 → improving
    const result = computeTrends(history, { console_log: 2 });
    assert.equal(result.by_type.console_log.trend, 'improving');
    assert.equal(result.overall, 'improving');
  });

  test('computes delta from previous entry', () => {
    const history = [
      makeHistoryEntry({ todo_cluster: 3 }),
      makeHistoryEntry({ todo_cluster: 5 }),
    ];
    const result = computeTrends(history, { todo_cluster: 7 });
    assert.equal(result.by_type.todo_cluster.delta, 2); // 7 - 5
  });
});

// ── Tuning suggestions ──────────────────────────────────────────────

describe('tuning suggestions', () => {
  test('returns empty array with fewer than 5 history entries', () => {
    const history = [makeHistoryEntry({}), makeHistoryEntry({}), makeHistoryEntry({})];
    const result = suggestTuning(history, { todo_cluster_threshold: 3 });
    assert.equal(result.length, 0);
  });

  test('suggests raising threshold when too noisy (>80% of files trigger)', () => {
    // 9 findings across 10 files = 90% → too noisy
    const history = Array.from({ length: 5 }, () => makeHistoryEntry({ todo_cluster: 9 }, 10));
    const result = suggestTuning(history, { todo_cluster_threshold: 3 });
    const todoSuggestion = result.find(s => s.key === 'todo_cluster_threshold');
    assert.ok(todoSuggestion, 'should suggest for todo_cluster');
    assert.ok(todoSuggestion.suggested > todoSuggestion.current);
    assert.ok(todoSuggestion.reason.startsWith('too_noisy'));
  });

  test('suggests lowering threshold when too quiet (0 findings for all runs)', () => {
    const history = Array.from({ length: 5 }, () => makeHistoryEntry({ todo_cluster: 0 }, 10));
    const result = suggestTuning(history, { todo_cluster_threshold: 3 });
    const todoSuggestion = result.find(s => s.key === 'todo_cluster_threshold');
    assert.ok(todoSuggestion, 'should suggest for todo_cluster');
    assert.ok(todoSuggestion.suggested < todoSuggestion.current);
    assert.ok(todoSuggestion.reason.startsWith('too_quiet'));
  });

  test('does not suggest when findings are within normal range', () => {
    // 3 findings across 10 files = 30% → normal
    const history = Array.from({ length: 5 }, () => makeHistoryEntry({ todo_cluster: 3 }, 10));
    const result = suggestTuning(history, { todo_cluster_threshold: 3 });
    const todoSuggestion = result.find(s => s.key === 'todo_cluster_threshold');
    assert.equal(todoSuggestion, undefined, 'should not suggest when within range');
  });
});

// ── Integrated feedback loop ─────────────────────────────────────────

describe('integrated feedback loop', () => {
  test('scanHygiene includes trends from history', () => {
    const root = tmpDir('loop-trends');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log("x");\n', 'utf8');

    const config = makeConfig(root);
    const historyPath = config.paths.hygiene_history_log;

    // Seed history with 3 prior entries
    seedHistory(historyPath, [
      makeHistoryEntry({ console_log: 1 }),
      makeHistoryEntry({ console_log: 1 }),
      makeHistoryEntry({ console_log: 1 }),
    ]);

    const result = scanHygiene(config, { record: false });
    assert.ok(result.trends);
    assert.notEqual(result.trends.overall, 'insufficient_data');
    assert.equal(result.trends.runs, 3);
  });

  test('scanHygiene returns tuning suggestions after 5+ history entries', () => {
    const root = tmpDir('loop-tuning');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const x = 1;\n', 'utf8');

    const config = makeConfig(root);
    const historyPath = config.paths.hygiene_history_log;

    // Seed with 5 entries where todo_cluster is always 0 → too_quiet
    seedHistory(historyPath, Array.from({ length: 5 }, () => makeHistoryEntry({ todo_cluster: 0 }, 10)));

    const result = scanHygiene(config, { record: false });
    assert.ok(Array.isArray(result.tuning));
    assert.ok(result.tuning.length > 0, 'should have tuning suggestions');
  });
});
