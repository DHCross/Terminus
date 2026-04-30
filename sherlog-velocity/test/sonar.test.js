const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectGaps } = require('../src/core/gap-detector');
const {
  buildReport,
  loadEnv,
  qualityGateToGapTypes,
  registerGaps,
  resolveSonarRuntime,
  run,
} = require('../src/cli/sonar');

function makeConfig(repoRoot, overrides = {}) {
  return {
    repo_root: repoRoot,
    paths: {
      source_roots: ['src'],
      docs_dir: 'docs',
      gap_acknowledgements: path.join(repoRoot, 'sherlog.acknowledgements.json'),
      gap_history_log: path.join(repoRoot, 'gap-history.jsonl'),
    },
    settings: {
      gap_scan_ignore_dirs: [],
      sonar: {
        org: '<YOUR_SONARCLOUD_ORG>',
        project_key: '<YOUR_SONARCLOUD_PROJECT_KEY>',
        sonarcloud_url: 'https://sonarcloud.io',
        report_output: 'velocity-artifacts/sonar-report.json',
        gap_registration: {
          enabled: true,
          gap_expiry_days: 14,
          register_on_gate_fail: true,
        },
      },
    },
    ...overrides,
  };
}

describe('sherlog:sonar helpers', () => {
  test('qualityGateToGapTypes maps Sonar metrics into Sherlog gap types', () => {
    const gaps = qualityGateToGapTypes([
      { metric: 'new_security_hotspots_reviewed', status: 'ERROR' },
      { metric: 'coverage', status: 'ERROR' },
      { metric: 'duplicated_lines_density', status: 'ERROR' },
      { metric: 'sqale_rating', status: 'ERROR' },
    ]);

    assert.deepStrictEqual(gaps.sort(), ['context_drift', 'missing_implementation', 'security_exposure', 'test_coverage']);
  });

  test('loadEnv loads the first matching env file without overwriting existing vars', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-sonar-env-'));
    const cwd = process.cwd();
    const oldToken = process.env.SONARCLOUD_TOKEN;
    const oldProject = process.env.SONARCLOUD_PROJECT;
    const envPath = path.join(repoRoot, '.env.local');
    fs.writeFileSync(envPath, 'SONARCLOUD_TOKEN=from-file\nSONARCLOUD_PROJECT=from-env-file\n', 'utf8');
    process.env.SONARCLOUD_TOKEN = 'keep-me';
    delete process.env.SONARCLOUD_PROJECT;

    process.chdir(repoRoot);
    loadEnv();

    assert.equal(process.env.SONARCLOUD_TOKEN, 'keep-me');
    assert.equal(process.env.SONARCLOUD_PROJECT, 'from-env-file');

    process.chdir(cwd);
    if (oldToken === undefined) delete process.env.SONARCLOUD_TOKEN;
    else process.env.SONARCLOUD_TOKEN = oldToken;
    if (oldProject === undefined) delete process.env.SONARCLOUD_PROJECT;
    else process.env.SONARCLOUD_PROJECT = oldProject;
  });

  test('buildReport shapes Sonar payloads into a stable artifact contract', () => {
    const report = buildReport({
      qualityGate: {
        projectStatus: {
          status: 'ERROR',
          conditions: [
            { metricKey: 'coverage', status: 'ERROR', actualValue: '72.0', errorThreshold: '80' },
          ],
        },
      },
      issues: [
        { key: 'i1', component: 'demo:src/index.js', type: 'BUG', severity: 'MAJOR', message: 'bad', line: 7 },
      ],
      hotspots: [
        { key: 'h1', component: 'demo:src/index.js', status: 'TO_REVIEW', message: 'review me', line: 9 },
      ],
      measures: { coverage: '72.0' },
      projectKey: 'demo',
      org: 'demo-org',
      branch: 'main',
      pr: null,
      head: 'abc123',
    });

    assert.equal(report._sherlog_schema, 'sonar-report@1');
    assert.equal(report.summary.total_issues, 1);
    assert.equal(report.unreviewed_hotspots.length, 1);
    assert.ok(Array.isArray(report.issues_by_file['src/index.js']));
  });
});

describe('sherlog:sonar registration', () => {
  test('registerGaps writes open sonarcloud entries and avoids duplicates', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-sonar-ack-'));
    const ackPath = path.join(repoRoot, 'sherlog.acknowledgements.json');
    const report = {
      project_key: 'demo',
      branch: 'main',
      pull_request: null,
      head: 'abc123',
      quality_gate: {
        passed: false,
        conditions: [
          { metric: 'coverage', status: 'ERROR', actual: '72.0', threshold: '80' },
          { metric: 'duplicated_lines_density', status: 'ERROR', actual: '7.5', threshold: '3' },
        ],
      },
    };

    const first = registerGaps(report, { ackPath, gapExpiryDays: 14, dryRun: false });
    const second = registerGaps(report, { ackPath, gapExpiryDays: 14, dryRun: false });
    const parsed = JSON.parse(fs.readFileSync(ackPath, 'utf8'));

    assert.equal(first.created, 2);
    assert.equal(second.created, 0);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[0].status, 'open');
    assert.equal(parsed.entries[0].source, 'sonarcloud');
  });

  test('detectGaps surfaces active open sonar acknowledgements as first-class gaps', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-sonar-gap-'));
    const recordedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'feature.js'), 'module.exports = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'sherlog.acknowledgements.json'), JSON.stringify({
      entries: [
        {
          id: 'sonar_1',
          feature: '*',
          gap: 'security_exposure',
          status: 'open',
          reason: 'SonarCloud gate failed',
          recorded_at: recordedAt,
          expires_at: expiresAt,
          source: 'sonarcloud',
          source_ref: {
            scope_type: 'branch',
            scope_value: 'main'
          }
        }
      ]
    }, null, 2), 'utf8');

    const config = makeConfig(repoRoot);
    const result = detectGaps('Feature', config, { record: false });

    assert.ok(result.gaps.includes('security_exposure'));
    const ranked = result.salience.ranked.find(item => item.gap === 'security_exposure');
    assert.equal(ranked.acknowledgement.state, 'open');
    assert.equal(ranked.acknowledgement.active, true);
  });
});

describe('sherlog:sonar runtime', () => {
  test('resolveSonarRuntime prefers env vars and ignores placeholder config values', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-sonar-runtime-'));
    const oldProject = process.env.SONARCLOUD_PROJECT;
    const oldToken = process.env.SONARCLOUD_TOKEN;

    process.env.SONARCLOUD_PROJECT = 'env-project';
    process.env.SONARCLOUD_TOKEN = 'env-token';
    const runtime = resolveSonarRuntime(makeConfig(repoRoot));

    assert.equal(runtime.projectKey, 'env-project');
    assert.equal(runtime.token, 'env-token');

    if (oldProject === undefined) delete process.env.SONARCLOUD_PROJECT;
    else process.env.SONARCLOUD_PROJECT = oldProject;
    if (oldToken === undefined) delete process.env.SONARCLOUD_TOKEN;
    else process.env.SONARCLOUD_TOKEN = oldToken;
  });

  test('run writes the artifact and supports dry-run registration', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-sonar-run-'));
    const reportPath = path.join(repoRoot, 'velocity-artifacts', 'sonar-report.json');
    const ackPath = path.join(repoRoot, 'sherlog.acknowledgements.json');
    const config = makeConfig(repoRoot, {
      settings: {
        gap_scan_ignore_dirs: [],
        sonar: {
          org: 'demo-org',
          project_key: 'demo-project',
          sonarcloud_url: 'https://sonarcloud.io',
          report_output: 'velocity-artifacts/sonar-report.json',
          gap_registration: {
            enabled: true,
            gap_expiry_days: 14,
            register_on_gate_fail: true,
          },
        },
      },
    });

    const result = await run(['node', 'sonar.js', '--dry-run'], {
      skipEnvLoad: true,
      config,
      runtime: {
        ...resolveSonarRuntime(config),
        repoRoot,
        ackPath,
        reportPath,
        token: 'demo-token',
        projectKey: 'demo-project',
        org: 'demo-org',
      },
      branchHead: { branch: 'main', head: 'abc123' },
      fetchQualityGate: async () => ({ projectStatus: { status: 'ERROR', conditions: [{ metricKey: 'coverage', status: 'ERROR', actualValue: '70', errorThreshold: '80' }] } }),
      fetchIssues: async () => [],
      fetchHotspots: async () => [],
      fetchMeasures: async () => ({ coverage: '70' }),
    });

    assert.equal(result.registration.created, 1);
    assert.ok(fs.existsSync(reportPath));
    assert.equal(fs.existsSync(ackPath), false);
  });
});
