const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyzeBlastRadius } = require('../src/cli/blast-radius');
const { lintPlan } = require('../src/cli/lint-plan');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRepoRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-friction-${label}-`));
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

// ─── blast-radius tests ───────────────────────────────────────────────────────

describe('analyzeBlastRadius', () => {
  test('returns found=false for a non-existent file', () => {
    const repoRoot = makeRepoRoot('not-found');
    const config = makeConfig(repoRoot);
    const result = analyzeBlastRadius(config, 'src/missing.ts', 5);

    assert.equal(result.found, false);
    assert.ok(result.error);
    assert.equal(result.downstream_count, 0);
    assert.equal(result.blast_level, 'none');
  });

  test('returns blast_level none for a file with no consumers', () => {
    const repoRoot = makeRepoRoot('no-consumers');
    writeFile(repoRoot, 'src/standalone.ts', 'export const x = 1;\n');
    const config = makeConfig(repoRoot);

    const result = analyzeBlastRadius(config, 'src/standalone.ts', 5);

    assert.equal(result.found, true);
    assert.equal(result.blast_level, 'none');
    assert.equal(result.downstream_count, 0);
    assert.deepEqual(result.direct_consumers, []);
    assert.deepEqual(result.transitive_consumers, []);
  });

  test('identifies direct and transitive consumers via re-export chain', () => {
    const repoRoot = makeRepoRoot('consumers');
    writeFile(repoRoot, 'src/core.ts', 'export const coreUtil = () => {};\n');
    // barrel re-exports coreUtil — this creates the transitive chain
    writeFile(repoRoot, 'src/barrel.ts', 'export { coreUtil } from "./core";\n');
    writeFile(repoRoot, 'src/leaf.ts', 'import { coreUtil } from "./barrel";\nexport const leaf = coreUtil;\n');
    const config = makeConfig(repoRoot);

    const result = analyzeBlastRadius(config, 'src/core.ts', 5);

    assert.equal(result.found, true);
    // barrel.ts is a direct consumer (re-exports from core)
    assert.ok(result.direct_consumers.includes('src/barrel.ts'));
    // leaf.ts imports from barrel, which re-exports from core — transitive
    assert.ok(result.transitive_consumers.includes('src/leaf.ts'));
    assert.ok(result.downstream_count >= 2);
  });

  test('classifies test files separately using file path heuristic', () => {
    const repoRoot = makeRepoRoot('test-classify');
    writeFile(repoRoot, 'src/utils.ts', 'export const helper = () => {};\n');
    writeFile(repoRoot, 'src/__tests__/utils.test.ts', 'import { helper } from "../utils";\n');
    const config = makeConfig(repoRoot);

    const result = analyzeBlastRadius(config, 'src/utils.ts', 5);

    assert.equal(result.found, true);
    assert.ok(result.test_files.some(f => f.includes('utils.test.ts')));
  });

  test('uses context zone to classify test files', () => {
    const repoRoot = makeRepoRoot('zone-classify');
    writeFile(repoRoot, 'src/logic.ts', 'export const compute = () => 42;\n');
    writeFile(repoRoot, 'test/logic.test.ts', 'import { compute } from "../src/logic";\n');

    const zones = [
      { name: 'Tests', paths: ['test/**'], belief: 'Test surface.' },
      { name: 'Source', paths: ['src/**'], belief: 'Production code.' },
    ];
    const config = makeConfig(repoRoot, zones);

    const result = analyzeBlastRadius(config, 'src/logic.ts', 5);

    assert.equal(result.found, true);
    assert.ok(result.test_files.some(f => f.includes('logic.test.ts')));
  });

  test('blast level scales with consumer count', () => {
    const repoRoot = makeRepoRoot('blast-level');
    writeFile(repoRoot, 'src/hub.ts', 'export const hub = () => {};\n');
    // Create 6 consumers to exceed threshold of 5
    for (let i = 0; i < 6; i++) {
      writeFile(repoRoot, `src/consumer${i}.ts`, `import { hub } from "./hub";\nexport const c${i} = hub;\n`);
    }
    const config = makeConfig(repoRoot);

    const result = analyzeBlastRadius(config, 'src/hub.ts', 5);

    assert.equal(result.found, true);
    assert.equal(result.blast_level, 'high');
  });
});

// ─── lint-plan tests ──────────────────────────────────────────────────────────

describe('lintPlan', () => {
  test('approves a well-formed plan with test step', () => {
    const repoRoot = makeRepoRoot('lint-approve');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'My Feature',
      steps: [
        { action: 'implement feature handler', files: ['src/feature.ts'], type: 'implementation' },
        { action: 'add unit tests', files: ['src/__tests__/feature.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'approved');
    assert.equal(result.feature, 'My Feature');
    assert.equal(result.issues.filter(i => i.rule === 'missing_test_coverage').length, 0);
  });

  test('rejects plan with no test step', () => {
    const repoRoot = makeRepoRoot('lint-no-test');
    writeFile(repoRoot, 'src/feature.ts', 'export const feature = () => {};\n');
    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'No Tests',
      steps: [
        { action: 'implement handler', files: ['src/feature.ts'], type: 'implementation' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    assert.ok(result.issues.some(i => i.rule === 'missing_test_coverage'));
  });

  test('rejects plan touching a do_not_touch zone', () => {
    const repoRoot = makeRepoRoot('lint-dnt');
    writeFile(repoRoot, 'legacy/core.ts', 'export const x = 1;\n');

    const zones = [
      { name: 'Legacy', paths: ['legacy/**'], touch_policy: 'do_not_touch', belief: 'Frozen legacy code.' },
    ];
    const config = makeConfig(repoRoot, zones);

    const plan = {
      feature: 'Touch Legacy',
      steps: [
        { action: 'modify legacy', files: ['legacy/core.ts'], type: 'implementation' },
        { action: 'add tests', files: ['test/core.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.verdict, 'rejected');
    assert.ok(result.issues.some(i => i.rule === 'scope_violation'));
  });

  test('warns when file has high blast radius', () => {
    const repoRoot = makeRepoRoot('lint-blast');
    writeFile(repoRoot, 'src/hub.ts', 'export const hub = () => {};\n');
    for (let i = 0; i < 6; i++) {
      writeFile(repoRoot, `src/consumer${i}.ts`, `import { hub } from "./hub";\nexport const c${i} = hub;\n`);
    }
    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'Edit Hub',
      steps: [
        { action: 'refactor hub', files: ['src/hub.ts'], type: 'implementation' },
        { action: 'update tests', files: ['test/hub.test.ts'], type: 'test' },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.ok(['warned', 'approved'].includes(result.verdict));
    const blastIssues = result.issues.filter(i => i.rule === 'high_blast_radius');
    assert.ok(blastIssues.length > 0);
  });

  test('infers test step from action keyword', () => {
    const repoRoot = makeRepoRoot('lint-action-test');
    writeFile(repoRoot, 'src/mod.ts', 'export const mod = () => {};\n');
    const config = makeConfig(repoRoot);

    const plan = {
      feature: 'Mod Feature',
      steps: [
        { action: 'implement mod', files: ['src/mod.ts'] },
        // no "type" field — action contains "test" keyword
        { action: 'write test coverage for mod', files: ['src/mod.test.ts'] },
      ],
    };

    const result = lintPlan(plan, config, 5);

    assert.equal(result.issues.filter(i => i.rule === 'missing_test_coverage').length, 0);
  });
});
