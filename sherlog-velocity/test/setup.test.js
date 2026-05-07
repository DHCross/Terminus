const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, detectMode, buildPlan } = require('../src/cli/setup');

test('setup CLI parses apply/strict/mode/repo-root flags', () => {
  const args = parseArgs([
    'node',
    'setup.js',
    '--apply',
    '--strict',
    '--mode',
    'upgrade',
    '--repo-root',
    '/tmp/repo',
    '--json',
  ]);

  assert.equal(args.apply, true);
  assert.equal(args.strict, true);
  assert.equal(args.mode, 'upgrade');
  assert.equal(args.repoRoot, '/tmp/repo');
  assert.equal(args.json, true);
});

test('setup mode auto resolves to fresh when no config exists', () => {
  const args = { mode: 'auto' };
  const mode = detectMode(args, { configExists: false });
  assert.equal(mode, 'fresh');
});

test('setup mode auto resolves to upgrade when config exists', () => {
  const args = { mode: 'auto' };
  const mode = detectMode(args, { configExists: true });
  assert.equal(mode, 'upgrade');
});

test('buildPlan generates fresh install steps', () => {
  const plan = buildPlan('fresh', { strict: false }, '/tmp/repo');
  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, 'install');
  assert.equal(plan[1].id, 'verify');
});

test('buildPlan generates upgrade bridge step', () => {
  const plan = buildPlan('upgrade', { strict: true }, '/tmp/repo');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 'bridge');
  assert.ok(plan[0].command.includes('--strict'));
});
