const assert = require('node:assert/strict');
const test = require('node:test');

const {
  renderAuditReport,
  selectHotFiles,
  buildTopRisks,
  SECTIONS_BY_TIER,
} = require('../src/core/audit-report');

function fixtureInput(overrides = {}) {
  return {
    meta: {
      feature: 'Sample Feature',
      repo_name: 'sample-repo',
      branch: 'main',
      commit: 'abc1234',
      date: '2026-05-02',
      auditor: 'Test Auditor',
      sherlog_version: 'dev',
      node_version: 'v20.0.0',
      commands_run: ['npm run sherlog:doctor -- --feature "Sample Feature" --json'],
      ...overrides.meta,
    },
    doctor: {
      gaps: ['test_coverage', 'arch_complexity_hotspot', 'hygiene_console_log'],
      feature_match_files: [
        { path: 'src/feature.ts', lane: 'strict', triggers: ['token:sample'] },
        { path: 'src/feature.test.ts', lane: 'strict', triggers: ['token:sample'] },
      ],
      source_roots: ['src'],
      docs_root: 'docs',
      context_health: {
        enabled: true,
        mode: 'sherlog-map',
        map_exists: true,
        map_valid: true,
        map_path: '/repo/sherlog.context.json',
        stale_areas: 0,
        drift_areas: 0,
      },
      diagnostics: {
        pass: 2,
        warn: 1,
        fail: 0,
        checks: [
          { id: 'source_roots_available', status: 'pass', message: 'OK' },
          { id: 'context_map_warnings', status: 'warn', message: 'Map emitted 1 warning.' },
        ],
      },
      recommendation: {
        action: 'add_tests',
        rationale: 'Coverage missing on feature surface.',
        commands: ['npm run sherlog:prompt -- "Sample Feature"'],
        priority: 'medium',
      },
      ...overrides.doctor,
    },
    gaps: {
      salience: {
        ranked: [
          {
            gap: 'test_coverage',
            score: 28,
            blast_radius: { level: 2, scope: 'module' },
            persistence: { consecutive_runs: 3 },
          },
          {
            gap: 'arch_complexity_hotspot',
            score: 12,
            blast_radius: { level: 1, scope: 'local' },
            persistence: { consecutive_runs: 1 },
          },
        ],
      },
      evidence: {},
      code_gaps: {
        mode: 'absolute',
        files: [
          {
            file: 'src/feature.ts',
            any: { unsuppressed: 4, suppressed: 0, total: 4 },
            missing_tests: 5,
            complexity: { unsuppressed: 7, suppressed: 0, total: 7 },
          },
          {
            file: 'src/util.ts',
            any: { unsuppressed: 0, suppressed: 0, total: 0 },
            missing_tests: 2,
            complexity: { unsuppressed: 0, suppressed: 0, total: 0 },
          },
        ],
        totals: { total_any: 4, total_missing_tests: 7 },
      },
      ...overrides.gaps,
    },
    blast_radius: overrides.blast_radius || [
      {
        target_file: 'src/feature.ts',
        found: true,
        direct_consumers: ['src/a.ts', 'src/b.ts'],
        transitive_consumers: ['src/c.ts'],
        test_files: ['src/feature.test.ts'],
        do_not_touch: [],
        downstream_count: 4,
        blast_level: 'medium',
      },
    ],
  };
}

test('selectHotFiles picks files by combined risk signal', () => {
  const input = fixtureInput();
  const hot = selectHotFiles(input.gaps, 3);
  assert.equal(hot[0], 'src/feature.ts', 'highest scoring file should come first');
  assert.equal(hot.length, 2, 'all files with non-zero score should be returned (limited)');
});

test('selectHotFiles handles empty input safely', () => {
  assert.deepEqual(selectHotFiles({}, 3), []);
  assert.deepEqual(selectHotFiles({ code_gaps: { files: [] } }, 3), []);
});

test('buildTopRisks ranks salience entries by severity then score', () => {
  const input = fixtureInput();
  const risks = buildTopRisks(input, { tier: 'full' });
  assert.ok(risks.length >= 2);
  assert.equal(risks[0].gap, 'test_coverage', 'High-severity test_coverage should come first');
  assert.equal(risks[0].severity, 'High');
});

test('buildTopRisks caps at 5 for intro tier', () => {
  const input = fixtureInput({
    gaps: {
      salience: {
        ranked: Array.from({ length: 8 }, (_, i) => ({
          gap: `arch_missing_docs_${i}`,
          score: 10 - i,
          blast_radius: { level: 0, scope: 'local' },
          persistence: { consecutive_runs: 1 },
        })),
      },
      code_gaps: { mode: 'absolute', files: [], totals: {} },
      evidence: {},
    },
  });
  const risks = buildTopRisks(input, { tier: 'intro' });
  assert.ok(risks.length <= 5, `intro should cap at 5, got ${risks.length}`);
});

test('renderAuditReport produces only intro sections for intro tier', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'intro' });
  assert.equal(result.tier, 'intro');
  assert.deepEqual(result.sections, SECTIONS_BY_TIER.intro);
  assert.match(result.markdown, /## 1\. Repo summary/);
  assert.match(result.markdown, /## 2\. Top risks/);
  assert.match(result.markdown, /## 6\. AI-agent handoff prompt/);
  assert.match(result.markdown, /## 7\. Recommended next action/);
  assert.match(result.markdown, /## 9\. What this audit did not cover/);
  assert.match(result.markdown, /## 10\. Methodology/);
  assert.doesNotMatch(result.markdown, /## 3\. Stale/);
  assert.doesNotMatch(result.markdown, /## 4\. Missing tests/);
  assert.doesNotMatch(result.markdown, /## 5\. Blast-radius/);
  assert.doesNotMatch(result.markdown, /## 8\. Notes/);
});

test('renderAuditReport produces all 10 sections for full tier', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'full' });
  assert.equal(result.tier, 'full');
  for (let n = 1; n <= 10; n++) {
    assert.match(result.markdown, new RegExp(`## ${n}\\.`), `section ${n} should be present`);
  }
});

test('renderAuditReport defaults to full tier on invalid input', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'bogus' });
  assert.equal(result.tier, 'full');
});

test('renderAuditReport surfaces customer and auditor in header', () => {
  const input = fixtureInput({ meta: { customer: 'Acme Corp', auditor: 'Jane Doe' } });
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /Prepared for:\*\* Acme Corp/);
  assert.match(result.markdown, /Auditor:\*\* Jane Doe/);
});

test('renderAuditReport includes HUMAN_REVIEW markers and reports the count', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'full' });
  assert.ok(result.human_review_count > 0, 'human review markers should be present');
  const matches = result.markdown.match(/<HUMAN_REVIEW:/g) || [];
  assert.equal(result.human_review_count, matches.length);
});

test('renderAuditReport handles empty risks gracefully', () => {
  const input = fixtureInput({
    doctor: {
      gaps: [],
      feature_match_files: [],
      source_roots: ['src'],
      docs_root: 'docs',
      context_health: { enabled: false, mode: 'none', map_exists: false, map_valid: false },
      diagnostics: { pass: 1, warn: 0, fail: 0, checks: [] },
      recommendation: null,
    },
    gaps: {
      salience: { ranked: [] },
      evidence: {},
      code_gaps: { mode: 'absolute', files: [], totals: {} },
    },
    blast_radius: [],
  });
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /No ranked risks surfaced/);
  assert.match(result.markdown, /No hot files surfaced/);
});

test('renderAuditReport handoff prompt is wrapped in a fenced code block', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'full' });
  const handoffMatch = result.markdown.match(/## 6\. AI-agent handoff prompt[\s\S]*?```([\s\S]*?)```/);
  assert.ok(handoffMatch, 'handoff section should contain a fenced code block');
  assert.match(handoffMatch[1], /Sample Feature/, 'prompt should mention the feature name');
});

test('renderAuditReport methodology section lists commands run', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /Sherlog commands run:.*sherlog:doctor/);
});

test('renderAuditReport produces all 10 sections for setup tier', () => {
  const input = fixtureInput();
  const result = renderAuditReport(input, { tier: 'setup' });
  assert.equal(result.tier, 'setup');
  for (let n = 1; n <= 10; n++) {
    assert.match(result.markdown, new RegExp(`## ${n}\\.`), `setup tier should include section ${n}`);
  }
});

test('renderStaleSeams iterates stale_zones and drift_zones when arrays are provided', () => {
  const input = fixtureInput({
    doctor: {
      gaps: ['stale_context'],
      feature_match_files: [],
      source_roots: ['src'],
      docs_root: 'docs',
      context_health: {
        enabled: true,
        mode: 'sherlog-map',
        map_exists: true,
        map_valid: true,
        map_path: '/repo/sherlog.context.json',
        stale_zones: [
          { name: 'auth-zone', path: 'src/auth', reason: 'last touched 90 days ago' },
          { name: 'billing', path: 'src/billing' },
        ],
        drift_zones: [
          { name: 'payments', path: 'src/payments', reason: 'context map references files removed in last commit' },
        ],
      },
      diagnostics: { pass: 1, warn: 0, fail: 0, checks: [] },
      recommendation: null,
    },
  });
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /Stale zones \(2\)/);
  assert.match(result.markdown, /Drifted zones \(1\)/);
  assert.match(result.markdown, /\*\*auth-zone\*\*/);
  assert.match(result.markdown, /`src\/auth`/);
  assert.match(result.markdown, /last touched 90 days ago/);
  assert.match(result.markdown, /\*\*payments\*\*/);
});

test('renderStaleSeams renders Sherlog-shaped entries (area + lag_days)', () => {
  const input = fixtureInput({
    doctor: {
      gaps: ['stale_context'],
      feature_match_files: [],
      source_roots: ['src'],
      docs_root: 'docs',
      context_health: {
        enabled: true,
        mode: 'sherlog-map',
        map_exists: true,
        map_valid: true,
        map_path: '/repo/sherlog.context.json',
        stale_zones: [
          { area: 'Sherlog Production', last_updated: '2026-03-09', lag_days: 54, enforcement: 'required' },
        ],
        drift_zones: [],
      },
      diagnostics: { pass: 1, warn: 0, fail: 0, checks: [] },
      recommendation: null,
    },
  });
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /\*\*Sherlog Production\*\*/);
  assert.match(result.markdown, /54 days lag/);
  assert.match(result.markdown, /last updated 2026-03-09/);
  assert.match(result.markdown, /enforcement: required/);
  assert.doesNotMatch(result.markdown, /\{"area"/, 'should not fall back to raw JSON');
});

test('renderAuditReport falls back to count-only stale-seams when zones not provided', () => {
  const input = fixtureInput({
    doctor: {
      gaps: ['stale_context'],
      feature_match_files: [],
      source_roots: ['src'],
      docs_root: 'docs',
      context_health: {
        enabled: true,
        mode: 'sherlog-map',
        map_exists: true,
        map_valid: true,
        map_path: '/repo/sherlog.context.json',
        stale_areas: 3,
        drift_areas: 1,
      },
      diagnostics: { pass: 1, warn: 0, fail: 0, checks: [] },
      recommendation: null,
    },
  });
  const result = renderAuditReport(input, { tier: 'full' });
  assert.match(result.markdown, /3 stale zone\(s\)/);
  assert.match(result.markdown, /1 drifted zone\(s\)/);
  assert.match(result.markdown, /Per-entry detail was not available/);
});
