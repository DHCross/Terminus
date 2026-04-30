const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseArgs,
  buildFingerprint,
  recommendSkills,
  renderSkillMd,
} = require('../src/cli/skills');

test('skills CLI defaults to suggest mode', () => {
  const args = parseArgs(['node', 'skills.js']);
  assert.equal(args.suggest, true);
  assert.equal(args.generate, false);
});

test('skills CLI parses explicit generate options', () => {
  const args = parseArgs(['node', 'skills.js', '--generate', '--output', '.agent/skills', '--force', '--fresh', '--json']);
  assert.equal(args.generate, true);
  assert.equal(args.output, '.agent/skills');
  assert.equal(args.force, true);
  assert.equal(args.fresh, true);
  assert.equal(args.json, true);
});

test('skill recommendations include required preflight and repo-native commands', () => {
  const evidence = {
    self_model: {
      summary: {
        liveness_counts: { Active: 2, Scaffold: 1 },
        fragile_file_count: 1,
        dead_or_scaffold_files: 1,
        total_modules: 12,
      },
    },
    gap_history: [
      { gaps: ['test_coverage', 'stale_context'] },
      { gaps: ['test_coverage'] },
    ],
    hygiene_history: [
      { trends: { overall: 'stable' }, summary: { total_findings: 2 } },
    ],
    context_map: {
      zones: [
        { name: 'Core', belief: 'Main product surface.', ship_ready: true },
      ],
    },
    config: {
      paths: { source_roots: ['src'] },
      context: { mode: 'sherlog-map' },
      settings: {},
    },
  };

  const fingerprint = buildFingerprint(evidence);
  const { recommendations } = recommendSkills(fingerprint, evidence);
  const names = recommendations.map(rec => rec.name);

  assert.ok(names.includes('sherlog-preflight'));
  assert.ok(names.includes('sherlog-gaps'));
  assert.ok(names.includes('sherlog-session'));

  const preflight = renderSkillMd('sherlog-preflight', fingerprint);
  assert.match(preflight, /task verify/);
  assert.match(preflight, /task doctor -- --feature "<Feature Name>"/);
  assert.doesNotMatch(preflight, /vessel\//);
  assert.doesNotMatch(preflight, /task sherlog:/);
});
