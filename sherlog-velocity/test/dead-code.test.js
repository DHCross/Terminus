const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanDeadCode } = require('../src/core/dead-code');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-dead-code-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.trim()}\n`, 'utf8');
}

function makeConfig(repoRoot, sourceRoots = ['src']) {
  return {
    repo_root: repoRoot,
    paths: {
      source_roots: sourceRoots,
      dead_code_history_log: path.join(repoRoot, 'sherlog-velocity', 'data', 'dead-code-history.jsonl'),
    },
    settings: {
      gap_scan_ignore_dirs: [],
    },
  };
}

describe('dead-code scanner', () => {
  test('detects unreachable code without recording history', () => {
    const repoRoot = makeRepo();
    writeFile(path.join(repoRoot, 'src', 'example.js'), `
      function example() {
        return;
        const unreachableValue = 1;
      }
      module.exports = { example };
    `);

    const result = scanDeadCode(makeConfig(repoRoot), { record: false });

    assert.equal(result.summary.scanned_files, 1);
    assert.ok(result.gaps.includes('dead_code_unreachable'));
    assert.ok(result.findings.some(f => f.file === 'src/example.js' && f.type === 'unreachable_code'));
  });

  test('limits scans to configured source roots', () => {
    const repoRoot = makeRepo();
    writeFile(path.join(repoRoot, 'src', 'included.js'), `
      function included() {
        return;
        const unreachableValue = 1;
      }
      module.exports = { included };
    `);
    writeFile(path.join(repoRoot, 'packages', 'other', 'ignored.js'), `
      function ignored() {
        return;
        const unreachableValue = 1;
      }
      module.exports = { ignored };
    `);

    const result = scanDeadCode(makeConfig(repoRoot, ['src']), { record: false });

    assert.equal(result.summary.scanned_files, 1);
    assert.deepEqual(
      Array.from(new Set(result.findings.map(f => f.file))),
      ['src/included.js']
    );
  });
});
