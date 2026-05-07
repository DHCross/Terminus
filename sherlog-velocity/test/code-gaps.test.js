const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { scanCodeGaps, scanCodeGapDiff } = require('../src/core/code-gaps');

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
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
    },
    settings: {
      gap_scan_ignore_dirs: [],
      hygiene: {
        nesting_depth_threshold: 5,
      },
    },
  };
}

describe('code gap scanner', () => {
  test('reports absolute any and missing-test hotspots', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-code-gaps-abs-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'typed.ts'),
      [
        'export function run(input: any): any {',
        '  return input as any;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'tests', 'typed.test.ts'),
      'test("typed", () => expect(true).toBe(true));\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'untested.ts'),
      'export const pending = 1;\n',
      'utf8'
    );

    const result = scanCodeGaps(makeConfig(repoRoot));
    assert.equal(result.mode, 'absolute');
    assert.ok(Array.isArray(result.files));
    assert.ok(result.files.some(entry => entry.file === 'src/typed.ts' && entry.any.total >= 2));
    assert.ok(result.files.some(entry => entry.file === 'src/untested.ts' && entry.missing_tests === 1));
  });

  test('reports only changed-file deltas for --since comparisons', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-code-gaps-diff-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'changed.ts'),
      [
        'export function run(input: any): any {',
        '  return input;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'stable.ts'),
      [
        'export const stable = (x: any) => x;',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'tests', 'changed.test.ts'),
      'test("changed", () => expect(true).toBe(true));\n',
      'utf8'
    );

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-02-24T10:00:00Z');

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'changed.ts'),
      [
        'export function run(input: any): any {',
        '  const cloned: any = input;',
        '  return cloned as any;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    commitAll(repoRoot, 'add more any', '2026-02-25T10:00:00Z');

    const diff = scanCodeGapDiff(makeConfig(repoRoot), 'HEAD~1');
    assert.equal(diff.mode, 'diff');
    assert.ok(diff.changed_files.includes('src/changed.ts'));
    assert.ok(!diff.changed_files.includes('src/stable.ts'));

    const anyChange = diff.changes.find(change => change.file === 'src/changed.ts' && change.metric === 'any');
    assert.ok(anyChange);
    assert.ok(anyChange.delta > 0);
    assert.ok(anyChange.after > anyChange.before);
  });

  test('splits suppressed and unsuppressed any + complexity depth in absolute scans', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-code-gaps-suppressed-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'suppressed.ts'),
      [
        'export const a: any = 1;',
        '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
        'export const b: any = 2;',
        'export const c: any = 3;',
        '',
        '// eslint-disable-next-line complexity',
        'export function deepSuppressed(input) {',
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
      ].join('\n') + '\n',
      'utf8'
    );

    const result = scanCodeGaps(makeConfig(repoRoot), { include_suppressed: false });
    const entry = result.files.find(item => item.file === 'src/suppressed.ts');
    assert.ok(entry, 'suppressed.ts should be present in scan output');
    assert.equal(entry.any.total, 3);
    assert.equal(entry.any.unsuppressed, 2);
    assert.equal(entry.any.suppressed, 1);
    assert.ok(entry.complexity.total > entry.complexity.unsuppressed);
    assert.ok(entry.complexity.suppressed > 0);
  });

  test('uses unsuppressed counts by default and full counts with include_suppressed', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-code-gaps-since-suppressed-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'delta.ts'),
      [
        'export const seed: any = 1;',
      ].join('\n') + '\n',
      'utf8'
    );

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-02-24T10:00:00Z');

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'delta.ts'),
      [
        'export const seed: any = 1;',
        '// @ts-expect-error intentional',
        'export const later: any = 2;',
      ].join('\n') + '\n',
      'utf8'
    );
    commitAll(repoRoot, 'add suppressed any', '2026-02-25T10:00:00Z');

    const defaultDiff = scanCodeGapDiff(makeConfig(repoRoot), 'HEAD~1');
    const defaultAny = defaultDiff.changes.find(change => change.file === 'src/delta.ts' && change.metric === 'any');
    assert.equal(defaultAny, undefined);

    const fullDiff = scanCodeGapDiff(makeConfig(repoRoot), 'HEAD~1', { include_suppressed: true });
    const fullAny = fullDiff.changes.find(change => change.file === 'src/delta.ts' && change.metric === 'any');
    assert.ok(fullAny);
    assert.equal(fullAny.delta, 1);
  });

  test('infers type-shape hints for any values passed to typed functions', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-code-gaps-hints-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'helpers.ts'),
      [
        'export type ChartDataPoint = { x: number; y: number };',
        'export function processChartData(data: ChartDataPoint[]): number {',
        '  return data.length;',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'chart.ts'),
      [
        'import { processChartData } from "./helpers";',
        'const chartData: any = [];',
        'export const total = processChartData(chartData);',
      ].join('\n') + '\n',
      'utf8'
    );

    const result = scanCodeGaps(makeConfig(repoRoot));
    const chartEntry = result.files.find(entry => entry.file === 'src/chart.ts');
    assert.ok(chartEntry);
    assert.ok(Array.isArray(chartEntry.hints));
    const hint = chartEntry.hints.find(item => (
      item.symbol === 'chartData'
      && item.function_name === 'processChartData'
      && item.expected_type === 'ChartDataPoint[]'
      && item.relation === 'argument'
    ));
    assert.ok(hint);
  });
});
