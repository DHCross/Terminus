const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

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

function commitAll(repoRoot, message) {
  run('git add .', repoRoot);
  run(`git commit -m "${message}"`, repoRoot);
}

function copyDropPackage(repoRoot) {
  const sourceDropRoot = path.join(__dirname, '..');
  const targetDropRoot = path.join(repoRoot, 'sherlog-velocity');
  fs.cpSync(sourceDropRoot, targetDropRoot, { recursive: true });
  return targetDropRoot;
}

function createExistingSherlogRepo(label) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-bridge-${label}-`));
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.js'), 'module.exports = { ok: true };\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: `bridge-${label}`,
    version: '0.0.0',
    scripts: {},
  }, null, 2) + '\n', 'utf8');

  initGitRepo(repoRoot);
  commitAll(repoRoot, 'seed');
  copyDropPackage(repoRoot);
  run('node sherlog-velocity/install.js', repoRoot);
  return repoRoot;
}

function findStep(output, name) {
  return (output.steps || []).find(step => step.name === name) || null;
}

describe('bridge CLI', () => {
  test('dry-run reports planned actions without mutating package.json', () => {
    const repoRoot = createExistingSherlogRepo('dry-run');
    const packagePath = path.join(repoRoot, 'package.json');
    const before = fs.readFileSync(packagePath, 'utf8');

    const raw = run('node sherlog-velocity/src/cli/bridge.js --dry-run --json', repoRoot);
    const output = JSON.parse(raw);
    const after = fs.readFileSync(packagePath, 'utf8');

    assert.equal(output.mode, 'dry-run');
    assert.equal(after, before);

    const backupStep = findStep(output, 'backup');
    const installStep = findStep(output, 'install');
    assert.ok(backupStep);
    assert.ok(installStep);
    assert.equal(backupStep.status, 'skipped');
    assert.equal(installStep.status, 'skipped');
  });

  test('apply mode rewires missing scripts and creates backups', () => {
    const repoRoot = createExistingSherlogRepo('apply');
    const packagePath = path.join(repoRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    delete pkg.scripts['sherlog:doctor'];
    delete pkg.scripts['sherlog:bridge'];
    fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

    const raw = run('node sherlog-velocity/src/cli/bridge.js --json', repoRoot);
    const output = JSON.parse(raw);
    const repairedPkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

    assert.ok(repairedPkg.scripts['sherlog:doctor']);
    assert.ok(repairedPkg.scripts['sherlog:bridge']);

    assert.ok(output.backup.directory);
    assert.ok(fs.existsSync(output.backup.directory));
    assert.ok(output.backup.files.some(entry => entry.source.endsWith('package.json')));

    const installStep = findStep(output, 'install');
    assert.ok(installStep);
    assert.equal(installStep.status, 'success');
  });
});
