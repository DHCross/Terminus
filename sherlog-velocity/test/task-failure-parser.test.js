const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseTaskFailures } = require('../src/core/task-failure-parser');

describe('task failure parser', () => {
  test('parses node:test TAP failures', () => {
    const failures = parseTaskFailures([
      'TAP version 13',
      '# Subtest: parses combined stream',
      'not ok 2 - parses combined stream',
      '  ---',
      '  error: Expected values to be strictly equal:',
      '  code: ERR_ASSERTION',
      '  ...',
    ].join('\n'));

    assert.equal(failures.length, 1);
    assert.equal(failures[0].title, 'parses combined stream');
    assert.match(String(failures[0].detail), /Expected values to be strictly equal/);
  });

  test('parses FAIL-style suite headers with assertion details', () => {
    const failures = parseTaskFailures([
      'stderr: Assertion output follows',
      'FAIL sherlog-velocity/test/gap-detector.test.js > detectGaps > narrows feature signals',
      'AssertionError: expected 3 to equal 1',
      '    at Context.<anonymous> (gap-detector.test.js:42:9)',
    ].join('\n'));

    assert.equal(failures.length >= 1, true);
    assert.match(failures[0].title, /gap-detector\.test\.js/);
    assert.match(String(failures[0].detail), /expected 3 to equal 1/);
  });

  test('parses marked failures from mixed stdout and stderr text', () => {
    const failures = parseTaskFailures([
      'task: [test] node --test sherlog-velocity/test/profile-check-service.test.js',
      'stdout: starting run',
      '✖ profile check should retain doctor failure details',
      'stderr: Error: doctor exited non-zero',
    ].join('\n'));

    assert.equal(failures.length, 1);
    assert.equal(failures[0].title, 'profile check should retain doctor failure details');
  });
});
