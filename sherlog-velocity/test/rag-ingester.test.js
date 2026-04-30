const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-rag-${label}-`));
}

function runIngester(filePath, options = {}) {
  const config = typeof options === 'string' || options === null
    ? { prevFilePath: options }
    : options;
  const scriptPath = path.join(__dirname, '..', '..', 'seed', 'coherence-lab', 'knowledge', 'rag_ingester.py');
  let cmd = `python3 "${scriptPath}" --file "${filePath}"`;
  if (config.prevFilePath) {
    cmd += ` --previous "${config.prevFilePath}"`;
  }
  if (config.stateDir) {
    cmd += ` --state-dir "${config.stateDir}"`;
  }
  if (config.outputMode) {
    cmd += ` --output-mode "${config.outputMode}"`;
  }
  
  const raw = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('RAG Ingester', () => {
  test('ingests new file correctly', () => {
    const tempDir = makeTempDir('new');
    const filePath = path.join(tempDir, 'test.md');
    fs.writeFileSync(filePath, '# Heading 1\nSome content here.\n## Heading 2\nMore content.', 'utf8');

    const result = runIngester(filePath);
    
    assert.equal(result.output_mode, 'full');
    assert.equal(result.title, 'test.md');
    assert.equal(result.domain, 'general');
    assert.equal(typeof result.version_id, 'string');
    assert.equal(result.chunks.length, 2);
    assert.equal(result.chunks[0].section_heading, 'Heading 1');
    assert.equal(result.chunks[0].text, 'Some content here.');
    assert.equal(result.chunks[0].change_type, 'added');
    assert.equal(result.chunks[0].domain, 'general');

    assert.equal(result.chunks[1].section_heading, 'Heading 2');
    assert.equal(result.chunks[1].text, 'More content.');
    assert.deepEqual(result.delta_events.map((event) => event.change_type), ['added', 'added']);
    assert.deepEqual(Object.keys(result.retrieval_profile.routes).sort((left, right) => left.localeCompare(right)), [
      'continuity_recap',
      'quote_retrieval',
      'synthesis_request',
      'theory_lookup',
      'update_diff_request',
    ]);
    assert.equal(result.morning_summary.sources_considered[0], result.source_id);
    assert.equal(result.evaluation_signals.anchor_promotion_count, 0);
    
    fs.rmSync(tempDir, { recursive: true });
  });

  test('diffs against previous version', () => {
    const tempDir = makeTempDir('diff');
    const prevPath = path.join(tempDir, 'test_prev.md');
    const newPath = path.join(tempDir, 'test_new.md');
    
    fs.writeFileSync(prevPath, '# Heading 1\nSome old content.\n## Heading 2\nUnchanged content.', 'utf8');
    fs.writeFileSync(newPath, '# Heading 1\nSome new content.\n## Heading 2\nUnchanged content.\n### Heading 3\nBrand new stuff.', 'utf8');

    const result = runIngester(newPath, prevPath);
    
    assert.equal(result.chunks.length, 3);
    assert.equal(result.supersedes_version_id.length, 16);
    
    // Heading 1 changed
    assert.equal(result.chunks[0].section_heading, 'Heading 1');
    assert.equal(result.chunks[0].is_changed, true);
    assert.equal(result.chunks[0].change_type, 'modified');
    
    // Heading 2 unchanged
    assert.equal(result.chunks[1].section_heading, 'Heading 2');
    assert.equal(result.chunks[1].is_changed, false);
    assert.equal(result.chunks[1].change_type, 'unchanged');
    
    // Heading 3 added
    assert.equal(result.chunks[2].section_heading, 'Heading 3');
    assert.equal(result.chunks[2].is_changed, true);
    assert.equal(result.chunks[2].change_type, 'added');
    assert.deepEqual(result.delta_events.map((event) => event.change_type), ['modified', 'unchanged', 'added']);

    fs.rmSync(tempDir, { recursive: true });
  });

  test('persists version history and auto-diffs from the latest saved artifact', () => {
    const tempDir = makeTempDir('state');
    const stateDir = path.join(tempDir, 'state');
    const filePath = path.join(tempDir, 'notes.md');

    fs.writeFileSync(filePath, '# Notes\nA claim is formed here.', 'utf8');
    const first = runIngester(filePath, { stateDir, outputMode: 'full' });

    fs.writeFileSync(filePath, '# Notes\nA claim is refined here.\n## Delta\nA new section appears.', 'utf8');
    const second = runIngester(filePath, { stateDir, outputMode: 'full' });

    const sourceIndexPath = path.join(stateDir, second.state_store.source_index_path);
    const artifactPath = path.join(stateDir, second.state_store.artifact_path);
    const ingestLogPath = path.join(stateDir, second.state_store.ingest_log_path);
    const sourceIndex = readJson(sourceIndexPath);
    const persistedArtifact = readJson(artifactPath);
    const ingestLogLines = fs.readFileSync(ingestLogPath, 'utf8').trim().split('\n');

    assert.equal(second.supersedes_version_id, first.version_id);
    assert.deepEqual(second.delta_events.map((event) => event.change_type), ['modified', 'added']);
    assert.equal(sourceIndex.latest_version_id, second.version_id);
    assert.equal(sourceIndex.versions.length, 2);
    assert.equal(sourceIndex.latest_snapshot.summary, second.summary);
    assert.equal(sourceIndex.latest_snapshot.morning_summary.summary_id, second.morning_summary.summary_id);
    assert.equal(persistedArtifact.version_id, second.version_id);
    assert.equal(ingestLogLines.length, 2);

    fs.rmSync(tempDir, { recursive: true });
  });

  test('defaults to compact output when state persistence is enabled', () => {
    const tempDir = makeTempDir('compact');
    const stateDir = path.join(tempDir, 'state');
    const filePath = path.join(tempDir, 'notes.md');

    fs.writeFileSync(filePath, '# Notes\nA claim is formed here.\n## Prompting\nWhat should be retained?', 'utf8');
    const result = runIngester(filePath, { stateDir });

    assert.equal(result.output_mode, 'compact');
    assert.equal(result.counts.chunks, 2);
    assert.equal(result.counts.claim_notes > 0, true);
    assert.equal(Array.isArray(result.chunks), false);
    assert.equal(result.state_store.latest_version_id, result.version_id);
    assert.equal(result.highlights.changed_sections.length, 2);
    assert.equal(result.highlights.open_questions[0], 'What should be retained?');

    fs.rmSync(tempDir, { recursive: true });
  });

  test('emits continuity artifacts for theory-like documents', () => {
    const tempDir = makeTempDir('artifacts');
    const filePath = path.join(tempDir, 'coherence-engines.md');
    fs.writeFileSync(
      filePath,
      [
        '# Thesis',
        'A coherence engine is a thesis about how the system should preserve structural honesty.',
        '> Primary research data should stay visible as a warning against drift.',
        'What should the next step measure?',
        '## Audit',
        '[CORRECTION_EVENT] denied: there was no drift; trigger: review of traces; corrected: drift was present in the earlier framing.',
      ].join('\n'),
      'utf8'
    );

    const result = runIngester(filePath);

    assert.equal(result.domain, 'logos_theory');
    assert.equal(result.anchor_notes.length > 0, true);
    assert.equal(result.claim_notes.length > 0, true);
    assert.equal(result.correction_events.length, 1);
    assert.equal(result.research_state.open_questions[0], 'What should the next step measure?');
    assert.equal(result.research_state.correction_events.length, 1);
    assert.equal(result.continuity_cockpit.corrections_to_review.length, 1);
    assert.equal(result.evaluation_signals.contradiction_catch_rate_proxy, 1);
    assert.equal(result.morning_summary.promoted_anchors.length > 0, true);
    assert.equal(result.retrieval_profile.domain, 'logos_theory');

    fs.rmSync(tempDir, { recursive: true });
  });
});
