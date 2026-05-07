const assert = require('node:assert/strict');
const test = require('node:test');

const { shellQuote, buildCommandsRun, slugify, parseArgs } = require('../src/cli/report');

test('shellQuote leaves safe paths untouched', () => {
  assert.equal(shellQuote('src/feature.ts'), 'src/feature.ts');
  assert.equal(shellQuote('a-b_c.1'), 'a-b_c.1');
  assert.equal(shellQuote('/abs/path/file.js'), '/abs/path/file.js');
});

test('shellQuote wraps paths containing spaces', () => {
  assert.equal(shellQuote('my file.ts'), '"my file.ts"');
  assert.equal(shellQuote('with spaces/sub dir/x.js'), '"with spaces/sub dir/x.js"');
});

test('shellQuote escapes shell metacharacters', () => {
  assert.equal(shellQuote('a"b'), '"a\\"b"');
  assert.equal(shellQuote('a$b'), '"a\\$b"');
  assert.equal(shellQuote('a`b'), '"a\\`b"');
  assert.equal(shellQuote('a\\b'), '"a\\\\b"');
});

test('shellQuote handles empty/null values', () => {
  assert.equal(shellQuote(''), '""');
  assert.equal(shellQuote(null), '""');
  assert.equal(shellQuote(undefined), '""');
});

test('buildCommandsRun quotes the feature name and file paths', () => {
  const cmds = buildCommandsRun('Feature With Spaces', ['src/a.ts', 'path with space/b.ts']);
  assert.equal(cmds.length, 4);
  assert.match(cmds[0], /sherlog:doctor.*--feature "Feature With Spaces" --json/);
  assert.match(cmds[1], /sherlog:gaps.*--feature "Feature With Spaces" --json/);
  assert.match(cmds[2], /sherlog:blast-radius.*--file src\/a\.ts --json/);
  assert.match(cmds[3], /sherlog:blast-radius.*--file "path with space\/b\.ts" --json/);
});

test('buildCommandsRun handles zero hot files', () => {
  const cmds = buildCommandsRun('Simple', []);
  assert.equal(cmds.length, 2);
  assert.match(cmds[0], /sherlog:doctor/);
  assert.match(cmds[1], /sherlog:gaps/);
});

test('slugify produces filesystem-safe slugs', () => {
  assert.equal(slugify('Feature Name'), 'feature-name');
  assert.equal(slugify('UPPER & lower'), 'upper-lower');
  assert.equal(slugify('  many   spaces  '), 'many-spaces');
  assert.equal(slugify(''), 'audit');
  assert.equal(slugify(null), 'audit');
  assert.equal(slugify('---only-symbols---'), 'only-symbols');
});

test('parseArgs accepts feature, tier, and optional metadata', () => {
  const args = parseArgs([
    'node', 'report.js',
    '--feature', 'Test Feature',
    '--tier', 'intro',
    '--customer', 'Acme',
    '--auditor', 'Jane',
    '--blast-top', '5',
  ]);
  assert.equal(args.feature, 'Test Feature');
  assert.equal(args.tier, 'intro');
  assert.equal(args.customer, 'Acme');
  assert.equal(args.auditor, 'Jane');
  assert.equal(args.blastTop, 5);
});

test('parseArgs defaults tier to full and blast-top to 3', () => {
  const args = parseArgs(['node', 'report.js', '--feature', 'X']);
  assert.equal(args.tier, 'full');
  assert.equal(args.blastTop, 3);
  assert.equal(args.json, false);
});
