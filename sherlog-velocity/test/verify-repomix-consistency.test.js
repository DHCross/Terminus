const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { checkRepomixBundleConsistency } = require('../src/cli/verify');

function makeRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-verify-repomix-${label}-`));
}

function seedBundleIndex(repoRoot, bundleIds) {
  const bundlePath = path.join(repoRoot, '.repomix', 'bundles.json');
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  const bundles = {};
  bundleIds.forEach(id => {
    bundles[id] = {
      name: id,
      created: '2026-02-10T00:00:00Z',
      lastUsed: '2026-02-10T00:00:00Z',
      tags: [],
      files: [],
    };
  });
  fs.writeFileSync(bundlePath, JSON.stringify({ bundles }, null, 2), 'utf8');
}

function seedManifest(repoRoot, entries, layout = 'root') {
  const manifestPath = layout === 'vessel'
    ? path.join(repoRoot, 'vessel', 'repomix-manifest.json')
    : path.join(repoRoot, 'repomix-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ bundles: entries }, null, 2), 'utf8');
}

function seedXmlArtifact(repoRoot, id, isoTimestamp = '2026-02-10T00:00:00Z', layout = 'root') {
  const artifactPath = layout === 'vessel'
    ? path.join(repoRoot, 'vessel', `repomix-${id}.xml`)
    : path.join(repoRoot, `repomix-${id}.xml`);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `<bundle id="${id}" />\n`, 'utf8');
  const ts = new Date(isoTimestamp);
  fs.utimesSync(artifactPath, ts, ts);
}

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

function runCheck(repoRoot, config = {}) {
  return checkRepomixBundleConsistency({
    repoRoot,
    config,
    contextMode: 'repomix-compat',
  });
}

describe('verify repomix_bundle_consistency', () => {
  test('passes for a repo-root manifest when config points there', () => {
    const repoRoot = makeRepoRoot('pass');
    seedBundleIndex(repoRoot, ['alpha', 'beta']);
    seedManifest(repoRoot, [
      { id: 'alpha', last_updated: '2026-02-10T00:00:00Z' },
      { id: 'beta', last_updated: '2026-02-10T00:00:00Z' },
    ], 'root');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-10T00:00:00Z', 'root');
    seedXmlArtifact(repoRoot, 'beta', '2026-02-10T00:00:00Z', 'root');

    const check = runCheck(repoRoot, {
      paths: {
        repomix_manifest: 'repomix-manifest.json',
      },
    });
    assert.equal(check.status, 'pass');
    assert.equal(check.evidence.manifest.selected_path, 'repomix-manifest.json');
    assert.equal(check.evidence.manifest.used_fallback, false);
    assert.deepEqual(check.evidence.mismatches.missing_in_manifest, []);
    assert.deepEqual(check.evidence.mismatches.missing_in_bundle_index, []);
    assert.deepEqual(check.evidence.mismatches.mtime_mismatches, []);
  });

  test('passes for a legacy vessel manifest without treating repo root as required', () => {
    const repoRoot = makeRepoRoot('legacy-vessel');
    seedBundleIndex(repoRoot, ['alpha']);
    seedManifest(repoRoot, [
      { id: 'alpha', last_updated: '2026-02-10T00:00:00Z' },
    ], 'vessel');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-10T00:00:00Z', 'vessel');

    const check = runCheck(repoRoot);
    assert.equal(check.status, 'pass');
    assert.equal(check.evidence.manifest.selected_path, 'vessel/repomix-manifest.json');
    assert.equal(check.evidence.manifest.used_fallback, true);
    assert.ok(!check.evidence.issues.some(issue => issue.includes('repo root')));
  });

  test('fails when bundle IDs diverge between bundle index and manifest', () => {
    const repoRoot = makeRepoRoot('id-divergence');
    seedBundleIndex(repoRoot, ['alpha', 'beta']);
    seedManifest(repoRoot, [
      { id: 'alpha', last_updated: '2026-02-10T00:00:00Z' },
      { id: 'gamma', last_updated: '2026-02-10T00:00:00Z' },
    ], 'root');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-10T00:00:00Z', 'root');
    seedXmlArtifact(repoRoot, 'gamma', '2026-02-10T00:00:00Z', 'root');

    const check = runCheck(repoRoot, {
      paths: {
        repomix_manifest: 'repomix-manifest.json',
      },
    });
    assert.equal(check.status, 'fail');
    assert.deepEqual(check.evidence.mismatches.missing_in_manifest, ['beta']);
    assert.deepEqual(check.evidence.mismatches.missing_in_bundle_index, ['gamma']);
  });

  test('fails when XML mtime does not match manifest last_updated', () => {
    const repoRoot = makeRepoRoot('mtime-mismatch');
    seedBundleIndex(repoRoot, ['alpha']);
    seedManifest(repoRoot, [
      { id: 'alpha', last_updated: '2026-02-10T00:00:00Z' },
    ], 'root');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-11T00:00:00Z', 'root');

    const check = runCheck(repoRoot, {
      paths: {
        repomix_manifest: 'repomix-manifest.json',
      },
    });
    assert.equal(check.status, 'fail');
    assert.equal(check.evidence.mismatches.mtime_mismatches.length, 1);
    assert.equal(check.evidence.mismatches.mtime_mismatches[0].id, 'alpha');
    assert.equal(check.evidence.mismatches.mtime_mismatches[0].reason, 'mtime_mismatch');
  });

  test('fails when XML is older than the latest source commit for a bundle', () => {
    const repoRoot = makeRepoRoot('source-stale');
    seedBundleIndex(repoRoot, ['alpha']);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = true;\n', 'utf8');
    seedManifest(repoRoot, [
      {
        id: 'alpha',
        paths: ['src/payments.js'],
        last_updated: '2026-02-10T12:00:00Z',
      },
    ], 'root');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-10T12:00:00Z', 'root');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-02-10T11:00:00Z');

    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = false;\n', 'utf8');
    commitAll(repoRoot, 'source update', '2026-02-10T13:00:00Z');

    const check = runCheck(repoRoot, {
      paths: {
        repomix_manifest: 'repomix-manifest.json',
      },
    });

    assert.equal(check.status, 'fail');
    assert.equal(check.evidence.mismatches.source_freshness_mismatches.length, 1);
    assert.equal(check.evidence.mismatches.source_freshness_mismatches[0].id, 'alpha');
    assert.equal(check.evidence.mismatches.source_freshness_mismatches[0].reason, 'xml_stale_vs_source');
  });

  test('passes same-day source freshness when manifest granularity is date-only', () => {
    const repoRoot = makeRepoRoot('source-same-day-date');
    seedBundleIndex(repoRoot, ['alpha']);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'payments.js'), 'export const ok = true;\n', 'utf8');
    seedManifest(repoRoot, [
      {
        id: 'alpha',
        paths: ['src/payments.js'],
        last_updated: '2026-02-10',
      },
    ], 'root');
    seedXmlArtifact(repoRoot, 'alpha', '2026-02-10T00:05:00Z', 'root');

    initGitRepo(repoRoot);
    commitAll(repoRoot, 'seed', '2026-02-10T23:00:00Z');

    const check = runCheck(repoRoot, {
      paths: {
        repomix_manifest: 'repomix-manifest.json',
      },
    });

    assert.equal(check.status, 'pass');
    assert.deepEqual(check.evidence.mismatches.source_freshness_mismatches, []);
  });
});
