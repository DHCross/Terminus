const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveRuntimeConfig, resolveRepoRoot } = require('../src/core/shared');
const { checkOperationalWiring } = require('../src/cli/verify');

function seedPortableRepo(repoRoot, scripts = {}) {
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.js'), 'export const ready = true;\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'sherlog.context.json'), JSON.stringify({
    zones: [
      {
        name: 'Core',
        paths: ['src/**'],
        belief: 'Keep the core code path healthy.',
        last_updated: '2026-03-13',
      },
    ],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent Guide\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    name: 'portable-repo',
    private: true,
    scripts,
  }, null, 2) + '\n', 'utf8');
}

function makeContext(repoRoot, rawConfig) {
  return {
    configPath: path.join(repoRoot, 'sherlog-velocity', 'config', 'sherlog.config.json'),
    rawConfig,
    config: resolveRuntimeConfig(rawConfig, { cwd: repoRoot }),
    repoRoot: resolveRepoRoot(rawConfig.repo_root, repoRoot),
  };
}

describe('verify operational wiring', () => {
  test('warns when config contains dead absolute machine-specific paths', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-verify-portability-'));
    seedPortableRepo(repoRoot, {
      'sherlog:verify': 'node sherlog-velocity/src/cli/verify.js --strict',
      'sherlog:doctor': 'node sherlog-velocity/src/cli/doctor.js',
      'sherlog:gaps': 'node sherlog-velocity/src/cli/gaps.js',
      'sherlog:bounds': 'node sherlog-velocity/src/cli/bounds.js',
      'sherlog:prompt': 'node sherlog-velocity/src/cli/prompt.js',
      'velocity:estimate': 'node sherlog-velocity/src/core/estimate.js',
    });

    const rawConfig = {
      repo_root: '/Users/someone/old-machine/project',
      context: {
        mode: 'sherlog-map',
        map_file: 'sherlog.context.json',
      },
      paths: {
        source_roots: ['src'],
        velocity_log: '/Users/someone/old-machine/project/sherlog-velocity/data/velocity-log.jsonl',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const checks = checkOperationalWiring(makeContext(repoRoot, rawConfig));
    const portability = checks.find(check => check.id === 'portable_config_paths');

    assert.ok(portability);
    assert.equal(portability.status, 'warn');
    assert.ok(portability.evidence.issues.some(issue => issue.field === 'repo_root' && issue.issue === 'dead_absolute_path'));
    assert.ok(portability.evidence.issues.some(issue => issue.field === 'paths.velocity_log'));

    fs.rmSync(repoRoot, { recursive: true });
  });

  test('fails when required host scripts are missing', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-verify-scripts-'));
    seedPortableRepo(repoRoot, {
      'sherlog:verify': 'node sherlog-velocity/src/cli/verify.js --strict',
    });

    const rawConfig = {
      repo_root: '.',
      context: {
        mode: 'sherlog-map',
        map_file: 'sherlog.context.json',
      },
      paths: {
        source_roots: ['src'],
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const checks = checkOperationalWiring(makeContext(repoRoot, rawConfig));
    const requiredScripts = checks.find(check => check.id === 'required_scripts');

    assert.ok(requiredScripts);
    assert.equal(requiredScripts.status, 'fail');
    assert.deepStrictEqual(requiredScripts.evidence.missing_scripts.sort(), [
      'sherlog:bounds',
      'sherlog:doctor',
      'sherlog:gaps',
      'sherlog:prompt',
      'velocity:estimate',
    ]);

    fs.rmSync(repoRoot, { recursive: true });
  });
});
