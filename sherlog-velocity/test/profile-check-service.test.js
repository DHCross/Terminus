const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { executeProfileCheckService } = require('../../sherlog-vscode/profile-check-service');

describe('profile check preflight gate', () => {
  test('stops before doctor and gaps when verify fails', async () => {
    const calls = [];

    const result = await executeProfileCheckService({
      feature: 'Verify-first preflight',
      profile: 'rapid',
      vector: 'core',
    }, '/repo', {
      launchRiskSource: 'profile_check',
    }, {
      runTaskProcessPromise: async (args) => {
        calls.push(args);
        if (args[0] === 'verify') {
          const output = JSON.stringify({ summary: { pass: 0, warn: 0, fail: 1 } }, null, 2);
          return { code: 1, output, raw_output: output };
        }
        throw new Error(`unexpected task: ${args[0]}`);
      },
      extractJsonPayload: (text) => JSON.parse(text),
      detectLaunchRisksInPayload: () => {
        throw new Error('launch risk detection should not run when verify fails');
      },
      persistProfileRun: () => ({
        ok: true,
        artifact_path: '/tmp/profile-run.json',
        history_path: '/tmp/profile-history.jsonl',
      }),
    });

    assert.deepEqual(calls, [
      ['verify'],
    ]);
    assert.equal(result.summary.preflight_gate.passed, false);
    assert.equal(result.summary.preflight_gate.stage, 'verify');
    assert.equal(result.summary.doctor_exit_code, 1);
    assert.equal(result.summary.gaps_exit_code, 1);
    assert.deepEqual(result.launchRisks, []);
    assert.match(result.outputText, /Preflight failed at: verify/);
  });

  test('runs verify before doctor and gaps when preflight passes', async () => {
    const calls = [];

    const result = await executeProfileCheckService({
      feature: 'Verify-first preflight',
      profile: 'rapid',
      vector: 'core',
    }, '/repo', {
      launchRiskSource: 'profile_check',
    }, {
      runTaskProcessPromise: async (args) => {
        calls.push(args);
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
              intent: { feature_key: 'verify-first-preflight' },
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
      ['verify'],
      ['doctor', '--', '--feature', 'Verify-first preflight', '--profile', 'rapid', '--vector', 'core'],
      ['gaps', '--', '--feature', 'Verify-first preflight', '--profile', 'rapid', '--vector', 'core'],
    ]);
    assert.equal(result.summary.preflight_gate.passed, true);
    assert.equal(result.summary.doctor_exit_code, 0);
    assert.equal(result.summary.gaps_exit_code, 0);
    assert.equal(result.launchRisks.length, 1);
    assert.equal(result.launchRisks[0].code, 'bundle_launch_risk');
    assert.match(result.outputText, /Doctor details:/);
  });

  test('parses doctor failures from combined raw output when JSON is unavailable', async () => {
    const result = await executeProfileCheckService({
      feature: 'Doctor failure parsing',
      profile: 'rapid',
      vector: 'core',
    }, '/repo', {
      launchRiskSource: 'profile_check',
    }, {
      runTaskProcessPromise: async (args) => {
        if (args[0] === 'verify') {
          const output = JSON.stringify({ summary: { pass: 1, warn: 0, fail: 0 } }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        if (args[0] === 'doctor') {
          return {
            code: 1,
            output: '',
            raw_output: [
              'task: [doctor] node sherlog-velocity/src/cli/doctor.js --feature "Doctor failure parsing" --json',
              'not ok 3 - parses failure text from stderr',
              '  error: Expected values to be strictly equal:',
              'FAIL sherlog-velocity/test/profile-check-service.test.js > profile check > parses doctor failures',
              'AssertionError: expected 1 to equal 0',
            ].join('\n'),
          };
        }
        if (args[0] === 'gaps') {
          const output = JSON.stringify({ gaps: [] }, null, 2);
          return { code: 0, output, raw_output: output };
        }
        throw new Error(`unexpected task: ${args[0]}`);
      },
      extractJsonPayload: (text) => {
        if (!text) return null;
        return JSON.parse(text);
      },
      detectLaunchRisksInPayload: () => [],
      persistProfileRun: () => ({
        ok: true,
        artifact_path: '/tmp/profile-run.json',
        history_path: '/tmp/profile-history.jsonl',
      }),
    });

    assert.equal(result.summary.doctor_exit_code, 1);
    assert.ok(Array.isArray(result.summary.doctor.failures));
    assert.equal(result.summary.doctor.failures.length >= 2, true);
    assert.match(result.outputText, /Parsed failures:/);
    assert.match(result.outputText, /parses failure text from stderr/);
    assert.match(result.outputText, /expected 1 to equal 0/);
  });
});
