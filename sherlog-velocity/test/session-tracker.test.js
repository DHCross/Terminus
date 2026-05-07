const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { SessionTracker } = require('../src/core/session-tracker');

function run(cmd, cwd, env = {}) {
  return execSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initGitRepo(repoRoot) {
  run('git init', repoRoot);
  run('git config user.email "sherlog@test.local"', repoRoot);
  run('git config user.name "Sherlog Test"', repoRoot);
}

function commitAll(repoRoot, message, isoTimestamp) {
  run('git add .', repoRoot);
  const env = isoTimestamp
    ? { GIT_AUTHOR_DATE: isoTimestamp, GIT_COMMITTER_DATE: isoTimestamp }
    : {};
  run(`git commit -m ${JSON.stringify(message)}`, repoRoot, env);
}

describe('SessionTracker', () => {
  const tmpDir = path.join(__dirname, 'tmp_session_test');
  const mockConfig = {
    paths: {
      velocity_log: path.join(tmpDir, 'velocity-log.jsonl'), // Tracker infers data dir from this
    },
  };

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should start a session', () => {
    const tracker = new SessionTracker(mockConfig);
    const session = tracker.start('Test Feature');
    
    assert.strictEqual(session.feature, 'Test Feature');
    assert.ok(session.startTime);
    
    const activePath = path.join(tmpDir, 'active-session.json');
    assert.ok(fs.existsSync(activePath));
    const content = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    assert.strictEqual(content.feature, 'Test Feature');
  });

  it('should not allow starting a second session', () => {
    const tracker = new SessionTracker(mockConfig);
    tracker.start('First');
    
    assert.throws(() => {
        tracker.start('Second');
    }, /Session already active/);
  });

  it('should end a session and log it', (t) => {
    const tracker = new SessionTracker(mockConfig);
    tracker.start('Test Feature');
    
    // Artificial delay or just trust the logic?
    // We can't easily wait 1s in sync test without blocking.
    // Just end it immediately.
    
    const ended = tracker.end();
    assert.strictEqual(ended.feature, 'Test Feature');
    assert.ok(ended.endTime);
    assert.ok(typeof ended.durationSeconds === 'number');

    const activePath = path.join(tmpDir, 'active-session.json');
    assert.ok(!fs.existsSync(activePath), 'Active session file should be gone');

    const logPath = path.join(tmpDir, 'session-log.jsonl');
    assert.ok(fs.existsSync(logPath));
    
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const logEntry = JSON.parse(lines[0]);
    assert.strictEqual(logEntry.feature, 'Test Feature');
  });

  it('should report correct status', () => {
      const tracker = new SessionTracker(mockConfig);
      assert.strictEqual(tracker.status(), null);
      
      tracker.start('Status Check');
      const status = tracker.status();
      assert.strictEqual(status.feature, 'Status Check');
  });

  it('should generate report', () => {
      const tracker = new SessionTracker(mockConfig);
      tracker.start('F1');
      tracker.end();
      tracker.start('F1');
      tracker.end();
      tracker.start('F2');
      tracker.end();

      const report = tracker.generateReport();
      assert.strictEqual(report.length, 2);
      
      const f1 = report.find(r => r.feature === 'F1');
      assert.strictEqual(f1.count, 2);
      
      const f2 = report.find(r => r.feature === 'F2');
      assert.strictEqual(f2.count, 1);
  });

  it('should compute code survival and business telemetry from recent sessions', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-session-intel-'));
    try {
      initGitRepo(repoRoot);
      const dataDir = path.join(repoRoot, 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      const appFile = path.join(repoRoot, 'app.js');
      fs.writeFileSync(appFile, 'const stable = 1;\n', 'utf8');
      commitAll(repoRoot, 'seed baseline', '2026-02-20T10:00:00Z');

      const tracker = new SessionTracker({
        repo_root: repoRoot,
        paths: {
          velocity_log: path.join(dataDir, 'velocity-log.jsonl'),
        },
      });

      tracker.start('Build auth module', 'implementation');
      fs.writeFileSync(appFile, 'const stable = 1;\nconst volatileV1 = 1;\n', 'utf8');
      commitAll(repoRoot, 'add auth module', '2026-02-21T10:00:00Z');
      tracker.end();

      tracker.start('fix auth again', 'debugging');
      fs.writeFileSync(appFile, 'const stable = 1;\nconst volatileV2 = 2;\n', 'utf8');
      commitAll(repoRoot, 'fix auth again', '2026-02-21T03:20:00Z');
      tracker.end();

      tracker.start('Ship dashboard', 'implementation');
      fs.writeFileSync(appFile, 'const stable = 1;\nconst volatileV2 = 2;\nconst dashboard = true;\n', 'utf8');
      commitAll(repoRoot, 'ship dashboard', '2026-02-22T11:00:00Z');
      const ended = tracker.end();

      assert.ok(ended.intelligence, 'session end should include intelligence section');
      assert.strictEqual(ended.intelligence.code_survival.available, true);
      assert.ok(ended.intelligence.code_survival.lines_added >= 2);
      assert.ok(ended.intelligence.code_survival.lines_survived >= 1);
      assert.ok(ended.intelligence.code_survival.lines_rewritten >= 1);
      assert.ok(ended.intelligence.code_survival.survival_rate < 100);

      assert.strictEqual(ended.intelligence.net_synergy.available, true);
      assert.strictEqual(ended.intelligence.net_synergy.delivery_sessions, 2);
      assert.ok(ended.intelligence.net_synergy.rework_sessions >= 1);

      assert.strictEqual(ended.intelligence.frustration_index.available, true);
      assert.ok(ended.intelligence.frustration_index.keyword_hits >= 1);

      const outputFeatures = tracker.generatePromptOutputFeatures();
      assert.strictEqual(outputFeatures.available, true);
      assert.ok(outputFeatures.sample_size >= 3);
      assert.strictEqual(outputFeatures.multiplier.available, true);
      assert.ok(outputFeatures.multiplier.value >= 1);
      assert.ok(outputFeatures.wasted_time_ledger.wasted_hours >= 0);
      assert.ok(Array.isArray(outputFeatures.wasted_time_ledger.top_features));
      assert.ok(outputFeatures.velocity_tracker);
      assert.ok(outputFeatures.velocity_tracker.actual_hours >= outputFeatures.velocity_tracker.apparent_hours);
      assert.ok(Number.isFinite(outputFeatures.velocity_tracker.timeline_drift_pct));
      assert.ok(outputFeatures.boss_ready_report.headline.includes('Velocity tracker'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
