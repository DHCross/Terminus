const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs } = require('../src/cli/update');

test('update CLI parses version and check flags', () => {
  const args = parseArgs(['node', 'update.js', '--check', '--version', '1.2.3', '--json']);
  assert.equal(args.check, true);
  assert.equal(args.version, '1.2.3');
  assert.equal(args.json, true);
});
