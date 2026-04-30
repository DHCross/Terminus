const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `continuity-snapshot-${label}-`));
}

function runPython(modulePath, code, env = {}) {
  return execFileSync('python3', ['-c', code, modulePath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('Continuity Snapshot Tooling', () => {
  test('reads compact persisted continuity snapshots', () => {
    const tempDir = makeTempDir('reader');
    const ragDir = path.join(tempDir, 'continuity', 'rag');
    const sourcesDir = path.join(ragDir, 'sources');
    const modulePath = path.join(__dirname, '..', '..', 'seed', 'coherence-lab', 'plugins', 'reasoning-trace', 'tools', 'trace_tools.py');

    writeJson(path.join(sourcesDir, 'alpha.json'), {
      source_id: 'alpha',
      title: 'Alpha Notes',
      last_ingested_at: '2026-04-30T13:00:00+00:00',
      latest_snapshot: {
        summary: 'Alpha summary',
        morning_summary: {
          promoted_anchors: ['Anchor A'],
          suggested_next_step: 'Measure alpha drift',
        },
        research_state: {
          correction_event_count: 1,
          open_questions: ['What changed in alpha?'],
        },
        continuity_cockpit: {
          what_changed: [
            { section_heading: 'Thesis', change_type: 'modified' },
          ],
          next_action: 'Measure alpha drift',
        },
        evaluation_signals: {
          stale_retrieval_risk: 'low',
        },
      },
    });
    writeJson(path.join(sourcesDir, 'beta.json'), {
      source_id: 'beta',
      title: 'Beta Notes',
      last_ingested_at: '2026-04-30T14:00:00+00:00',
      latest_snapshot: {
        summary: 'Beta summary',
        morning_summary: {
          promoted_anchors: ['Anchor B'],
          suggested_next_step: 'Test beta claim',
        },
        research_state: {
          correction_event_count: 0,
          open_questions: ['What should beta retain?'],
        },
        continuity_cockpit: {
          what_changed: [
            { section_heading: 'Delta', change_type: 'added' },
          ],
          next_action: 'Test beta claim',
        },
        evaluation_signals: {
          stale_retrieval_risk: 'medium',
        },
      },
    });

    const output = runPython(
      modulePath,
      [
        'import importlib.util, sys',
        'module_path = sys.argv[1]',
        'spec = importlib.util.spec_from_file_location("trace_tools", module_path)',
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'print(module.read_continuity_snapshot(limit=1))',
      ].join('; '),
      { TERMINUS_USER_DIR: tempDir }
    );

    assert.match(output, /# Continuity Snapshots/);
    assert.match(output, /Beta Notes \(beta\)/);
    assert.doesNotMatch(output, /Alpha Notes \(alpha\)/);
    assert.match(output, /Changed: Delta \(added\)/);
    assert.match(output, /Next step: Test beta claim/);

    fs.rmSync(tempDir, { recursive: true });
  });

  test('seed installer populates continuity rag snapshots', () => {
    const tempDir = makeTempDir('install');
    const dataDir = path.join(tempDir, 'user');
    const installerPath = path.join(__dirname, '..', '..', 'scripts', 'install-coherence-lab.sh');

    execFileSync(installerPath, [dataDir], {
      encoding: 'utf8',
      env: process.env,
    });

    const sourcesDir = path.join(dataDir, 'continuity', 'rag', 'sources');
    const ingestLogPath = path.join(dataDir, 'continuity', 'rag', 'ingests.jsonl');
    const sourceFiles = fs.readdirSync(sourcesDir);
    const ingestLog = fs.readFileSync(ingestLogPath, 'utf8').trim().split('\n');

    assert.equal(sourceFiles.length > 0, true);
    assert.equal(ingestLog.length > 0, true);

    fs.rmSync(tempDir, { recursive: true });
  });

  test('refresh script updates persisted continuity snapshots without reinstalling seed assets', () => {
    const tempDir = makeTempDir('refresh');
    const dataDir = path.join(tempDir, 'user');
    const knowledgeDir = path.join(tempDir, 'knowledge');
    const refreshScriptPath = path.join(__dirname, '..', '..', 'scripts', 'refresh-continuity-rag.sh');

    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'notes.md'), '# Notes\nA claim is formed here.', 'utf8');

    execFileSync('bash', [refreshScriptPath, dataDir, knowledgeDir], {
      encoding: 'utf8',
      env: process.env,
    });

    fs.writeFileSync(path.join(knowledgeDir, 'notes.md'), '# Notes\nA claim is refined here.\n## Delta\nA new section appears.', 'utf8');

    execFileSync('bash', [refreshScriptPath, dataDir, knowledgeDir], {
      encoding: 'utf8',
      env: process.env,
    });

    const sourcesDir = path.join(dataDir, 'continuity', 'rag', 'sources');
    const sourceFiles = fs.readdirSync(sourcesDir);
    const sourceIndexPath = path.join(sourcesDir, sourceFiles[0]);
    const sourceIndex = readJson(sourceIndexPath);
    const ingestLogPath = path.join(dataDir, 'continuity', 'rag', 'ingests.jsonl');
    const ingestLog = fs.readFileSync(ingestLogPath, 'utf8').trim().split('\n');

    assert.equal(sourceFiles.length, 1);
    assert.equal(sourceIndex.versions.length, 2);
    assert.match(sourceIndex.latest_snapshot.summary, /refined/);
    assert.equal(ingestLog.length, 2);

    fs.rmSync(tempDir, { recursive: true });
  });
});