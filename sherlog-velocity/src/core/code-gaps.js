const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveRuntimeConfig } = require('./shared');

const CODE_EXTENSIONS = new Set([
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

const SOURCE_PREFIXES = [
  'src/',
  'lib/',
  'app/',
  'server/',
  'services/',
  'packages/',
];

const TEST_PREFIXES = [
  'test/',
  'tests/',
  '__tests__/',
];
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const ANY_TYPE_PATTERN = /:\s*any\b|<any[>,\s]|\bas\s+any\b|\bany\s*\[|\bany\s*\||\|\s*any\b/;
const SUPPRESSION_PATTERN = /eslint-disable|@ts-ignore|@ts-expect-error/;
const EXPORT_PATTERN = /(?:^|\n)\s*(?:export\s+(?:default|const|let|var|function|class|async|type|interface)|module\.exports|exports\.)/m;

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function normalizeIgnorePrefix(value) {
  let normalized = normalizePath(value).replace(/\/\*\*?$/, '');
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
  const configuredRoots = Array.isArray(config?.paths?.source_roots)
    ? config.paths.source_roots.map(root => normalizePath(root).toLowerCase()).filter(Boolean)
    : [];

  const names = new Set(Array.from(DEFAULT_IGNORED_DIRS).map(name => String(name).toLowerCase()));
  const prefixes = new Set(DEFAULT_IGNORED_PREFIXES.map(item => normalizeIgnorePrefix(item)).filter(Boolean));

  dynamic.forEach(entry => {
    if (entry.includes('/')) prefixes.add(entry);
    else names.add(entry);
  });

  configuredRoots.forEach(root => {
    const topSegment = root.split('/')[0];
    if (topSegment) names.delete(topSegment);
  });

  return {
    names,
    prefixes: Array.from(prefixes).sort((a, b) => a.localeCompare(b)),
  };
}

function isPathUnderPrefix(relPath, prefix) {
  return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

function isIgnoredPath(relPath, ignoreRules) {
  const normalized = normalizePath(relPath).toLowerCase();
  if (!normalized) return false;

  const segments = normalized.split('/');
  if (segments.some(seg => ignoreRules.names.has(seg))) return true;
  return ignoreRules.prefixes.some(prefix => isPathUnderPrefix(normalized, prefix));
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root, visit, ignoreRules, repoRoot = root, limit = 120000) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReadDir(current);

    for (const entry of entries) {
      if (seen++ > limit) return;
      const fullPath = path.join(current, entry.name);
      const relPath = normalizePath(path.relative(repoRoot, fullPath));

      if (entry.isDirectory()) {
        if (!isIgnoredPath(relPath, ignoreRules)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile()) visit(fullPath, relPath);
    }
  }
}

function isCodeFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function isTestFile(relPath) {
  const lower = normalizePath(relPath).toLowerCase();
  if (TEST_PREFIXES.some(prefix => lower.startsWith(prefix) || lower.includes(`/${prefix}`))) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(lower)) return true;
  if (/(^|[/._-])(test|spec)([/._-]|$)/i.test(lower)) return true;
  return false;
}

function stripSourcePrefix(relPath) {
  const lower = normalizePath(relPath).toLowerCase();
  const sourcePrefix = [...SOURCE_PREFIXES, ...TEST_PREFIXES]
    .find(prefix => lower.startsWith(prefix));
  if (!sourcePrefix) return lower;
  return lower.slice(sourcePrefix.length);
}

function canonicalTestKey(relPath) {
  const normalized = stripSourcePrefix(relPath)
    .replace(/\.(test|spec)\.[a-z0-9]+$/i, '')
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/\/index$/i, '');
  return normalized;
}

function splitTopLevel(text, separator = ',') {
  const out = [];
  let current = '';
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let depthBrace = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '<') depthAngle += 1;
    else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (
      ch === separator
      && depthParen === 0
      && depthAngle === 0
      && depthBracket === 0
      && depthBrace === 0
    ) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) out.push(current.trim());
  return out;
}

function normalizeTypeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseTypedParams(paramsText) {
  return splitTopLevel(String(paramsText || '')).map(raw => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const noDefault = trimmed.replace(/=[\s\S]*$/, '').trim();
    const match = noDefault.match(/^(?:\.\.\.)?([a-zA-Z_$][\w$]*)\??\s*:\s*([\s\S]+)$/);
    if (!match) {
      return {
        name: '',
        type: '',
      };
    }
    return {
      name: match[1],
      type: normalizeTypeText(match[2]),
    };
  }).filter(Boolean);
}

function parseFunctionSignatures(content) {
  const signatures = new Map();
  let match = null;

  const functionDeclRegex = /(?:export\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{\n]+))?/g;
  while ((match = functionDeclRegex.exec(content)) !== null) {
    const name = match[1];
    const params = parseTypedParams(match[2]);
    const returnType = normalizeTypeText(match[3] || '');
    if (!signatures.has(name)) {
      signatures.set(name, {
        params,
        return_type: returnType,
      });
    }
  }

  const arrowRegex = /(?:export\s+)?const\s+([a-zA-Z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*(?::\s*([^=]+?))?\s*=>/g;
  while ((match = arrowRegex.exec(content)) !== null) {
    const name = match[1];
    const params = parseTypedParams(match[2]);
    const returnType = normalizeTypeText(match[3] || '');
    if (!signatures.has(name)) {
      signatures.set(name, {
        params,
        return_type: returnType,
      });
    }
  }

  const typedArrowRegex = /(?:export\s+)?const\s+([a-zA-Z_$][\w$]*)\s*:\s*\(([^)]*)\)\s*=>\s*([^=]+?)\s*=\s*\(/g;
  while ((match = typedArrowRegex.exec(content)) !== null) {
    const name = match[1];
    const params = parseTypedParams(match[2]);
    const returnType = normalizeTypeText(match[3] || '');
    if (!signatures.has(name)) {
      signatures.set(name, {
        params,
        return_type: returnType,
      });
    }
  }

  return signatures;
}

function resolveRelativeModule(fromFile, specifier, fileSet) {
  if (!specifier || !specifier.startsWith('.')) return null;
  const base = normalizePath(path.join(path.dirname(fromFile), specifier));
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  else {
    RESOLVE_EXTENSIONS.forEach(ext => candidates.push(`${base}${ext}`));
    RESOLVE_EXTENSIONS.forEach(ext => candidates.push(`${base}/index${ext}`));
  }
  return candidates.find(candidate => fileSet.has(candidate)) || null;
}

function parseImportBindings(content) {
  const bindings = new Map();
  let match = null;
  const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = importRegex.exec(content)) !== null) {
    const specifier = match[2];
    splitTopLevel(match[1]).forEach(part => {
      const named = String(part || '').trim();
      if (!named) return;
      const aliasMatch = named.match(/^([a-zA-Z_$][\w$]*)(?:\s+as\s+([a-zA-Z_$][\w$]*))?$/);
      if (!aliasMatch) return;
      const importedName = aliasMatch[1];
      const localName = aliasMatch[2] || aliasMatch[1];
      bindings.set(localName, {
        imported_name: importedName,
        specifier,
      });
    });
  }
  return bindings;
}

function extractAnySymbols(content) {
  const symbols = [];
  const seen = new Set();
  const lines = String(content || '').split(/\r?\n/);

  lines.forEach((line, idx) => {
    const varMatch = line.match(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*:\s*any\b(?:\s*=\s*([a-zA-Z_$][\w$]*)\s*\()?/);
    if (varMatch) {
      const key = `${varMatch[1]}@${idx + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        symbols.push({
          name: varMatch[1],
          line: idx + 1,
          from_call: varMatch[2] || null,
        });
      }
    }

    const signatureMatch = line.match(/(?:function\s+[a-zA-Z_$][\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>)/);
    if (!signatureMatch) return;
    const paramsText = signatureMatch[1] || signatureMatch[2] || '';
    parseTypedParams(paramsText).forEach(param => {
      if (normalizeTypeText(param.type) !== 'any') return;
      const key = `${param.name}@${idx + 1}`;
      if (!param.name || seen.has(key)) return;
      seen.add(key);
      symbols.push({
        name: param.name,
        line: idx + 1,
        from_call: null,
      });
    });
  });

  return symbols;
}

function inferAnyHints(content, relPath, context) {
  const anySymbols = extractAnySymbols(content);
  if (!anySymbols.length) return [];

  const localSignatures = context.getSignatures(relPath);
  const imports = parseImportBindings(content);
  const hints = [];
  const seen = new Set();

  function findSignature(functionName) {
    if (!functionName) return null;
    if (localSignatures.has(functionName)) {
      return {
        signature: localSignatures.get(functionName),
        source: 'local',
      };
    }

    const binding = imports.get(functionName);
    if (!binding) return null;
    const importedFile = resolveRelativeModule(relPath, binding.specifier, context.fileSet);
    if (!importedFile) return null;
    const importedSignatures = context.getSignatures(importedFile);
    if (!importedSignatures.has(binding.imported_name)) return null;
    return {
      signature: importedSignatures.get(binding.imported_name),
      source: importedFile,
      imported_name: binding.imported_name,
    };
  }

  function pushHint(data) {
    const key = `${data.symbol}|${data.function_name}|${data.expected_type}|${data.relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push(data);
  }

  anySymbols.forEach(symbol => {
    if (symbol.from_call) {
      const signatureInfo = findSignature(symbol.from_call);
      const returnType = normalizeTypeText(signatureInfo?.signature?.return_type || '');
      if (returnType && returnType !== 'any') {
        pushHint({
          symbol: symbol.name,
          relation: 'return',
          function_name: symbol.from_call,
          expected_type: returnType,
          source: signatureInfo?.source || 'local',
        });
      }
    }
  });

  const callRegex = /([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)/g;
  let callMatch = null;
  while ((callMatch = callRegex.exec(content)) !== null) {
    const functionName = callMatch[1];
    const args = splitTopLevel(callMatch[2]);
    if (!args.length) continue;

    const signatureInfo = findSignature(functionName);
    if (!signatureInfo?.signature) continue;
    const params = Array.isArray(signatureInfo.signature.params) ? signatureInfo.signature.params : [];

    anySymbols.forEach(symbol => {
      const argIndex = args.findIndex(arg => new RegExp(`\\b${symbol.name}\\b`).test(arg));
      if (argIndex < 0) return;
      const expectedType = normalizeTypeText(params[argIndex]?.type || '');
      if (!expectedType || expectedType === 'any') return;

      pushHint({
        symbol: symbol.name,
        relation: 'argument',
        function_name: functionName,
        expected_type: expectedType,
        source: signatureInfo?.source || 'local',
      });
    });
  }

  return hints;
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

function lineHasSuppressionDirective(line) {
  return SUPPRESSION_PATTERN.test(String(line || ''));
}

function computeComplexityDepth(lines) {
  const stack = [];
  let suppressedFrames = 0;
  let maxDepthTotal = 0;
  let maxDepthUnsuppressed = 0;
  let maxDepthSuppressed = 0;
  let state = {
    inSingle: false,
    inDouble: false,
    inTemplate: false,
    inBlockComment: false,
  };

  const suppressionByLine = lines.map(line => lineHasSuppressionDirective(line));

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineSuppressed = idx > 0 && suppressionByLine[idx - 1];
    const next = stripStringsAndComments(line, state);
    state = next.state;

    for (const ch of next.clean) {
      if (ch === '{') {
        stack.push(lineSuppressed);
        if (lineSuppressed) suppressedFrames += 1;

        const depth = stack.length;
        const inSuppressedBlock = suppressedFrames > 0;
        maxDepthTotal = Math.max(maxDepthTotal, depth);
        if (inSuppressedBlock) maxDepthSuppressed = Math.max(maxDepthSuppressed, depth);
        else maxDepthUnsuppressed = Math.max(maxDepthUnsuppressed, depth);
      } else if (ch === '}') {
        if (stack.length > 0) {
          const popped = stack.pop();
          if (popped) suppressedFrames = Math.max(0, suppressedFrames - 1);
        }
      }
    }
  }

  return {
    total: maxDepthTotal,
    unsuppressed: maxDepthUnsuppressed,
    suppressed: maxDepthSuppressed,
  };
}

function detectAnyCounts(lines) {
  let total = 0;
  let suppressed = 0;
  let unsuppressed = 0;
  const suppressionByLine = lines.map(line => lineHasSuppressionDirective(line));

  lines.forEach((line, idx) => {
    if (!ANY_TYPE_PATTERN.test(line)) return;
    total += 1;
    if (idx > 0 && suppressionByLine[idx - 1]) {
      suppressed += 1;
      return;
    }
    unsuppressed += 1;
  });

  return {
    total,
    suppressed,
    unsuppressed,
  };
}

function scanContent(content, relPath, context = null) {
  const lines = String(content || '').split(/\r?\n/);
  const normalized = normalizePath(relPath);
  const testFile = isTestFile(normalized);
  const key = canonicalTestKey(normalized);
  const anyCounts = detectAnyCounts(lines);
  const complexity = computeComplexityDepth(lines);
  const hints = context ? inferAnyHints(content, normalized, context) : [];

  return {
    file: normalized,
    any_total: anyCounts.total,
    any_unsuppressed: anyCounts.unsuppressed,
    any_suppressed: anyCounts.suppressed,
    complexity_total: complexity.total,
    complexity_unsuppressed: complexity.unsuppressed,
    complexity_suppressed: complexity.suppressed,
    has_export: EXPORT_PATTERN.test(String(content || '')),
    test_file: testFile,
    test_key: key,
    missing_tests: 0,
    any_hints: hints,
  };
}

function resolveComplexityThreshold(config) {
  const raw = config?.settings?.hygiene?.nesting_depth_threshold;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function collectTestKeys(filePaths = []) {
  const keys = new Set();
  filePaths.forEach(relPath => {
    if (!isTestFile(relPath)) return;
    keys.add(canonicalTestKey(relPath));
  });
  return keys;
}

function applyMissingTests(metricMap, testKeys) {
  metricMap.forEach(metric => {
    if (metric.test_file) {
      metric.missing_tests = 0;
      return;
    }
    if (!metric.has_export) {
      metric.missing_tests = 0;
      return;
    }
    metric.missing_tests = testKeys.has(metric.test_key) ? 0 : 1;
  });
}

function listWorkingTreeCodeFiles(repoRoot, ignoreRules) {
  const files = [];
  walk(repoRoot, (_fullPath, relPath) => {
    if (!isCodeFile(relPath)) return;
    files.push(normalizePath(relPath));
  }, ignoreRules, repoRoot);
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function readWorkingTreeFile(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function listCodeFilesAtRef(repoRoot, ref, ignoreRules) {
  let raw;
  try {
    raw = runGit(repoRoot, ['ls-tree', '-r', '--name-only', ref]);
  } catch {
    return [];
  }
  if (!raw) return [];

  return raw
    .split(/\r?\n/)
    .map(item => normalizePath(item))
    .filter(Boolean)
    .filter(relPath => isCodeFile(relPath))
    .filter(relPath => !isIgnoredPath(relPath, ignoreRules))
    .sort((a, b) => a.localeCompare(b));
}

function readFileAtRef(repoRoot, ref, relPath) {
  try {
    return runGit(repoRoot, ['show', `${ref}:${relPath}`]);
  } catch {
    return null;
  }
}

function normalizeFileSet(fileList = []) {
  return new Set(fileList.map(item => normalizePath(item)).filter(Boolean));
}

function buildWorkingTreeSnapshot(config, ignoreRules, targetFiles = null) {
  const repoRoot = config?.repo_root || process.cwd();
  const allFiles = listWorkingTreeCodeFiles(repoRoot, ignoreRules);
  const targets = targetFiles ? normalizeFileSet(targetFiles) : null;
  const metricMap = new Map();
  const fileSet = new Set(allFiles);
  const contentCache = new Map();
  const signatureCache = new Map();

  function readContent(relPath) {
    if (contentCache.has(relPath)) return contentCache.get(relPath);
    const content = readWorkingTreeFile(repoRoot, relPath);
    contentCache.set(relPath, content);
    return content;
  }

  function getSignatures(relPath) {
    if (signatureCache.has(relPath)) return signatureCache.get(relPath);
    const content = readContent(relPath) || '';
    const signatures = parseFunctionSignatures(content);
    signatureCache.set(relPath, signatures);
    return signatures;
  }

  const scanContext = {
    fileSet,
    getSignatures,
  };

  allFiles.forEach(relPath => {
    if (targets && !targets.has(relPath)) return;
    const content = readContent(relPath);
    if (content === null) return;
    metricMap.set(relPath, scanContent(content, relPath, scanContext));
  });

  const testKeys = collectTestKeys(allFiles);
  applyMissingTests(metricMap, testKeys);

  return {
    all_files: allFiles,
    test_keys: testKeys,
    metrics: metricMap,
  };
}

function buildRefSnapshot(config, ref, ignoreRules, targetFiles = null) {
  const repoRoot = config?.repo_root || process.cwd();
  const allFiles = listCodeFilesAtRef(repoRoot, ref, ignoreRules);
  const targets = targetFiles ? normalizeFileSet(targetFiles) : null;
  const metricMap = new Map();
  const fileSet = new Set(allFiles);
  const contentCache = new Map();
  const signatureCache = new Map();

  function readContent(relPath) {
    if (contentCache.has(relPath)) return contentCache.get(relPath);
    const content = readFileAtRef(repoRoot, ref, relPath);
    contentCache.set(relPath, content);
    return content;
  }

  function getSignatures(relPath) {
    if (signatureCache.has(relPath)) return signatureCache.get(relPath);
    const content = readContent(relPath) || '';
    const signatures = parseFunctionSignatures(content);
    signatureCache.set(relPath, signatures);
    return signatures;
  }

  const scanContext = {
    fileSet,
    getSignatures,
  };

  allFiles.forEach(relPath => {
    if (targets && !targets.has(relPath)) return;
    const content = readContent(relPath);
    if (content === null) return;
    metricMap.set(relPath, scanContent(content, relPath, scanContext));
  });

  const testKeys = collectTestKeys(allFiles);
  applyMissingTests(metricMap, testKeys);

  return {
    all_files: allFiles,
    test_keys: testKeys,
    metrics: metricMap,
  };
}

function emptyMetric(relPath) {
  return {
    file: normalizePath(relPath),
    any_total: 0,
    any_unsuppressed: 0,
    any_suppressed: 0,
    complexity_total: 0,
    complexity_unsuppressed: 0,
    complexity_suppressed: 0,
    has_export: false,
    test_file: isTestFile(relPath),
    test_key: canonicalTestKey(relPath),
    missing_tests: 0,
    any_hints: [],
  };
}

function toAbsoluteEntry(metric) {
  return {
    file: metric.file,
    any: {
      total: Number(metric.any_total || 0),
      unsuppressed: Number(metric.any_unsuppressed || 0),
      suppressed: Number(metric.any_suppressed || 0),
    },
    complexity: {
      depth: Number(metric.complexity_unsuppressed || 0),
      total: Number(metric.complexity_total || 0),
      unsuppressed: Number(metric.complexity_unsuppressed || 0),
      suppressed: Number(metric.complexity_suppressed || 0),
    },
    missing_tests: Number(metric.missing_tests || 0),
    test_file: Boolean(metric.test_file),
    hints: Array.isArray(metric.any_hints) ? metric.any_hints : [],
  };
}

function absoluteTotals(entries, complexityThreshold) {
  return entries.reduce((acc, item) => {
    const anyTotal = Number(item?.any?.total || 0);
    const anyUnsuppressed = Number(item?.any?.unsuppressed || 0);
    const anySuppressed = Number(item?.any?.suppressed || 0);
    const missingTests = Number(item?.missing_tests || 0);
    const complexityDepth = Number(item?.complexity?.unsuppressed || 0);
    const complexityTotal = Number(item?.complexity?.total || 0);

    acc.total_any += anyTotal;
    acc.total_any_unsuppressed += anyUnsuppressed;
    acc.total_any_suppressed += anySuppressed;
    if (anyUnsuppressed > 0) acc.files_with_any += 1;

    acc.total_missing_tests += missingTests;
    if (missingTests > 0) acc.files_with_missing_tests += 1;

    if (complexityDepth > complexityThreshold) acc.files_with_complexity += 1;
    acc.max_complexity_depth = Math.max(acc.max_complexity_depth, complexityDepth);
    acc.max_complexity_depth_total = Math.max(acc.max_complexity_depth_total, complexityTotal);
    return acc;
  }, {
    files: entries.length,
    total_any: 0,
    total_any_unsuppressed: 0,
    total_any_suppressed: 0,
    files_with_any: 0,
    total_missing_tests: 0,
    files_with_missing_tests: 0,
    files_with_complexity: 0,
    max_complexity_depth: 0,
    max_complexity_depth_total: 0,
  });
}

function scanCodeGaps(configInput, options = {}) {
  const config = resolveRuntimeConfig(configInput && typeof configInput === 'object' ? configInput : {});
  const repoRoot = config?.repo_root || process.cwd();
  const ignoreRules = ignoredDirsForConfig(config, repoRoot);
  const complexityThreshold = resolveComplexityThreshold(config);

  const snapshot = buildWorkingTreeSnapshot(config, ignoreRules);
  const entries = Array.from(snapshot.metrics.values())
    .map(toAbsoluteEntry)
    .filter(entry => {
      if (options.include_clean === true) return true;
      const anyPrimary = options.include_suppressed
        ? Number(entry?.any?.total || 0)
        : Number(entry?.any?.unsuppressed || 0);
      const complexityPrimary = options.include_suppressed
        ? Number(entry?.complexity?.total || 0)
        : Number(entry?.complexity?.unsuppressed || 0);
      return anyPrimary > 0 || entry.missing_tests > 0 || complexityPrimary > complexityThreshold;
    })
    .sort((a, b) => {
      const aAny = options.include_suppressed ? Number(a?.any?.total || 0) : Number(a?.any?.unsuppressed || 0);
      const bAny = options.include_suppressed ? Number(b?.any?.total || 0) : Number(b?.any?.unsuppressed || 0);
      if (bAny !== aAny) return bAny - aAny;
      if (b.missing_tests !== a.missing_tests) return b.missing_tests - a.missing_tests;
      const aComplexity = options.include_suppressed ? Number(a?.complexity?.total || 0) : Number(a?.complexity?.unsuppressed || 0);
      const bComplexity = options.include_suppressed ? Number(b?.complexity?.total || 0) : Number(b?.complexity?.unsuppressed || 0);
      if (bComplexity !== aComplexity) return bComplexity - aComplexity;
      return a.file.localeCompare(b.file);
    });

  return {
    mode: 'absolute',
    generated_at: new Date().toISOString(),
    thresholds: {
      complexity_depth: complexityThreshold,
    },
    files: entries,
    totals: absoluteTotals(entries, complexityThreshold),
  };
}

function listChangedFilesSince(repoRoot, sinceRef) {
  const raw = runGit(repoRoot, ['diff', '--name-only', `${sinceRef}...HEAD`]);
  if (!raw) return [];
  return raw.split(/\r?\n/)
    .map(item => normalizePath(item))
    .filter(Boolean);
}

function diffMetric(changes, file, metric, before, after) {
  const delta = after - before;
  if (delta === 0) return;
  changes.push({
    file,
    metric,
    delta,
    before,
    after,
  });
}

function scanCodeGapDiff(configInput, sinceRef, options = {}) {
  const config = resolveRuntimeConfig(configInput && typeof configInput === 'object' ? configInput : {});
  const repoRoot = config?.repo_root || process.cwd();
  const ignoreRules = ignoredDirsForConfig(config, repoRoot);

  const changedFiles = listChangedFilesSince(repoRoot, sinceRef)
    .filter(relPath => isCodeFile(relPath))
    .filter(relPath => !isIgnoredPath(relPath, ignoreRules));

  const currentSnapshot = buildWorkingTreeSnapshot(config, ignoreRules, changedFiles);
  const previousSnapshot = buildRefSnapshot(config, sinceRef, ignoreRules, changedFiles);
  const changes = [];

  changedFiles.forEach(file => {
    const beforeMetric = previousSnapshot.metrics.get(file) || emptyMetric(file);
    const afterMetric = currentSnapshot.metrics.get(file) || emptyMetric(file);

    const beforeAny = options.include_suppressed
      ? Number(beforeMetric.any_total || 0)
      : Number(beforeMetric.any_unsuppressed || 0);
    const afterAny = options.include_suppressed
      ? Number(afterMetric.any_total || 0)
      : Number(afterMetric.any_unsuppressed || 0);
    diffMetric(changes, file, 'any', beforeAny, afterAny);
    diffMetric(changes, file, 'missing_tests', Number(beforeMetric.missing_tests || 0), Number(afterMetric.missing_tests || 0));

    const beforeComplexity = options.include_suppressed
      ? Number(beforeMetric.complexity_total || 0)
      : Number(beforeMetric.complexity_unsuppressed || 0);
    const afterComplexity = options.include_suppressed
      ? Number(afterMetric.complexity_total || 0)
      : Number(afterMetric.complexity_unsuppressed || 0);
    diffMetric(changes, file, 'complexity', beforeComplexity, afterComplexity);
  });

  return {
    mode: 'diff',
    since: sinceRef,
    compare: 'HEAD',
    changed_files: changedFiles,
    changes: changes.sort((a, b) => {
      const absDelta = Math.abs(b.delta) - Math.abs(a.delta);
      if (absDelta !== 0) return absDelta;
      if (a.metric !== b.metric) return a.metric.localeCompare(b.metric);
      return a.file.localeCompare(b.file);
    }),
  };
}

module.exports = {
  scanCodeGaps,
  scanCodeGapDiff,
};
