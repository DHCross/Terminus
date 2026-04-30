const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAutoContextGuess, wireHostScripts } = require('../install');

test('buildAutoContextGuess infers stack, roots, and lane defaults for blind runs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-auto-context-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const ready = true;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'tests', 'index.test.ts'), 'test("ok", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'scripts', 'seed.js'), 'console.log("seed");\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'archive', 'old.js'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'export const bundle = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'auto-context-fixture',
        dependencies: {
          astro: '^5.0.0',
        },
      }, null, 2),
      'utf8'
    );

    const guess = buildAutoContextGuess(tmpDir);

    assert.equal(guess.stack.framework, 'Astro');
    assert.ok(guess.source_roots.includes('src'));
    assert.ok(guess.test_roots.includes('tests'));
    assert.ok(guess.archive_roots.includes('archive'));
    assert.equal(guess.path_lanes_default, 'core');
    assert.ok(guess.path_lanes.some(lane => lane.name === 'tests' && lane.mode === 'strict'));
    assert.ok(guess.path_lanes.some(lane => lane.name === 'scripts' && lane.mode === 'relaxed'));
    assert.ok(guess.path_lanes.some(lane => lane.name === 'generated' && lane.mode === 'excluded'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('wireHostScripts prefers sherlog bin commands for installed-package mode', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-wire-host-'));
  const originalCwd = process.cwd();

  try {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }, null, 2));
    process.chdir(repoRoot);
    wireHostScripts(repoRoot);
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['sherlog:update']);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
