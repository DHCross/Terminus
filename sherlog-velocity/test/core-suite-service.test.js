const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCoreSuiteService } = require('../../sherlog-vscode/core-suite-service');

describe('rapid iteration core suite service', () => {
  test('runs each configured feature and emits a persisted combined summary', async () => {
    const statusUpdates = [];
    const writtenArtifacts = [];
    const historyRows = [];
    const profileCheckCalls = [];

    const result = await runCoreSuiteService({
      cwd: '/repo',
      features: ['Rapid Iteration: UI', 'Rapid Iteration: Diff'],
      profile: 'rapid',
      vector: 'hygiene',
      paths: {
        runArtifactsDir: '/tmp/sherlog-runs',
        coreSuiteHistoryPath: '/tmp/core-suite-history.jsonl',
      },
    }, {
      nowIso: () => '2026-02-25T18:12:30.100Z',
      onStatus: (text) => statusUpdates.push(text),
      executeProfileCheck: async (input, cwd, options) => {
        profileCheckCalls.push({ input, cwd, options });
        return {
          summary: {
            feature: input.feature,
            doctor_exit_code: 0,
            gaps_exit_code: 0,
            gaps: {
              list: input.feature.includes('UI') ? ['arch_complexity_hotspot'] : [],
            },
          },
          launchRisks: input.feature.includes('UI') ? [{ code: 'ui_launch_risk' }] : [],
        };
      },
      normalizeLaunchRisks: (items) => items,
      buildCoreSuiteReport: ({ id, features, launchRisks, results }) => ({
        id,
        summary: {
          total_runs: features.length,
          failed_runs: 0,
          gap_total: results.reduce((total, entry) => total + (Array.isArray(entry?.gaps?.list) ? entry.gaps.list.length : 0), 0),
          launch_risk_count: launchRisks.length,
        },
      }),
      writeJsonFile: (filePath, value) => writtenArtifacts.push({ filePath, value }),
      appendJsonLineFile: (filePath, value) => historyRows.push({ filePath, value }),
    });

    assert.equal(profileCheckCalls.length, 2);
    assert.equal(profileCheckCalls[0].options.launchRiskSource, 'core_suite');
    assert.deepEqual(statusUpdates, [
      'Running core suite 1/2: Rapid Iteration: UI',
      'Running core suite 2/2: Rapid Iteration: Diff',
    ]);

    assert.equal(writtenArtifacts.length, 1);
    assert.match(writtenArtifacts[0].filePath, /2026-02-25T18-12-30-100Z_core-suite\.combined\.json$/);

    assert.equal(historyRows.length, 1);
    assert.equal(historyRows[0].value.total_runs, 2);
    assert.equal(historyRows[0].value.gap_total, 1);
    assert.equal(historyRows[0].value.launch_risk_count, 1);

    assert.equal(result.launchRisks.length, 1);
    assert.equal(result.suiteReport.summary.total_runs, 2);
    assert.match(result.outputText, /Core Suite Run/);
    assert.match(result.outputText, /Rapid Iteration: UI: ok, gaps=1/);
  });
});
