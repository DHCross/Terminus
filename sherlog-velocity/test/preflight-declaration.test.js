const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lintPlan, checkProvenance } = require('../src/cli/lint-plan');

// ─── helpers (same pattern as friction-reduction.test.js) ────────────────────

function makeRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-declare-${label}-`));
}

function makeConfig(repoRoot, contextZones = null) {
  const cfg = {
    repo_root: repoRoot,
    context: { mode: 'sherlog-map' },
    paths: {},
    settings: { gap_scan_ignore_dirs: [] },
  };

  if (contextZones) {
    const contextPath = path.join(repoRoot, 'sherlog.context.json');
    fs.writeFileSync(contextPath, JSON.stringify({ zones: contextZones }, null, 2), 'utf8');
    cfg.context.map_file = contextPath;
    cfg.paths.context_map = contextPath;
  }

  return cfg;
}

function writeFile(repoRoot, relPath, content) {
  const fullPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function makeVerifiedProvenance(repoRoot) {
  return {
    base_sha: { value: 'abc123', state: 'verified', source: 'git rev-parse HEAD' },
    zone: { value: 'src', state: 'verified', source: 'sherlog.context.json' },
    reused_symbols: { value: ['helper'], state: 'verified', source: 'grep src' },
    new_symbols: { value: [], state: 'verified', source: 'n/a' },
    failure_layer: { value: 'render', state: 'verified', source: 'observed in browser console' },
    red_first_test: { value: 'test/feature.test.js:1', state: 'verified', source: 'observed failing' },
  };
}

// ─── anti-false-alarm regression test ────────────────────────────────────────
// This is the most important test in the suite. A repo with pre-existing
// advisory hazards (any-types, console.logs) plus a fully verified plan must
// be accepted. The gate blocks on missing/unverified declarations, never on
// pre-existing repo hazards.

describe('anti-false-alarm: pre-existing hazards do not block a verified plan', () => {
  test('plan with all-verified provenance is approved despite advisory hazards in the repo', () => {
    const repoRoot = makeRepoRoot('antifalse');

    // Create files with advisory-level code quality issues (any types, console.log)
    // These would trigger type_safety_risk and hygiene_any_abuse gaps in doctor/gaps,
    // but must NOT cause lintPlan to reject a fully verified plan.
    writeFile(repoRoot, 'src/legacy.ts',
      'export function process(data: any): any {\n' +
      '  console.log("debug", data);\n' +
      '  return data;\n' +
      '}\n'
    );
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );

    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'Feature with verified plan',
      provenance: makeVerifiedProvenance(repoRoot),
      steps: [
        { action: 'implement feature handler', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add unit tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'approved',
      'A fully verified plan must be approved even when the repo has pre-existing advisory hazards. ' +
      'The gate blocks on missing/unverified declarations, never on detected repo state.'
    );
    assert.equal(result.issues.filter(i => i.rule === 'unverified_declaration').length, 0,
      'No unverified_declaration issues when all required provenance fields are verified.'
    );
  });
});

// ─── unverified_declaration rule tests ───────────────────────────────────────
// These will fail until the rule is implemented. They define the contract.

describe('unverified_declaration rule', () => {
  test('rejects when provenance is entirely absent', () => {
    const repoRoot = makeRepoRoot('no-provenance');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'No provenance',
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    assert.ok(result.issues.some(i => i.rule === 'unverified_declaration'),
      'Plan without provenance must be rejected with unverified_declaration issue.');
  });

  test('rejects when a required field is assumed', () => {
    const repoRoot = makeRepoRoot('assumed-field');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const provenance = makeVerifiedProvenance(repoRoot);
    provenance.base_sha = { value: 'abc123', state: 'assumed', source: null };

    const plan = {
      feature: 'Assumed base_sha',
      provenance,
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    const issue = result.issues.find(i => i.rule === 'unverified_declaration');
    assert.ok(issue, 'Must have unverified_declaration issue for assumed required field.');
    assert.ok(issue.message.includes('base_sha'),
      'Issue must name the offending field.');
  });

  test('rejects when a required field is unknown', () => {
    const repoRoot = makeRepoRoot('unknown-field');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const provenance = makeVerifiedProvenance(repoRoot);
    provenance.red_first_test = { value: null, state: 'unknown', source: null };

    const plan = {
      feature: 'Unknown red_first_test',
      provenance,
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    const issue = result.issues.find(i => i.rule === 'unverified_declaration');
    assert.ok(issue);
    assert.ok(issue.message.includes('red_first_test'));
  });

  test('rejects when new_symbols is non-empty without justification', () => {
    const repoRoot = makeRepoRoot('new-symbols-no-justification');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const provenance = makeVerifiedProvenance(repoRoot);
    provenance.new_symbols = {
      value: [{ name: 'NewPayload', justification: '' }],
      state: 'verified',
      source: 'agent judgment',
    };

    const plan = {
      feature: 'New symbol without justification',
      provenance,
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    assert.ok(result.issues.some(i => i.rule === 'unverified_declaration'));
  });

  test('accepts when failure_layer is assumed (diagnosis, not fact)', () => {
    const repoRoot = makeRepoRoot('assumed-failure-layer');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const provenance = makeVerifiedProvenance(repoRoot);
    provenance.failure_layer = { value: 'render', state: 'assumed', source: null };

    const plan = {
      feature: 'Assumed failure layer',
      provenance,
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    // failure_layer at assumed is a warning, not a rejection
    assert.notEqual(result.verdict, 'rejected',
      'failure_layer at "assumed" must not reject — it is a diagnosis, not a fact.');
  });

  test('verified without source is a schema error', () => {
    const repoRoot = makeRepoRoot('verified-no-source');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    writeFile(repoRoot, 'test/feature.test.ts',
      "import { feature } from '../src/feature';\n" +
      "import assert from 'node:assert';\n" +
      "test('placeholder', () => { assert.ok(feature); });\n"
    );
    const config = makeConfig(repoRoot);

    const provenance = makeVerifiedProvenance(repoRoot);
    provenance.base_sha = { value: 'abc123', state: 'verified', source: '' };

    const plan = {
      feature: 'Verified without source',
      provenance,
      steps: [
        { action: 'implement feature', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    assert.ok(result.issues.some(i => i.rule === 'unverified_declaration'));
  });
});

// ─── checkProvenance unit tests ──────────────────────────────────────────────

describe('checkProvenance', () => {
  test('returns ledger entries for assumed/unknown fields', () => {
    const plan = {
      feature: 'Test',
      provenance: {
        base_sha: { value: 'abc', state: 'verified', source: 'git' },
        zone: { value: 'src', state: 'verified', source: 'context' },
        reused_symbols: { value: [], state: 'verified', source: 'grep' },
        new_symbols: { value: [], state: 'verified', source: 'n/a' },
        failure_layer: { value: 'render', state: 'assumed', source: null },
        red_first_test: { value: 'test/x.test.js:1', state: 'verified', source: 'observed' },
      },
    };

    const result = checkProvenance(plan);

    // failure_layer at assumed → one ledger entry
    assert.ok(result.ledgerEntries.length >= 1);
    assert.ok(result.ledgerEntries.some(e => e.field === 'failure_layer' && e.state === 'assumed'));
  });

  test('absent provenance returns single rejection issue and no ledger entries', () => {
    const plan = { feature: 'Test', steps: [] };
    const result = checkProvenance(plan);

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].rule, 'unverified_declaration');
    assert.equal(result.ledgerEntries.length, 0);
  });
});

// ─── schema/code drift test ──────────────────────────────────────────────────
// Correction #3: the schema is documentation for external validators; the
// rejecting logic lives in code. This test asserts the two can't drift by
// checking that the schema defines the provenance fields the code checks.

describe('schema/code drift', () => {
  test('plan-input schema defines all fields that checkProvenance validates', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'schemas', 'plan-input.schema.json'), 'utf8')
    );

    const schemaFields = Object.keys(schema.properties?.provenance?.properties || {});
    const codeRequiredFields = ['base_sha', 'zone', 'reused_symbols', 'red_first_test'];
    const codeWarnFields = ['failure_layer'];
    const codeAllFields = [...codeRequiredFields, 'new_symbols', ...codeWarnFields];

    for (const field of codeAllFields) {
      assert.ok(schemaFields.includes(field),
        `Schema must define provenance field "${field}" that code validates. Schema has: [${schemaFields.join(', ')}]`);
    }
  });
});
