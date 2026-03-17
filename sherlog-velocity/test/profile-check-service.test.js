const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { executeProfileCheckService } = require('../../sherlog-vscode/profile-check-service');

describe('profile check freshness gate', () => {
  test('stops before doctor and gaps when repomix sync finds stale bundles', async () => {
    const calls = [];

    const result = await executeProfileCheckService({
      feature: 'Bundle freshness enforcement',
      profile: 'rapid',
      vector: 'repomix',
    }, '/repo', {
      launchRiskSource: 'profile_check',
    }, {
      runTaskProcessPromise: async (args) => {
        calls.push(args);
        if (args[0] === 'repomix-sync') {
          const output = JSON.stringify({ stale_bundles: 1 }, null, 2);
          return { code: 1, output, raw_output: output };
        }
        throw new Error(`unexpected task: ${args[0]}`);
      },
      extractJsonPayload: (text) => JSON.parse(text),
      detectLaunchRisksInPayload: () => {
        throw new Error('launch risk detection should not run when the freshness gate fails');
      },
      persistProfileRun: () => ({
        ok: true,
        artifact_path: '/tmp/profile-run.json',
        history_path: '/tmp/profile-history.jsonl',
      }),
    });

    assert.deepEqual(calls, [
      ['repomix-sync', '--', '--write', '--json'],
    ]);
    assert.equal(result.summary.freshness_gate.passed, false);
    assert.equal(result.summary.freshness_gate.stage, 'repomix_sync');
    assert.equal(result.summary.doctor_exit_code, 1);
    assert.equal(result.summary.gaps_exit_code, 1);
    assert.deepEqual(result.launchRisks, []);
    assert.match(result.outputText, /Freshness gate failed at: repomix_sync/);
  });

  test('runs verify before doctor and gaps after sync succeeds', async () => {
    const calls = [];

    const result = await executeProfileCheckService({
      feature: 'Bundle freshness enforcement',
      profile: 'rapid',
      vector: 'repomix',
    }, '/repo', {
      launchRiskSource: 'profile_check',
    }, {
      runTaskProcessPromise: async (args) => {
        calls.push(args);
        if (args[0] === 'repomix-sync') {
          const output = JSON.stringify({ stale_bundles: 0 }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        if (args[0] === 'verify') {
          const output = JSON.stringify({ summary: { pass: 1, warn: 0, fail: 0 } }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        if (args[0] === 'doctor') {
          const output = JSON.stringify({
            gaps: { total: 1 },
            recommendation: { action: 'continue' },
            salience: { summary: { total_score: 8 } },
          }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        if (args[0] === 'gaps') {
          const output = JSON.stringify({
            gaps: ['test_coverage'],
            evidence: {
              convergence: { overall: { score: 0.5 } },
              intent: { feature_key: 'bundle-freshness-enforcement' },
              path_lanes: { summary: { total_files: 1 } },
            },
          }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        throw new Error(`unexpected task: ${args[0]}`);
      },
      extractJsonPayload: (text) => JSON.parse(text),
      detectLaunchRisksInPayload: () => [{ code: 'bundle_launch_risk' }],
      persistProfileRun: () => ({
        ok: true,
        artifact_path: '/tmp/profile-run.json',
        history_path: '/tmp/profile-history.jsonl',
      }),
    });

    assert.deepEqual(calls, [
      ['repomix-sync', '--', '--write', '--json'],
      ['verify'],
      ['doctor', '--', '--feature', 'Bundle freshness enforcement', '--profile', 'rapid', '--vector', 'repomix'],
      ['gaps', '--', '--feature', 'Bundle freshness enforcement', '--profile', 'rapid', '--vector', 'repomix'],
    ]);
    assert.equal(result.summary.freshness_gate.passed, true);
    assert.equal(result.summary.doctor_exit_code, 0);
    assert.equal(result.summary.gaps_exit_code, 0);
    assert.equal(result.launchRisks.length, 1);
    assert.equal(result.launchRisks[0].code, 'bundle_launch_risk');
    assert.match(result.outputText, /Doctor details:/);
  });
});
