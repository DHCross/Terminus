const fs = require('fs');
const path = require('path');
const {
  readJson,
  readJsonLines,
  ensureFile,
  resolveRuntimeConfig,
} = require('./shared');
const { detectSourceRoots: detectInstalledSourceRoots } = require('../../install');

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  todo_cluster_threshold: 3,
  console_log_max: 0,
  any_usage_threshold: 5,
  monolith_line_threshold: 500,
  monolith_size_kb_threshold: 150,
  missing_docs_line_threshold: 100,
  nesting_depth_threshold: 5,
};

const SCANNABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
]);

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.repomix',
  'sherlog-velocity',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
]);

const DEFAULT_IGNORED_PREFIXES = [
  '.claude/worktrees',
];

const CONSOLE_SKIP_SEGMENTS = ['test/', 'tests/', '__tests__/', 'scripts/'];

const ALL_FINDING_TYPES = ['todo_cluster', 'console_log', 'excessive_any', 'monolith', 'monolith_size', 'missing_docs', 'nesting_depth'];

const THRESHOLD_MAP = {
  todo_cluster: 'todo_cluster_threshold',
  console_log: 'console_log_max',
  excessive_any: 'any_usage_threshold',
  monolith: 'monolith_line_threshold',
  monolith_size: 'monolith_size_kb_threshold',
  missing_docs: 'missing_docs_line_threshold',
  nesting_depth: 'nesting_depth_threshold',
};

const SUPPRESSION_PATTERN = /eslint-disable|@ts-ignore|@ts-expect-error/;

const MIN_HISTORY_FOR_TRENDS = 2;
const MIN_HISTORY_FOR_TUNING = 5;
const TREND_BAND = 0.2;

// ── Walk utilities (mirrored from gap-detector.js) ───────────────────

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeIgnorePrefix(value) {
  let normalized = normalizePath(value).replace(/\/\*\*?$/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return null;

  const lower = normalized.toLowerCase();
  const marker = '/worktrees/';
  const markerIndex = lower.indexOf(marker);
  if (markerIndex >= 0) {
    normalized = normalized.slice(0, markerIndex + marker.length - 1);
  }

  return normalized.toLowerCase();
}

function normalizeIgnoreEntry(repoRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let candidate = raw;
  if (path.isAbsolute(raw)) {
    const rel = normalizePath(path.relative(repoRoot, raw));
    if (!rel || rel.startsWith('..')) return null;
    candidate = rel;
  }

  return normalizeIgnorePrefix(candidate);
}

function ignoredDirsForConfig(config, repoRoot) {
  const dynamic = Array.isArray(config?.settings?.gap_scan_ignore_dirs)
    ? config.settings.gap_scan_ignore_dirs.map(item => normalizeIgnoreEntry(repoRoot, item)).filter(Boolean)
    : [];

  const names = new Set(Array.from(DEFAULT_IGNORED_DIRS).map(name => String(name).toLowerCase()));
  const prefixes = new Set(DEFAULT_IGNORED_PREFIXES.map(item => normalizeIgnorePrefix(item)).filter(Boolean));

  dynamic.forEach(entry => {
    if (entry.includes('/')) prefixes.add(entry);
    else names.add(entry);
  });

  return {
    names,
    prefixes: Array.from(prefixes).sort((a, b) => a.localeCompare(b)),
  };
}

function isPathUnderPrefix(relPath, prefix) {
  return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

function shouldIgnoreDir(repoRoot, fullPath, entryName, ignoreRules) {
  if (ignoreRules?.names?.has(String(entryName).toLowerCase())) return true;

  const rel = normalizePath(path.relative(repoRoot, fullPath)).toLowerCase();
  if (!rel || rel.startsWith('..')) return false;

  return Array.isArray(ignoreRules?.prefixes)
    ? ignoreRules.prefixes.some(prefix => isPathUnderPrefix(rel, prefix))
    : false;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root, visit, limit = 120000, ignoreRules = { names: DEFAULT_IGNORED_DIRS, prefixes: [] }, repoRoot = root) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReadDir(current);

    for (const entry of entries) {
      if (seen++ > limit) return;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldIgnoreDir(repoRoot, fullPath, entry.name, ignoreRules)) stack.push(fullPath);
        continue;
      }
      visit(fullPath, entry.name.toLowerCase());
    }
  }
}

function findExistingRoots(repoRoot, configuredRoots = [], defaults = []) {
  const candidates = new Set([...(configuredRoots || []), ...defaults]);
  return Array.from(candidates)
    .map(name => path.join(repoRoot, name))
    .filter(full => fs.existsSync(full) && fs.statSync(full).isDirectory());
}

function findSourceRoots(repoRoot, configuredRoots = []) {
  const configured = findExistingRoots(repoRoot, configuredRoots);
  if (configured.length > 0) return configured;

  const discovered = detectInstalledSourceRoots(repoRoot);
  if (discovered.length > 0) {
    return discovered.map(relPath => path.join(repoRoot, relPath));
  }

  return findExistingRoots(repoRoot, [], ['src', 'lib', 'app', 'server', 'services', 'packages']);
}

function findDocsRoot(repoRoot, config) {
  const configured = config?.paths?.docs_dir;
  if (configured) {
    const candidate = path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }

  const defaults = ['docs', 'documentation', 'wiki'];
  for (const dir of defaults) {
    const candidate = path.join(repoRoot, dir);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }

  return null;
}

// ── Threshold resolution ─────────────────────────────────────────────

function resolveThresholds(config) {
  const hygiene = config?.settings?.hygiene || {};
  return { ...DEFAULT_THRESHOLDS, ...hygiene };
}

// ── Per-file checks ──────────────────────────────────────────────────

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*');
}

function isInConsoleSkipPath(relPath) {
  const lower = relPath.toLowerCase();
  return CONSOLE_SKIP_SEGMENTS.some(seg => lower.includes(seg));
}

function checkTodoCluster(lines, thresholds) {
  const todoPattern = /\b(TODO|FIXME|HACK|XXX)\b/i;
  const todoLines = [];
  lines.forEach((line, idx) => {
    if (isCommentLine(line) && todoPattern.test(line)) todoLines.push(idx + 1);
  });
  if (todoLines.length >= thresholds.todo_cluster_threshold) {
    return { type: 'todo_cluster', count: todoLines.length, lines: todoLines };
  }
  return null;
}

function checkConsoleLog(lines, relPath, thresholds) {
  if (isInConsoleSkipPath(relPath)) return null;
  const consolePattern = /\bconsole\.log\s*\(/;
  const consoleLines = [];
  lines.forEach((line, idx) => {
    if (consolePattern.test(line)) consoleLines.push(idx + 1);
  });
  if (consoleLines.length > thresholds.console_log_max) {
    return { type: 'console_log', count: consoleLines.length, lines: consoleLines };
  }
  return null;
}

function checkExcessiveAny(lines, lowerName, thresholds) {
  if (!lowerName.endsWith('.ts') && !lowerName.endsWith('.tsx')) return null;
  const anyTypePattern = /:\s*any\b|<any[>,\s]|\bas\s+any\b|\bany\s*\[|\bany\s*\||\|\s*any\b/;
  const suppressionByLine = lines.map(line => SUPPRESSION_PATTERN.test(line));
  const unsuppressed = [];
  const suppressed = [];

  lines.forEach((line, idx) => {
    if (!anyTypePattern.test(line)) return;
    if (idx > 0 && suppressionByLine[idx - 1]) {
      suppressed.push(idx + 1);
      return;
    }
    unsuppressed.push(idx + 1);
  });

  if (unsuppressed.length >= thresholds.any_usage_threshold) {
    return {
      type: 'excessive_any',
      count: unsuppressed.length,
      total_count: unsuppressed.length + suppressed.length,
      suppressed_count: suppressed.length,
      lines: unsuppressed,
      suppressed_lines: suppressed,
    };
  }
  return null;
}

function checkMonolithLines(lines, thresholds) {
  if (lines.length > thresholds.monolith_line_threshold) {
    return { type: 'monolith', lines: lines.length };
  }
  return null;
}

function checkMonolithSize(fullPath, thresholds) {
  try {
    const stats = fs.statSync(fullPath);
    const sizeKb = stats.size / 1024;
    if (sizeKb > thresholds.monolith_size_kb_threshold) {
      return { type: 'monolith_size', size_kb: Math.round(sizeKb) };
    }
  } catch {
    // skip unreadable
  }
  return null;
}

function stripStringsAndComments(line, state) {
  let out = '';
  let i = 0;
  let inSingle = Boolean(state?.inSingle);
  let inDouble = Boolean(state?.inDouble);
  let inTemplate = Boolean(state?.inTemplate);
  let inBlockComment = Boolean(state?.inBlockComment);

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1] || '';

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '/') break;
    }

    if (!inDouble && !inTemplate && ch === '\'' && line[i - 1] !== '\\') {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && line[i - 1] !== '\\') {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`' && line[i - 1] !== '\\') {
      inTemplate = !inTemplate;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && !inTemplate) out += ch;
    i += 1;
  }

  return {
    clean: out,
    state: {
      inSingle,
      inDouble,
      inTemplate,
      inBlockComment,
    },
  };
}

function checkNestingDepth(lines, thresholds) {
  const suppressionByLine = lines.map(line => SUPPRESSION_PATTERN.test(line));
  const stack = [];
  let suppressedFrames = 0;
  let maxDepth = 0;
  let maxDepthSuppressed = 0;
  const linesAtMax = [];
  const suppressedLinesAtMax = [];
  let state = {
    inSingle: false,
    inDouble: false,
    inTemplate: false,
    inBlockComment: false,
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const { clean, state: nextState } = stripStringsAndComments(lines[idx], state);
    state = nextState;
    const lineSuppressed = idx > 0 && suppressionByLine[idx - 1];

    for (const ch of clean) {
      if (ch === '{') {
        stack.push(lineSuppressed);
        if (lineSuppressed) suppressedFrames += 1;
        const depth = stack.length;
        const inSuppressedBlock = suppressedFrames > 0;

        if (!inSuppressedBlock && depth > maxDepth) {
          maxDepth = depth;
          linesAtMax.length = 0;
          linesAtMax.push(idx + 1);
        } else if (!inSuppressedBlock && depth === maxDepth) {
          linesAtMax.push(idx + 1);
        }

        if (inSuppressedBlock && depth > maxDepthSuppressed) {
          maxDepthSuppressed = depth;
          suppressedLinesAtMax.length = 0;
          suppressedLinesAtMax.push(idx + 1);
        } else if (inSuppressedBlock && depth === maxDepthSuppressed) {
          suppressedLinesAtMax.push(idx + 1);
        }
      } else if (ch === '}') {
        if (stack.length > 0) {
          const popped = stack.pop();
          if (popped) suppressedFrames = Math.max(0, suppressedFrames - 1);
        }
      }
    }
  }

  if (maxDepth > thresholds.nesting_depth_threshold) {
    return {
      type: 'nesting_depth',
      depth: maxDepth,
      suppressed_depth: maxDepthSuppressed,
      threshold: thresholds.nesting_depth_threshold,
      lines: Array.from(new Set(linesAtMax)).slice(0, 10),
      suppressed_lines: Array.from(new Set(suppressedLinesAtMax)).slice(0, 10),
    };
  }
  return null;
}

// ── Missing docs check ───────────────────────────────────────────────

function checkMissingDocs(repoRoot, sourceFileInfo, thresholds, config) {
  const docsRoot = findDocsRoot(repoRoot, config);
  if (!docsRoot) return [];

  const docBases = new Set();
  walk(docsRoot, (_fullPath, lowerName) => {
    const base = path.basename(lowerName, path.extname(lowerName));
    docBases.add(base);
  }, 50000, { names: new Set(), prefixes: [] }, repoRoot);

  const findings = [];
  for (const { relPath, lineCount } of sourceFileInfo) {
    if (lineCount < thresholds.missing_docs_line_threshold) continue;
    const base = path.basename(relPath, path.extname(relPath)).toLowerCase();
    const hasDoc = Array.from(docBases).some(docBase =>
      docBase.includes(base) || base.includes(docBase)
    );
    if (!hasDoc) {
      findings.push({ type: 'missing_docs', file: relPath, lines: lineCount });
    }
  }

  return findings;
}

// ── Gap mapping ──────────────────────────────────────────────────────

function mapFindingsToGaps(findings) {
  const gaps = new Set();
  for (const f of findings) {
    if (f.type === 'todo_cluster') gaps.add('incomplete_implementation');
    if (f.type === 'console_log') gaps.add('debug_artifacts');
    if (f.type === 'excessive_any') gaps.add('type_safety_risk');
    if (f.type === 'monolith' || f.type === 'monolith_size') gaps.add('architectural_limit_exceeded');
    if (f.type === 'missing_docs') gaps.add('undocumented_module');
    if (f.type === 'nesting_depth') gaps.add('architectural_limit_exceeded');
  }
  return Array.from(gaps);
}

// ── History recording ────────────────────────────────────────────────

function resolveHistoryPath(config) {
  if (config?.paths?.hygiene_history_log) return config.paths.hygiene_history_log;
  return path.resolve(__dirname, '../../data/hygiene-history.jsonl');
}

function recordScan(config, summary, thresholds, gaps) {
  const historyPath = resolveHistoryPath(config);
  ensureFile(historyPath, '');
  const entry = {
    timestamp: new Date().toISOString(),
    summary: {
      total_findings: summary.total_findings,
      by_type: summary.by_type,
      scanned_files: summary.scanned_files,
    },
    thresholds,
    gaps,
  };
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf8');
}

function loadHistory(config) {
  const historyPath = resolveHistoryPath(config);
  return readJsonLines(historyPath);
}

// ── Trend computation ────────────────────────────────────────────────

function computeTrends(history, currentByType) {
  if (history.length < MIN_HISTORY_FOR_TRENDS) {
    return { by_type: {}, overall: 'insufficient_data', runs: history.length };
  }

  const recent = history.slice(-10);
  const previous = history[history.length - 1];
  const previousByType = previous?.summary?.by_type || {};

  const byType = {};
  let totalCurrent = 0;
  let totalAvg = 0;

  for (const type of ALL_FINDING_TYPES) {
    const current = currentByType[type] || 0;
    const values = recent.map(h => (h.summary?.by_type?.[type] || 0));
    const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const prev = previousByType[type] || 0;
    const delta = current - prev;

    let trend = 'stable';
    if (avg > 0) {
      if (current < avg * (1 - TREND_BAND)) trend = 'improving';
      else if (current > avg * (1 + TREND_BAND)) trend = 'worsening';
    } else if (current > 0) {
      trend = 'worsening';
    }

    byType[type] = { trend, delta, avg: Math.round(avg * 100) / 100, current };
    totalCurrent += current;
    totalAvg += avg;
  }

  let overall = 'stable';
  if (totalAvg > 0) {
    if (totalCurrent < totalAvg * (1 - TREND_BAND)) overall = 'improving';
    else if (totalCurrent > totalAvg * (1 + TREND_BAND)) overall = 'worsening';
  } else if (totalCurrent > 0) {
    overall = 'worsening';
  }

  return { by_type: byType, overall, runs: history.length };
}

// ── Threshold auto-tuning suggestions ────────────────────────────────

function suggestTuning(history, thresholds) {
  if (history.length < MIN_HISTORY_FOR_TUNING) return [];

  const recent = history.slice(-10);
  const suggestions = [];

  for (const type of ALL_FINDING_TYPES) {
    const thresholdKey = THRESHOLD_MAP[type];
    if (!thresholdKey) continue;

    const currentThreshold = thresholds[thresholdKey];
    if (currentThreshold === undefined) continue;

    const counts = recent.map(h => h.summary?.by_type?.[type] || 0);
    const scannedFiles = recent.map(h => h.summary?.scanned_files || 1);

    // Too noisy: >80% of scanned files trigger this type on average
    const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
    const avgScanned = scannedFiles.reduce((a, b) => a + b, 0) / scannedFiles.length;
    if (avgScanned > 0 && avgCount / avgScanned > 0.8) {
      const suggested = type === 'console_log'
        ? currentThreshold + 2
        : Math.ceil(currentThreshold * 1.5);
      suggestions.push({
        key: thresholdKey,
        current: currentThreshold,
        suggested,
        reason: `too_noisy: ${type} triggers on >80% of scanned files (avg ${avgCount.toFixed(1)} findings across ${avgScanned.toFixed(0)} files)`,
      });
      continue;
    }

    // Too quiet: 0 findings for all recent runs
    const allZero = counts.every(c => c === 0);
    if (allZero && currentThreshold > 1) {
      const suggested = type === 'console_log'
        ? Math.max(0, currentThreshold - 1)
        : Math.max(1, Math.floor(currentThreshold * 0.7));
      suggestions.push({
        key: thresholdKey,
        current: currentThreshold,
        suggested,
        reason: `too_quiet: ${type} has had 0 findings for ${recent.length} consecutive runs`,
      });
    }
  }

  return suggestions;
}

// ── Main scan ────────────────────────────────────────────────────────

function scanHygiene(configInput, options = {}) {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const rawConfig = configInput || readJson(configPath, null);
  const config = rawConfig ? resolveRuntimeConfig(rawConfig) : rawConfig;
  if (!config) {
    return {
      findings: [], summary: { total_findings: 0, by_type: {}, scanned_files: 0 },
      gaps: [], trends: { by_type: {}, overall: 'insufficient_data', runs: 0 }, tuning: [],
    };
  }

  const repoRoot = config.repo_root || process.cwd();
  const ignoreRules = ignoredDirsForConfig(config, repoRoot);
  const thresholds = resolveThresholds(config);
  const typeFilter = options.types ? new Set(options.types) : null;

  const allFindings = [];
  const sourceFileInfo = [];
  let scannedFiles = 0;

  walk(repoRoot, (fullPath, lowerName) => {
    const ext = path.extname(lowerName);
    if (!SCANNABLE_EXTENSIONS.has(ext)) return;

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      return;
    }

    scannedFiles++;
    const relPath = normalizePath(path.relative(repoRoot, fullPath));
    const lines = content.split('\n');

    sourceFileInfo.push({ relPath, lineCount: lines.length });

    const checks = [
      checkTodoCluster(lines, thresholds),
      checkConsoleLog(lines, relPath, thresholds),
      checkExcessiveAny(lines, lowerName, thresholds),
      checkMonolithLines(lines, thresholds),
      checkMonolithSize(fullPath, thresholds),
      checkNestingDepth(lines, thresholds),
    ];

    for (const finding of checks) {
      if (finding) {
        finding.file = relPath;
        allFindings.push(finding);
      }
    }
  }, 120000, ignoreRules, repoRoot);

  const docFindings = checkMissingDocs(repoRoot, sourceFileInfo, thresholds, config);
  allFindings.push(...docFindings);

  const filtered = typeFilter
    ? allFindings.filter(f => typeFilter.has(f.type))
    : allFindings;

  const byType = {};
  filtered.forEach(f => {
    byType[f.type] = (byType[f.type] || 0) + 1;
  });

  const summary = {
    total_findings: filtered.length,
    by_type: byType,
    scanned_files: scannedFiles,
  };

  const gaps = mapFindingsToGaps(filtered);

  // Load history and compute feedback signals
  const history = loadHistory(config);
  const trends = computeTrends(history, byType);
  const tuning = suggestTuning(history, thresholds);

  // Record this scan to history (unless disabled)
  const shouldRecord = options.record !== false;
  if (shouldRecord) {
    recordScan(config, summary, thresholds, gaps);
  }

  return { findings: filtered, summary, gaps, trends, tuning };
}

module.exports = { scanHygiene, computeTrends, suggestTuning, loadHistory };
