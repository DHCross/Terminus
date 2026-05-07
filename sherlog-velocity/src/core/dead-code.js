const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  readJsonLines,
  ensureFile,
  loadRuntimeConfig,
  resolveRuntimeConfig,
} = require('./shared');

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_STALE_DAYS = 30;

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

// Variable names too short or too generic to be useful signals
const SKIP_NAMES = new Set([
  'e', 'i', 'j', 'k', 'n', 'v', 'x', 'y', 'z',
  'err', 'idx', 'key', 'val', 'res', 'req', 'ctx',
  'cb', 'fn', 'op', 'id',
]);

// ── Path utilities ───────────────────────────────────────────────────

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeIgnorePrefix(value) {
  let normalized = normalizePath(value).replace(/\/\*\*?$/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') return null;
  const lower = normalized.toLowerCase();
  const marker = '/worktrees/';
  const markerIndex = lower.indexOf(marker);
  if (markerIndex >= 0) normalized = normalized.slice(0, markerIndex + marker.length - 1);
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

function resolveScanRoots(repoRoot, config) {
  const configured = Array.isArray(config?.paths?.source_roots)
    ? config.paths.source_roots
    : [];
  const roots = [];
  const seen = new Set();

  for (const entry of configured) {
    const raw = String(entry || '').trim();
    if (!raw) continue;

    const absolute = path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const resolved = path.resolve(absolute);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }

  return roots.length > 0 ? roots : [repoRoot];
}

// ── Feature-scope token matching (inlined from gap-detector patterns) ─

function normalizeFeature(featureName) {
  return String(featureName || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function featureTokens(featureName) {
  const normalized = normalizeFeature(featureName);
  if (!normalized) return [];
  const words = normalized.split('-').filter(Boolean);
  const tokens = new Set([normalized, normalized.replace(/-/g, '')]);
  words.forEach(word => tokens.add(word));
  if (words.length > 1) {
    tokens.add(words.join('_'));
    tokens.add(words.join('-'));
    tokens.add(words.join(''));
  }
  return Array.from(tokens).filter(t => t.length > 2);
}

function pathMatchesFeature(relPath, tokens) {
  const lower = relPath.toLowerCase();
  return tokens.some(token => lower.includes(token));
}

// ── String/comment stripping (mirrored from hygiene.js) ─────────────

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
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i += 1; continue;
    }

    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
      if (ch === '/' && next === '/') break;
    }

    if (!inDouble && !inTemplate && ch === '\'' && line[i - 1] !== '\\') { inSingle = !inSingle; i += 1; continue; }
    if (!inSingle && !inTemplate && ch === '"' && line[i - 1] !== '\\') { inDouble = !inDouble; i += 1; continue; }
    if (!inSingle && !inDouble && ch === '`' && line[i - 1] !== '\\') { inTemplate = !inTemplate; i += 1; continue; }

    if (!inSingle && !inDouble && !inTemplate) out += ch;
    i += 1;
  }

  return { clean: out, state: { inSingle, inDouble, inTemplate, inBlockComment } };
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*');
}

// ── Git staleness ────────────────────────────────────────────────────

function getGitStaleness(repoRoot, relPath, staleDays = DEFAULT_STALE_DAYS) {
  try {
    const epoch = execSync(`git log -1 --format=%ct -- ${JSON.stringify(relPath)}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!epoch) return { days_since_last_commit: null, is_stale: false };

    const daysSince = Math.floor((Date.now() / 1000 - Number(epoch)) / 86400);
    return { days_since_last_commit: daysSince, is_stale: daysSince >= staleDays };
  } catch {
    return { days_since_last_commit: null, is_stale: false };
  }
}

// ── Self-model liveness lookup ───────────────────────────────────────

function loadSelfModelLiveness(repoRoot, config) {
  const modelPath = config?.paths?.self_model_index
    ? (path.isAbsolute(config.paths.self_model_index)
      ? config.paths.self_model_index
      : path.join(repoRoot, config.paths.self_model_index))
    : path.join(repoRoot, 'sherlog-velocity', 'data', 'self-model.json');

  try {
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const map = new Map();
    for (const mod of (model?.modules || [])) {
      if (mod.path && mod.liveness?.category) {
        map.set(normalizePath(mod.path), mod.liveness.category);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ── Per-file checks ──────────────────────────────────────────────────

/**
 * Detects statements that can never execute because they follow an
 * unconditional return/throw/break/continue at the same indentation level.
 * Uses indentation as a proxy for block scope — sufficient for JS/TS
 * without requiring a full AST parser.
 */
function checkUnreachableCode(lines) {
  // Matches a line that ends with a hard-exit statement (not inside an if/else arm)
  const hardExitPattern = /^\s*(return\b[^;{]*[;)]?|throw\b[^;{]*[;)]?|break\s*;|continue\s*;)\s*$/;
  const findings = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    const { clean } = stripStringsAndComments(line, {});
    if (!hardExitPattern.test(clean)) continue;

    const indent = line.search(/\S/);
    if (indent < 0) continue;

    // Scan ahead for the next non-blank, non-comment line at the same indent level
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      const trimmed = nextLine.trim();
      if (!trimmed || isCommentLine(nextLine)) continue;

      const nextIndent = nextLine.search(/\S/);

      // Deeper indent = still inside the exited block = unreachable
      if (nextIndent > indent) {
        findings.push(j + 1);
        continue;
      }

      // Same indent = sibling statement — unreachable only if not a block-close or clause
      if (nextIndent === indent) {
        if (
          !trimmed.startsWith('}') &&
          !trimmed.startsWith('else') &&
          !trimmed.startsWith('catch') &&
          !trimmed.startsWith('finally') &&
          !trimmed.startsWith('case ') &&
          !trimmed.startsWith('default:')
        ) {
          findings.push(j + 1);
        }
      }
      break;
    }
  }

  if (findings.length === 0) return null;
  return { type: 'unreachable_code', count: findings.length, lines: findings };
}

/**
 * Detects local variables (const/let/var) that are declared but never
 * read elsewhere in the file. Uses whole-file token frequency as a
 * proxy — if an identifier appears only once, it was never consumed.
 *
 * Intentionally skips: destructuring patterns, very short names,
 * names prefixed with _ (private-by-convention).
 */
function checkUnusedVariables(lines, content) {
  const findings = [];
  const seen = new Set();

  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;

    // Skip destructuring patterns
    if (/\b(?:const|let|var)\s*[{[]/.test(line)) return;

    const varPattern = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g;
    let match;
    while ((match = varPattern.exec(line)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      if (name.length <= 1 || name.startsWith('_') || SKIP_NAMES.has(name)) continue;
      seen.add(name);

      // Count how many times this identifier appears in the entire file
      const occurrences = (content.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
      // 1 = only the declaration; still unused
      if (occurrences <= 1) {
        findings.push({ name, line: idx + 1 });
      }
    }
  });

  if (findings.length === 0) return null;
  return {
    type: 'unused_variable',
    count: findings.length,
    symbols: findings.map(f => f.name),
    lines: findings.map(f => f.line),
  };
}

/**
 * Detects functions that are defined within a module but never called
 * and never exported. Cross-references all export patterns to avoid
 * false positives on public API functions.
 *
 * Works for: function declarations, arrow functions, function expressions.
 */
function checkUnusedFunctions(lines, content) {
  // Collect exported names so we don't flag them
  const exportedNames = new Set();

  // module.exports = { foo, bar }
  const objExportMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
  if (objExportMatch) {
    (objExportMatch[1].match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || []).forEach(k => exportedNames.add(k));
  }
  // module.exports = name
  const simpleExport = content.match(/module\.exports\s*=\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*;/);
  if (simpleExport) exportedNames.add(simpleExport[1]);

  // module.exports.foo = ...
  let m;
  const dotExportRe = /module\.exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g;
  while ((m = dotExportRe.exec(content)) !== null) exportedNames.add(m[1]);

  // export function / export const / export default function
  const namedExportRe = /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  while ((m = namedExportRe.exec(content)) !== null) exportedNames.add(m[1]);
  const exportConstRe = /\bexport\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  while ((m = exportConstRe.exec(content)) !== null) exportedNames.add(m[1]);

  const findings = [];
  const seen = new Set();

  // Named function declarations: function foo(
  const funcDeclRe = /^\s*(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/;
  // Arrow / function expressions: const foo = (...) => / const foo = function
  const arrowRe = /^\s*(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?(?:function\b|\(|[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>)/;

  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;

    let name = null;
    const declMatch = funcDeclRe.exec(line);
    if (declMatch) {
      name = declMatch[1];
    } else {
      const arrowMatch = arrowRe.exec(line);
      if (arrowMatch) name = arrowMatch[1];
    }

    if (!name || seen.has(name) || exportedNames.has(name)) return;
    if (name.length <= 1 || SKIP_NAMES.has(name)) return;
    seen.add(name);

    const occurrences = (content.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    // 1 = only the declaration, 0 calls found
    if (occurrences <= 1) {
      findings.push({ name, line: idx + 1 });
    }
  });

  if (findings.length === 0) return null;
  return {
    type: 'unused_function',
    count: findings.length,
    symbols: findings.map(f => f.name),
    lines: findings.map(f => f.line),
  };
}

/**
 * Detects branch conditions that can never be true (or are always true),
 * making the enclosed code dead. Catches: literal false/true conditions,
 * always-false loops, and tautological contradictions (same variable
 * asserted to be two different values simultaneously).
 */
function checkDeadBranches(lines) {
  const findings = [];

  // if (false) / if (0) / if (null) / if (undefined) / if ('') / if ("")
  const alwaysFalseRe = /\bif\s*\(\s*(?:false|0|null|undefined|''|"")\s*\)/;
  // if (true) / if (1)
  const alwaysTrueRe = /\bif\s*\(\s*(?:true|1)\s*\)/;
  // while (false) / while (0)
  const whileFalseRe = /\bwhile\s*\(\s*(?:false|0)\s*\)/;
  // foo === "a" && foo === "b"  or  foo !== "a" && foo === "a"
  const contradictionRe = /\b(\w{2,})\s*===?\s*['"`][^'"`]*['"`]\s*&&\s*\1\s*===?\s*['"`][^'"`]*['"`]/;

  lines.forEach((line, idx) => {
    if (isCommentLine(line)) return;
    const { clean } = stripStringsAndComments(line, {});
    const trimmed = clean.trim();
    if (!trimmed) return;

    if (alwaysFalseRe.test(trimmed)) {
      findings.push({ pattern: 'always_false_condition', line: idx + 1 });
    } else if (alwaysTrueRe.test(trimmed)) {
      findings.push({ pattern: 'always_true_condition', line: idx + 1 });
    } else if (whileFalseRe.test(trimmed)) {
      findings.push({ pattern: 'always_false_loop', line: idx + 1 });
    } else if (contradictionRe.test(trimmed)) {
      findings.push({ pattern: 'tautological_contradiction', line: idx + 1 });
    }
  });

  if (findings.length === 0) return null;
  return {
    type: 'dead_branch',
    count: findings.length,
    patterns: findings.map(f => f.pattern),
    lines: findings.map(f => f.line),
  };
}

// ── Gap mapping ──────────────────────────────────────────────────────

function mapFindingsToGaps(findings, livenessCategory) {
  const gaps = new Set();
  for (const f of findings) {
    if (f.type === 'unreachable_code') gaps.add('dead_code_unreachable');
    if (f.type === 'unused_variable' || f.type === 'unused_function') gaps.add('dead_code_unused_symbol');
    if (f.type === 'dead_branch') gaps.add('dead_code_dead_branch');
  }
  if (livenessCategory === 'Dead') gaps.add('dead_code_stale_module');
  if (livenessCategory === 'Misleading') gaps.add('dead_code_misleading_module');
  return Array.from(gaps);
}

// ── History recording ────────────────────────────────────────────────

function resolveHistoryPath(config) {
  if (config?.paths?.dead_code_history_log) return config.paths.dead_code_history_log;
  return path.resolve(__dirname, '../../data/dead-code-history.jsonl');
}

function recordScan(config, summary, gaps) {
  const historyPath = resolveHistoryPath(config);
  ensureFile(historyPath, '');
  const entry = {
    timestamp: new Date().toISOString(),
    summary: {
      total_findings: summary.total_findings,
      by_type: summary.by_type,
      scanned_files: summary.scanned_files,
    },
    gaps,
  };
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf8');
}

function loadHistory(config) {
  const historyPath = resolveHistoryPath(config);
  return readJsonLines(historyPath);
}

// ── Main scan ────────────────────────────────────────────────────────

/**
 * Scans source files for dead code patterns.
 *
 * @param {object} configInput - Sherlog runtime config (or null to auto-load)
 * @param {object} options
 * @param {string}   [options.feature]    - Restrict scan to files matching this feature name
 * @param {string[]} [options.types]      - Filter to specific finding types
 * @param {boolean}  [options.staleOnly]  - Only report findings in git-stale files
 * @param {boolean}  [options.record]     - Append to scan history (default true)
 * @returns {{ findings, summary, gaps, history }}
 */
function scanDeadCode(configInput, options = {}) {
  const rawConfig = configInput || loadRuntimeConfig({ fromDir: __dirname }).config;
  const config = rawConfig ? resolveRuntimeConfig(rawConfig) : rawConfig;
  if (!config) {
    return {
      findings: [],
      summary: { total_findings: 0, by_type: {}, scanned_files: 0 },
      gaps: [],
      history: [],
    };
  }

  const repoRoot = config.repo_root || process.cwd();
  const ignoreRules = ignoredDirsForConfig(config, repoRoot);
  const staleDays = config?.settings?.hygiene?.stale_days_threshold ?? DEFAULT_STALE_DAYS;
  const typeFilter = options.types ? new Set(options.types) : null;
  const featureTokenList = options.feature ? featureTokens(options.feature) : null;

  // Load self-model liveness (best-effort)
  const livenessMap = loadSelfModelLiveness(repoRoot, config);

  const allFindings = [];
  let scannedFiles = 0;
  const scanRoots = resolveScanRoots(repoRoot, config);

  scanRoots.forEach(scanRoot => {
    walk(scanRoot, (fullPath, lowerName) => {
      const ext = path.extname(lowerName);
      if (!SCANNABLE_EXTENSIONS.has(ext)) return;

      const relPath = normalizePath(path.relative(repoRoot, fullPath));

      // Feature-scope filter
      if (featureTokenList && !pathMatchesFeature(relPath, featureTokenList)) return;

      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        return;
      }

      const lines = content.split('\n');
      const staleness = getGitStaleness(repoRoot, relPath, staleDays);

      // staleOnly mode: skip non-stale files
      if (options.staleOnly && !staleness.is_stale) return;

      scannedFiles++;

      const liveness = livenessMap.get(relPath) || null;
      const checks = [
        checkUnreachableCode(lines),
        checkUnusedVariables(lines, content),
        checkUnusedFunctions(lines, content),
        checkDeadBranches(lines),
      ];

      for (const finding of checks) {
        if (!finding) continue;
        finding.file = relPath;
        finding.stale = staleness.is_stale;
        finding.days_since_last_commit = staleness.days_since_last_commit;
        finding.liveness = liveness;
        allFindings.push(finding);
      }
    }, 120000, ignoreRules, repoRoot);
  });

  const filtered = typeFilter
    ? allFindings.filter(f => typeFilter.has(f.type))
    : allFindings;

  const byType = {};
  filtered.forEach(f => { byType[f.type] = (byType[f.type] || 0) + 1; });

  const summary = {
    total_findings: filtered.length,
    by_type: byType,
    scanned_files: scannedFiles,
  };

  // Aggregate gap keys across all findings (liveness from whole scan)
  const allLiveness = filtered.map(f => f.liveness).filter(Boolean);
  const hasDeadModule = allLiveness.includes('Dead');
  const hasMisleadingModule = allLiveness.includes('Misleading');
  const syntheticLiveness = hasDeadModule ? 'Dead' : hasMisleadingModule ? 'Misleading' : null;
  const gaps = mapFindingsToGaps(filtered, syntheticLiveness);

  const history = loadHistory(config);

  const shouldRecord = options.record !== false;
  if (shouldRecord) recordScan(config, summary, gaps);

  return { findings: filtered, summary, gaps, history };
}

module.exports = {
  scanDeadCode,
  checkUnreachableCode,
  checkUnusedVariables,
  checkUnusedFunctions,
  checkDeadBranches,
};
