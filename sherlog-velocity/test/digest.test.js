const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDigestFacts, renderDeterministicDigest } = require('../src/core/digest');

test('renderDeterministicDigest turns weekly deltas into founder-readable bullets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-digest-'));
  try {
    const historyPath = path.join(tmpDir, 'gap-history.jsonl');
    const selfModelPath = path.join(tmpDir, 'self-model.json');
    const rows = [
      {
        timestamp: '2026-03-10T12:00:00Z',
        feature: 'Billing Service',
        feature_key: 'billing-service',
        salience: {
          summary: {
            total_score: 40,
            active_gaps: 2,
          },
          ranked: [
            {
              gap: 'test_coverage',
              score: 18,
              persistence: { consecutive_runs: 1, age_days: 7 },
              code_rot_multiplier: 1,
            },
          ],
        },
        evidence: {
          code_index: {
            matched_modules: 2,
            dead_or_scaffold_files: 0,
            misleading_files: 0,
            max_live_days_since_touch: 0,
          },
        },
      },
      {
        timestamp: '2026-03-18T12:00:00Z',
        feature: 'Billing Service',
        feature_key: 'billing-service',
        salience: {
          summary: {
            total_score: 64,
            active_gaps: 3,
            dead_scaffold_feature_files: 2,
            misleading_feature_files: 1,
            code_rot_max_days: 46,
            code_rot_peak_multiplier: 1.8,
          },
          ranked: [
            {
              gap: 'test_coverage',
              score: 28,
              persistence: { consecutive_runs: 3, age_days: 14 },
              code_rot_multiplier: 1.8,
            },
          ],
        },
        evidence: {
          code_index: {
            matched_modules: 3,
            dead_or_scaffold_files: 2,
            misleading_files: 1,
            max_live_days_since_touch: 46,
          },
        },
      },
    ];
    fs.writeFileSync(historyPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(
      selfModelPath,
      JSON.stringify({
        version: 1,
        generated_at: '2026-03-18T12:00:00Z',
        repo_root: tmpDir,
        source_roots: ['src'],
        summary: {
          total_modules: 3,
          total_edges: 2,
          fragile_file_count: 1,
          contract_anchor_count: 0,
          zone_coverage_pct: 0,
          liveness_counts: { Active: 1, Misleading: 1, Scaffold: 1, Dead: 0 },
          dead_or_scaffold_files: 1,
          stale_live_file_count: 1,
        },
        narrative: '',
        modules: [],
        edges: [],
        fragile_files: [],
        dependency_hubs: [],
        contract_anchors: [],
        zone_ownership: { total: 0, covered: 0, unmapped: 0, zones: [] },
        churn_window_days: 14,
        churn_hotspots: [],
        stale_live_files: [{ path: 'src/billing.js', days_since_last_commit: 46, liveness: 'Active' }],
      }, null, 2),
      'utf8'
    );

    const facts = buildDigestFacts({
      repo_root: tmpDir,
      paths: {
        gap_history_log: historyPath,
        self_model_index: selfModelPath,
      },
    }, {
      feature: 'Billing Service',
      window_days: 7,
    });
    const markdown = renderDeterministicDigest(facts);

    assert.equal(facts.comparison_available, true);
    assert.ok(markdown.includes('**Overall Liability:** 📈 Worsened by'));
    assert.ok(markdown.includes('**Code Rot:** 🔴'));
    assert.ok(markdown.includes('**Dead/Scaffold:** 🟢'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
