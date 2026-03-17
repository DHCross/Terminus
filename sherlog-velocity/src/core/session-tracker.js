const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  ensureFile,
  readJson,
  detectBranchHead,
  resolveRuntimeConfig,
} = require('./shared');

const SURVIVAL_LOOKBACK_SESSIONS = 5;
const SYNERGY_LOOKBACK_SESSIONS = 8;
const FRUSTRATION_COMMIT_WINDOW = 30;
const SESSION_OUTPUT_LOOKBACK_SESSIONS = 40;
const REWORK_KEYWORDS = /\b(fix|rework|revert|regress|hotfix|again|broken|bug)\b/i;
const FRUSTRATION_KEYWORDS = ['fix', 'revert', 'again', 'broken', 'wip', 'hotfix', 'hack', 'temp'];
const FRUSTRATION_KEYWORD_PATTERNS = FRUSTRATION_KEYWORDS.map(keyword => ({
  keyword,
  pattern: new RegExp(`\\b${keyword}\\b`, 'i'),
}));

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function average(values) {
  if (!values.length) return 0;
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

function toHours(seconds) {
  const value = Number(seconds || 0);
  return Number((value / 3600).toFixed(2));
}

function isLikelyCommitRef(value) {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());
}

class SessionTracker {
  constructor(config) {
    this.config = resolveRuntimeConfig(config);
    this.repoRoot = this.config.repo_root || process.cwd();
    // Data directory is where velocity_log lives
    const dataDir = path.dirname(this.config.paths.velocity_log);
    this.activeSessionPath = path.resolve(dataDir, '../active-session.json');
    // Keep it inside data directory? 
    // Usually velocity_log is inside data/.
    // Let's check where active-session should go. Putting it in data/ is fine.
    // wait, path.resolve(dataDir, '../active-session.json') puts it in sherlog-velocity/active-session.json
    // I want it in sherlog-velocity/data/active-session.json.
    // dataDir IS /.../sherlog-velocity/data
    this.activeSessionPath = path.join(dataDir, 'active-session.json');
    this.sessionLogPath = path.join(dataDir, 'session-log.jsonl');
  }

  start(feature, type = 'implementation') {
    if (fs.existsSync(this.activeSessionPath)) {
      const current = readJson(this.activeSessionPath);
      // Check if file is valid JSON
      if (current && current.feature) {
          throw new Error(`Session already active for '${current.feature}' (started ${current.startTime}). Please end it first.`);
      }
    }

    const session = {
      feature,
      type,
      startTime: new Date().toISOString(),
      notes: []
    };

    try {
      const { branch, head } = detectBranchHead(this.repoRoot);
      if (branch) session.branch = branch;
      if (head && head !== 'unknown') session.startHead = head;
    } catch (err) {
      // Ignore git errors during session start
    }
    
    // Capture relative path to support monorepo context
    try {
      const relativeCwd = path.relative(this.repoRoot, process.cwd());
      session.cwd = relativeCwd || '.';
    } catch (err) {
      session.cwd = '.';
    }

    ensureFile(this.activeSessionPath);
    fs.writeFileSync(this.activeSessionPath, JSON.stringify(session, null, 2), 'utf8');
    return session;
  }

  addNote(text) {
    if (!fs.existsSync(this.activeSessionPath)) {
      throw new Error('No active session found.');
    }
    const session = readJson(this.activeSessionPath);
    if (!session) throw new Error('Active session file is corrupt.');

    const note = {
      timestamp: new Date().toISOString(),
      text
    };
    
    // Ensure notes array exists (migration for active sessions started before update)
    if (!session.notes) session.notes = [];
    session.notes.push(note);
    
    fs.writeFileSync(this.activeSessionPath, JSON.stringify(session, null, 2), 'utf8');
    return note;
  }

  updateSession(updates) {
    if (!fs.existsSync(this.activeSessionPath)) {
      throw new Error('No active session found.');
    }
    const session = readJson(this.activeSessionPath);
    if (!session) throw new Error('Active session file is corrupt.');

    const updatedSession = { ...session, ...updates };
    
    fs.writeFileSync(this.activeSessionPath, JSON.stringify(updatedSession, null, 2), 'utf8');
    return updatedSession;
  }

  end() {
    if (!fs.existsSync(this.activeSessionPath)) {
      throw new Error('No active session found.');
    }

    const session = readJson(this.activeSessionPath);
    if (!session || !session.startTime) {
        // Corrupt file? Cleanup
        fs.unlinkSync(this.activeSessionPath);
        throw new Error('Active session file was corrupt and has been cleared.');
    }

    const endTime = new Date().toISOString();
    const start = new Date(session.startTime);
    const end = new Date(endTime);
    // duration in seconds
    const durationSeconds = (end - start) / 1000;

    const entry = {
      ...session,
      endTime,
      durationSeconds,
    };

    try {
      const { branch, head } = detectBranchHead(this.repoRoot);
      if (branch && branch !== 'unknown') entry.endBranch = branch;
      if (head && head !== 'unknown') entry.endHead = head;
    } catch (err) {
      // Ignore git errors during session end
    }

    const previousSessions = this.getSessions();
    entry.intelligence = this._buildSessionIntelligence(previousSessions, entry);

    ensureFile(this.sessionLogPath);
    fs.appendFileSync(this.sessionLogPath, JSON.stringify(entry) + '\n', 'utf8');
    fs.unlinkSync(this.activeSessionPath);

    return entry;
  }

  status() {
    if (!fs.existsSync(this.activeSessionPath)) return null;
    return readJson(this.activeSessionPath);
  }

  getSessions() {
    if (!fs.existsSync(this.sessionLogPath)) return [];
    return fs.readFileSync(this.sessionLogPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
          try { return JSON.parse(line); } catch(e) { return null; }
      })
      .filter(Boolean);
  }

  generateReport() {
    const sessions = this.getSessions();
    const summary = {};

    sessions.forEach(s => {
      if (!summary[s.feature]) {
        summary[s.feature] = { count: 0, totalSeconds: 0, lastSession: s.startTime };
      }
      summary[s.feature].count++;
      summary[s.feature].totalSeconds += s.durationSeconds;
      if (s.endTime > summary[s.feature].lastSession) {
          summary[s.feature].lastSession = s.startTime; // Using start time as recency marker? Or end time.
      }
    });

    return Object.entries(summary).map(([feature, data]) => ({
      feature,
      ...data,
      totalHours: (data.totalSeconds / 3600).toFixed(2)
    }));
  }

  generatePromptOutputFeatures(options = {}) {
    const lookback = Number.isFinite(options.lookbackSessions)
      ? Math.max(1, Math.floor(options.lookbackSessions))
      : SESSION_OUTPUT_LOOKBACK_SESSIONS;
    const sessions = this.getSessions()
      .filter(session => session && session.endTime)
      .slice(-lookback);

    if (!sessions.length) {
      return {
        available: false,
        lookback_sessions: lookback,
        sample_size: 0,
        multiplier: {
          available: false,
          value: null,
          implementation_hours: 0,
          invisible_hours: 0,
        },
        wasted_time_ledger: {
          total_hours: 0,
          wasted_hours: 0,
          wasted_ratio: 0,
          top_features: [],
        },
        velocity_tracker: {
          apparent_hours: 0,
          actual_hours: 0,
          timeline_drift_hours: 0,
          timeline_drift_pct: 0,
          estimate_bias_multiplier: null,
        },
        boss_ready_report: {
          headline: 'No closed sessions yet. Start using session tracking to build an evidence baseline.',
          bullets: [
            'No multiplier yet — not enough completed sessions.',
            'No wasted-time ledger entries yet.',
          ],
        },
      };
    }

    let implementationSeconds = 0;
    let invisibleSeconds = 0;
    let totalSeconds = 0;
    let wastedSeconds = 0;
    const byFeature = new Map();

    sessions.forEach(session => {
      const type = String(session.type || 'implementation').toLowerCase();
      const feature = String(session.feature || 'unknown feature').trim() || 'unknown feature';
      const duration = Math.max(0, Number(session.durationSeconds || 0));
      const noteText = Array.isArray(session.notes)
        ? session.notes.map(note => String(note?.text || '')).join(' ')
        : '';
      const signalText = `${feature} ${noteText}`;

      totalSeconds += duration;
      if (type === 'implementation') {
        implementationSeconds += duration;
      }
      if (type === 'discovery' || type === 'debugging') {
        invisibleSeconds += duration;
      }

      const isWasted = type === 'debugging' || REWORK_KEYWORDS.test(signalText);
      if (isWasted) {
        wastedSeconds += duration;
      }

      if (!byFeature.has(feature)) {
        byFeature.set(feature, {
          feature,
          total_seconds: 0,
          wasted_seconds: 0,
          sessions: 0,
          debugging_sessions: 0,
          discovery_sessions: 0,
          implementation_sessions: 0,
        });
      }

      const row = byFeature.get(feature);
      row.total_seconds += duration;
      row.sessions += 1;
      if (isWasted) row.wasted_seconds += duration;
      if (type === 'debugging') row.debugging_sessions += 1;
      if (type === 'discovery') row.discovery_sessions += 1;
      if (type === 'implementation') row.implementation_sessions += 1;
    });

    const multiplierValue = implementationSeconds > 0
      ? Number((1 + (invisibleSeconds / implementationSeconds)).toFixed(2))
      : null;

    const topFeatures = Array.from(byFeature.values())
      .filter(item => item.total_seconds > 0)
      .map(item => {
        const wastedRatio = item.total_seconds > 0 ? (item.wasted_seconds / item.total_seconds) : 0;
        return {
          feature: item.feature,
          sessions: item.sessions,
          total_hours: toHours(item.total_seconds),
          wasted_hours: toHours(item.wasted_seconds),
          wasted_ratio: Number((wastedRatio * 100).toFixed(1)),
          debugging_sessions: item.debugging_sessions,
          discovery_sessions: item.discovery_sessions,
          implementation_sessions: item.implementation_sessions,
        };
      })
      .sort((a, b) => {
        if (b.wasted_hours !== a.wasted_hours) return b.wasted_hours - a.wasted_hours;
        return b.total_hours - a.total_hours;
      })
      .slice(0, 5);

    const totalHours = toHours(totalSeconds);
    const wastedHours = toHours(wastedSeconds);
    const wastedRatioPct = totalSeconds > 0 ? Number(((wastedSeconds / totalSeconds) * 100).toFixed(1)) : 0;
    const apparentHours = toHours(implementationSeconds);
    const actualHours = toHours(implementationSeconds + invisibleSeconds);
    const timelineDriftHours = toHours(Math.max(0, actualHours - apparentHours));
    const timelineDriftPct = apparentHours > 0
      ? Number((((actualHours - apparentHours) / apparentHours) * 100).toFixed(1))
      : 0;
    const estimateBiasMultiplier = multiplierValue;

    const multiplierText = multiplierValue === null
      ? 'n/a'
      : `${multiplierValue}x`;

    const headline = `Velocity tracker: AI timeline bias ${multiplierText}; wasted time ${wastedRatioPct}% over the last ${sessions.length} sessions.`;
    const bullets = [
      `Timeline reality check: ${apparentHours}h looked like delivery, ${actualHours}h was real effort (${timelineDriftHours}h drift).`,
      `Total tracked time: ${totalHours}h (${toHours(invisibleSeconds)}h discovery/debugging).`,
      `Estimated wasted/rework time: ${wastedHours}h (${wastedRatioPct}%).`,
    ];
    if (topFeatures.length > 0) {
      const top = topFeatures[0];
      bullets.push(`Top drag area: ${top.feature} (${top.wasted_hours}h wasted across ${top.sessions} sessions).`);
    }

    return {
      available: true,
      lookback_sessions: lookback,
      sample_size: sessions.length,
      multiplier: {
        available: multiplierValue !== null,
        value: multiplierValue,
        implementation_hours: toHours(implementationSeconds),
        invisible_hours: toHours(invisibleSeconds),
      },
      wasted_time_ledger: {
        total_hours: totalHours,
        wasted_hours: wastedHours,
        wasted_ratio: wastedRatioPct,
        top_features: topFeatures,
      },
      velocity_tracker: {
        apparent_hours: apparentHours,
        actual_hours: actualHours,
        timeline_drift_hours: timelineDriftHours,
        timeline_drift_pct: timelineDriftPct,
        estimate_bias_multiplier: estimateBiasMultiplier,
      },
      boss_ready_report: {
        headline,
        bullets,
      },
    };
  }

  _buildSessionIntelligence(previousSessions, currentEntry) {
    const completedSessions = previousSessions.filter(session => session && session.endTime);
    return {
      code_survival: this._computeCodeSurvival(completedSessions, SURVIVAL_LOOKBACK_SESSIONS),
      net_synergy: this._computeNetSynergy(completedSessions.concat(currentEntry), SYNERGY_LOOKBACK_SESSIONS),
      frustration_index: this._computeFrustrationIndex(FRUSTRATION_COMMIT_WINDOW),
    };
  }

  _computeCodeSurvival(completedSessions, lookbackSessions = SURVIVAL_LOOKBACK_SESSIONS) {
    if (!this._canRunGit()) {
      return {
        available: false,
        reason: 'git_unavailable',
        lookback_sessions: lookbackSessions,
        analyzed_sessions: 0,
        lines_added: 0,
        lines_survived: 0,
        lines_rewritten: 0,
        survival_rate: null,
        hotspots: [],
      };
    }

    const candidates = completedSessions.slice(-lookbackSessions);
    if (!candidates.length) {
      return {
        available: false,
        reason: 'insufficient_history',
        lookback_sessions: lookbackSessions,
        analyzed_sessions: 0,
        lines_added: 0,
        lines_survived: 0,
        lines_rewritten: 0,
        survival_rate: null,
        hotspots: [],
      };
    }

    const currentLineCache = new Map();
    const churnByFile = new Map();
    let analyzedSessions = 0;
    let linesAdded = 0;
    let linesSurvived = 0;

    candidates.forEach(session => {
      const startRef = this._resolveSessionStartRef(session);
      const endRef = this._resolveSessionEndRef(session);
      if (!startRef || !endRef || startRef === endRef) return;

      const additions = this._collectAddedLinesByFile(startRef, endRef);
      if (additions.total_added <= 0) return;

      analyzedSessions += 1;
      linesAdded += additions.total_added;

      additions.files.forEach((lineCounts, filePath) => {
        const currentCounts = this._getCurrentFileLineCounts(filePath, currentLineCache);
        lineCounts.forEach((addedCount, lineText) => {
          const currentCount = currentCounts.get(lineText) || 0;
          const survivedCount = Math.min(addedCount, currentCount);
          const rewrittenCount = addedCount - survivedCount;
          linesSurvived += survivedCount;
          if (rewrittenCount > 0) addCount(churnByFile, filePath, rewrittenCount);
        });
      });
    });

    const linesRewritten = Math.max(0, linesAdded - linesSurvived);
    const available = linesAdded > 0;
    const survivalRate = available ? Number(((linesSurvived / linesAdded) * 100).toFixed(1)) : null;
    const hotspots = Array.from(churnByFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([file, rewrittenLines]) => ({
        file,
        rewritten_lines: rewrittenLines,
      }));

    return {
      available,
      reason: available ? null : 'no_committed_additions',
      lookback_sessions: lookbackSessions,
      analyzed_sessions: analyzedSessions,
      lines_added: linesAdded,
      lines_survived: linesSurvived,
      lines_rewritten: linesRewritten,
      survival_rate: survivalRate,
      hotspots,
    };
  }

  _computeNetSynergy(completedSessions, lookbackSessions = SYNERGY_LOOKBACK_SESSIONS) {
    const recent = completedSessions.filter(session => session && session.endTime).slice(-lookbackSessions);
    if (!recent.length) {
      return {
        available: false,
        reason: 'insufficient_history',
        lookback_sessions: lookbackSessions,
        delivery_sessions: 0,
        rework_sessions: 0,
        net_sessions: 0,
        momentum: 'flat',
      };
    }

    let deliverySessions = 0;
    let reworkSessions = 0;
    let discoverySessions = 0;
    let debuggingSessions = 0;

    recent.forEach(session => {
      const type = String(session.type || 'implementation').toLowerCase();
      const noteText = Array.isArray(session.notes)
        ? session.notes.map(note => String(note?.text || '')).join(' ')
        : '';
      const signalText = `${session.feature || ''} ${noteText}`;

      if (type === 'discovery') discoverySessions += 1;
      if (type === 'debugging') debuggingSessions += 1;

      if (type === 'implementation' || type === 'discovery') {
        deliverySessions += 1;
      }
      if (type === 'debugging' || REWORK_KEYWORDS.test(signalText)) {
        reworkSessions += 1;
      }
    });

    const netSessions = deliverySessions - reworkSessions;
    const momentum = netSessions > 0 ? 'positive' : (netSessions < 0 ? 'negative' : 'flat');

    return {
      available: true,
      reason: null,
      lookback_sessions: lookbackSessions,
      delivery_sessions: deliverySessions,
      rework_sessions: reworkSessions,
      net_sessions: netSessions,
      discovery_sessions: discoverySessions,
      debugging_sessions: debuggingSessions,
      momentum,
    };
  }

  _computeFrustrationIndex(commitWindow = FRUSTRATION_COMMIT_WINDOW) {
    if (!this._canRunGit()) {
      return {
        available: false,
        reason: 'git_unavailable',
        commit_window: commitWindow,
        recent_commits: 0,
        score: 0,
        level: 'low',
        keyword_hits: 0,
        odd_hour_commits: 0,
        short_subject_commits: 0,
        subject_length_delta: 0,
        keyword_breakdown: {},
      };
    }

    let raw = '';
    try {
      raw = runGit(this.repoRoot, [
        'log',
        '-n',
        String(commitWindow),
        '--date=iso-strict',
        '--pretty=format:%h%x1f%aI%x1f%s',
      ]);
    } catch (err) {
      raw = '';
    }

    if (!raw) {
      return {
        available: false,
        reason: 'no_commits',
        commit_window: commitWindow,
        recent_commits: 0,
        score: 0,
        level: 'low',
        keyword_hits: 0,
        odd_hour_commits: 0,
        short_subject_commits: 0,
        subject_length_delta: 0,
        keyword_breakdown: {},
      };
    }

    const rows = raw.split(/\r?\n/).map(line => {
      const [sha, date, subject] = line.split('\u001f');
      return {
        sha: String(sha || '').trim(),
        date: String(date || '').trim(),
        subject: String(subject || '').trim(),
      };
    }).filter(row => row.sha && row.date);

    if (!rows.length) {
      return {
        available: false,
        reason: 'no_commits',
        commit_window: commitWindow,
        recent_commits: 0,
        score: 0,
        level: 'low',
        keyword_hits: 0,
        odd_hour_commits: 0,
        short_subject_commits: 0,
        subject_length_delta: 0,
        keyword_breakdown: {},
      };
    }

    let keywordHits = 0;
    let oddHourCommits = 0;
    let shortSubjectCommits = 0;
    const keywordBreakdown = {};
    const subjectLengths = [];

    rows.forEach(row => {
      const subject = row.subject;
      const subjectLower = subject.toLowerCase();
      subjectLengths.push(subject.length);

      const matchedKeywords = FRUSTRATION_KEYWORD_PATTERNS
        .filter(entry => entry.pattern.test(subjectLower))
        .map(entry => entry.keyword);
      if (matchedKeywords.length > 0) {
        keywordHits += 1;
        matchedKeywords.forEach(keyword => {
          keywordBreakdown[keyword] = (keywordBreakdown[keyword] || 0) + 1;
        });
      }

      if (subject.length <= 18) {
        shortSubjectCommits += 1;
      }

      const timestamp = new Date(row.date);
      if (!Number.isNaN(timestamp.getTime())) {
        const hour = timestamp.getHours();
        if (hour >= 1 && hour <= 5) oddHourCommits += 1;
      }
    });

    const orderedLengths = subjectLengths.slice().reverse();
    const midpoint = Math.max(1, Math.floor(orderedLengths.length / 2));
    const earlierAverage = average(orderedLengths.slice(0, midpoint));
    const laterAverage = average(orderedLengths.slice(midpoint));
    const subjectLengthDelta = Number((laterAverage - earlierAverage).toFixed(1));

    const total = rows.length;
    const keywordRate = keywordHits / total;
    const oddHourRate = oddHourCommits / total;
    const shortSubjectRate = shortSubjectCommits / total;

    let score = Math.round(
      (keywordRate * 55) +
      (oddHourRate * 20) +
      (shortSubjectRate * 20)
    );
    if (subjectLengthDelta < -4) score += 5;
    score = Math.max(0, Math.min(100, score));

    const level = score >= 60 ? 'high' : (score >= 35 ? 'moderate' : 'low');

    return {
      available: true,
      reason: null,
      commit_window: commitWindow,
      recent_commits: total,
      score,
      level,
      keyword_hits: keywordHits,
      odd_hour_commits: oddHourCommits,
      short_subject_commits: shortSubjectCommits,
      subject_length_delta: subjectLengthDelta,
      keyword_breakdown: keywordBreakdown,
    };
  }

  _collectAddedLinesByFile(startRef, endRef) {
    let raw = '';
    try {
      raw = runGit(this.repoRoot, [
        'diff',
        '--unified=0',
        '--no-color',
        '--diff-filter=AM',
        startRef,
        endRef,
        '--',
      ]);
    } catch (err) {
      raw = '';
    }

    if (!raw) return { files: new Map(), total_added: 0 };

    let currentFile = null;
    let totalAdded = 0;
    const files = new Map();
    const lines = raw.split(/\r?\n/);

    lines.forEach(line => {
      if (line.startsWith('+++ b/')) {
        const filePath = line.slice('+++ b/'.length).trim();
        currentFile = filePath && filePath !== '/dev/null' ? filePath : null;
        return;
      }

      if (!currentFile) return;
      if (!line.startsWith('+') || line.startsWith('+++')) return;

      const addedLine = line.slice(1);
      if (!addedLine.trim()) return;

      if (!files.has(currentFile)) files.set(currentFile, new Map());
      const lineCounts = files.get(currentFile);
      addCount(lineCounts, addedLine, 1);
      totalAdded += 1;
    });

    return { files, total_added: totalAdded };
  }

  _getCurrentFileLineCounts(filePath, cache) {
    if (cache.has(filePath)) return cache.get(filePath);

    const fullPath = path.join(this.repoRoot, filePath);
    const counts = new Map();
    if (!fs.existsSync(fullPath)) {
      cache.set(filePath, counts);
      return counts;
    }

    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    lines.forEach(line => {
      if (!line.trim()) return;
      addCount(counts, line, 1);
    });

    cache.set(filePath, counts);
    return counts;
  }

  _resolveSessionStartRef(session) {
    if (isLikelyCommitRef(session.startHead)) return session.startHead;
    return this._resolveRefBefore(session.startTime);
  }

  _resolveSessionEndRef(session) {
    if (isLikelyCommitRef(session.endHead)) return session.endHead;
    return this._resolveRefBefore(session.endTime);
  }

  _resolveRefBefore(timestamp) {
    if (!timestamp) return null;
    try {
      return runGit(this.repoRoot, ['rev-list', '-n', '1', `--before=${timestamp}`, 'HEAD']) || null;
    } catch (err) {
      return null;
    }
  }

  _canRunGit() {
    if (!this.repoRoot || !fs.existsSync(this.repoRoot)) return false;
    try {
      runGit(this.repoRoot, ['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch (err) {
      return false;
    }
  }
}

module.exports = { SessionTracker };
