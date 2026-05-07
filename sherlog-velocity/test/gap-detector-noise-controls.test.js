const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const test = require('node:test');

const { detectGaps } = require('../src/core/gap-detector');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

test('does not flag context_drift for unrelated empty zones', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-noise-zones-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'alignment-corridor.ts'),
      'export const ALIGNMENT_CORRIDOR = "alignment corridor";\n'
    );

    const contextMapPath = path.join(repoRoot, 'sherlog.context.json');
    writeJson(contextMapPath, {
      zones: [
        {
          name: 'Core Source Zone',
          paths: ['src/**/*'],
          belief: 'Primary source.',
          last_updated: '2026-02-01',
        },
        {
          name: 'Legacy Zone',
          paths: ['legacy/**/*'],
          belief: 'Legacy source.',
          last_updated: '2026-02-01',
        },
      ],
    });

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'sherlog-map', map_file: contextMapPath, stale_threshold_days: 1 },
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
        context_map: contextMapPath,
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('AlignmentCorridor', config, { record: false });
    assert.equal(result.gaps.includes('context_drift'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detects tests by content even when filename does not include feature token', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-noise-tests-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'session-flight-recorder.ts'),
      'export function renderFlightRecorder() { return "phase axis"; }\n'
    );
    writeText(
      path.join(repoRoot, 'tests', 'phase-lifecycle.test.ts'),
      'test("phase", () => { const note = "flight recorder axis phase"; expect(note).toBeTruthy(); });\n'
    );

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'none', stale_threshold_days: 1 },
      paths: {
        source_roots: ['src'],
        test_roots: ['tests'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('FlightRecorder Axis Phase', config, { record: false });
    assert.equal(result.evidence?.has_tests, true);
    assert.equal(result.gaps.includes('test_coverage'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('detects docs by content even when filename is generic', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-noise-docs-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'alignment-corridor.ts'),
      'export const ALIGNMENT_CORRIDOR = "alignment corridor";\n'
    );
    writeText(
      path.join(repoRoot, 'docs', 'notes.md'),
      '# Notes\n\nThis section defines alignment corridor behavior.\n'
    );

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'none', stale_threshold_days: 1 },
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('AlignmentCorridor', config, { record: false });
    assert.equal(result.evidence?.has_docs, true);
    assert.equal(result.gaps.includes('documentation'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('code index suppresses generic token overmatch and reports scored feature evidence', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-index-precision-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'sherlog', 'index-sync.ts'),
      'export function syncSherlogIndex() { return true; }\n'
    );
    writeText(
      path.join(repoRoot, 'src', 'sherlog', 'doctor.ts'),
      "import { syncSherlogIndex } from './index-sync';\nexport const sherlogDoctor = syncSherlogIndex;\n"
    );
    writeText(
      path.join(repoRoot, 'src', 'tools', 'code-indexer.ts'),
      'export function buildCodeIndex() { return "generic"; }\n'
    );

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'none', stale_threshold_days: 1 },
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('Sherlog code index precision', config, { record: false });
    const evidence = result.evidence || {};
    const codeIndex = evidence.code_index || {};

    assert.equal(codeIndex.available, true);
    assert.ok(typeof codeIndex.path === 'string' && codeIndex.path.length > 0);
    assert.ok(Array.isArray(codeIndex.indexed_feature_files));
    assert.ok(codeIndex.indexed_feature_files.includes('src/sherlog/index-sync.ts'));
    assert.ok(codeIndex.indexed_feature_files.includes('src/sherlog/doctor.ts'));
    assert.ok(!codeIndex.indexed_feature_files.includes('src/tools/code-indexer.ts'));
    assert.equal(evidence.feature_file_count <= evidence.raw_feature_file_count, true);
    assert.ok(Array.isArray(codeIndex.indexed_feature_matches));
    assert.ok(codeIndex.indexed_feature_matches.some(item => Array.isArray(item.reasons) && item.reasons.length > 0));
    assert.ok(Array.isArray(evidence.matched_feature_files));
    assert.ok(evidence.matched_feature_files.some(item => item.path === 'src/sherlog/index-sync.ts' && Array.isArray(item.triggers) && item.triggers.length > 0));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generic request language does not expand the feature match set', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-generic-feature-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'usability-panel.ts'),
      'export function renderUsabilityPanel() { return "ui"; }\n'
    );
    writeText(
      path.join(repoRoot, 'src', 'improve-flow.ts'),
      'export function improveFlow() { return "flow"; }\n'
    );
    writeText(
      path.join(repoRoot, 'src', 'payments-ledger.ts'),
      'export function reconcileLedger() { return "ledger"; }\n'
    );

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'none', stale_threshold_days: 1 },
      paths: {
        source_roots: ['src'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('Improve usability', config, { record: false });
    assert.equal(result.evidence.feature_file_count, 0);
    assert.equal(result.evidence.raw_feature_file_count, 0);
    assert.deepEqual(result.evidence.matched_feature_files, []);
    assert.deepEqual(result.evidence.code_index.indexed_feature_files, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('ignores retired inspiration folders during scan and indexing', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-retired-scan-'));

  try {
    writeText(
      path.join(repoRoot, 'src', 'payments-engine.ts'),
      'export function paymentsEngine() { return "active"; }\n'
    );
    writeText(
      path.join(repoRoot, 'Inspiration Folder', 'payments-retired.ts'),
      'export function retiredPaymentsConcept() { return "retired"; }\n'
    );

    const config = {
      repo_root: repoRoot,
      bundler: { type: 'none', bundles: [] },
      context: { mode: 'none', stale_threshold_days: 1 },
      paths: {
        source_roots: ['.'],
        docs_dir: 'docs',
      },
      settings: {
        gap_scan_ignore_dirs: [],
      },
    };

    const result = detectGaps('Payments engine', config, { record: false });
    const matchedPaths = result.evidence.matched_feature_files.map(item => item.path);

    assert.ok(matchedPaths.includes('src/payments-engine.ts'));
    assert.ok(!matchedPaths.includes('Inspiration Folder/payments-retired.ts'));
    assert.ok(!result.evidence.code_index.indexed_feature_files.includes('Inspiration Folder/payments-retired.ts'));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
