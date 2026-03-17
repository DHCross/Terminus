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

function runResult(cmd, cwd, env = {}) {
  try {
    return {
      status: 0,
      stdout: run(cmd, cwd, env),
      stderr: '',
    };
  } catch (err) {
    return {
      status: Number.isFinite(err?.status) ? err.status : 1,
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || err?.message || ''),
    };
  }
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

function seedXmlArtifact(repoRoot, id, isoTimestamp) {
  const artifactPath = path.join(repoRoot, `repomix-${id}.xml`);
  fs.writeFileSync(artifactPath, `<bundle id="${id}" />\n`, 'utf8');
  const ts = new Date(isoTimestamp);
  fs.utimesSync(artifactPath, ts, ts);
}

describe('repomix-sync CLI', () => {
  test('--help exits without mutating manifest state', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-repomix-help-'));
    const manifestPath = path.join(repoRoot, 'repomix-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      bundles: [{ name: 'Core', paths: ['src/file.js'], last_updated: '2026-01-01' }],
    }, null, 2), 'utf8');

    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'repomix-sync.js');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const out = run(`node "${scriptPath}" --help --manifest "${manifestPath}"`, repoRoot);
    const after = fs.readFileSync(manifestPath, 'utf8');

    assert.ok(out.includes('Usage:'));
    assert.equal(after, before);
  });

  test('uses date-granularity freshness math for date-only last_updated', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-repomix-date-'));
    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'repomix-sync.js');
    const manifestPath = path.join(repoRoot, 'repomix-manifest.json');

    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = true;\n', 'utf8');
    seedXmlArtifact(repoRoot, 'core', '2026-01-10T00:05:00Z');
    fs.writeFileSync(manifestPath, JSON.stringify({
      bundles: [
        {
          id: 'core',
          name: 'Core',
          paths: ['src/payments.js'],
          last_updated: '2026-01-10',
        },
      ],
    }, null, 2), 'utf8');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-10T23:00:00Z');

    const sameDayRaw = run(`node "${scriptPath}" --json --manifest "${manifestPath}"`, repoRoot);
    const sameDay = JSON.parse(sameDayRaw);
    assert.equal(sameDay.stale_bundles, 0);
    assert.equal(sameDay.updates[0].next_last_updated, '2026-01-10');

    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = false;\n', 'utf8');
    commitAll(repoRoot, 'next-day', '2026-01-11T01:00:00Z');

    const nextDayResult = runResult(`node "${scriptPath}" --json --manifest "${manifestPath}"`, repoRoot);
    const nextDay = JSON.parse(nextDayResult.stdout);
    assert.equal(nextDayResult.status, 1);
    assert.equal(nextDay.stale_bundles, 1);
  });

  test('writes manifest last_updated from XML mtime instead of source commit time', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-repomix-write-'));
    const scriptPath = path.join(__dirname, '..', 'src', 'cli', 'repomix-sync.js');
    const manifestPath = path.join(repoRoot, 'repomix-manifest.json');

    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = true;\n', 'utf8');
    seedXmlArtifact(repoRoot, 'core', '2026-01-10T12:34:56Z');
    fs.writeFileSync(manifestPath, JSON.stringify({
      bundles: [
        {
          id: 'core',
          name: 'Core',
          paths: ['src/payments.js'],
          last_updated: '2026-01-09T00:00:00Z',
        },
      ],
    }, null, 2), 'utf8');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-01-10T09:00:00Z');

    const result = runResult(`node "${scriptPath}" --json --write --manifest "${manifestPath}"`, repoRoot);
    const payload = JSON.parse(result.stdout);
    const nextManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(result.status, 0);
    assert.equal(payload.changed_bundles, 1);
    assert.equal(payload.updates[0].next_last_updated, '2026-01-10T12:34:56Z');
    assert.equal(nextManifest.bundles[0].last_updated, '2026-01-10T12:34:56Z');
  });
});
