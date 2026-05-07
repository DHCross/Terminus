const fs = require('fs');
const path = require('path');
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

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

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
  if (segments.some(segment => ignoreRules.names.has(segment))) return true;
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
        if (!isIgnoredPath(relPath, ignoreRules)) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      visit(fullPath, relPath);
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

function isCodeFile(relPath) {
  return CODE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function listConfiguredCodeFiles(repoRoot, config, ignoreRules) {
  const files = [];
  const scanRoots = resolveScanRoots(repoRoot, config);

  scanRoots.forEach(scanRoot => {
    walk(scanRoot, (_fullPath, relPath) => {
      if (!isCodeFile(relPath)) return;
      files.push(normalizePath(relPath));
    }, ignoreRules, repoRoot);
  });

  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function readFile(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return '';
  }
}

function splitNamedSpecifiers(spec) {
  return String(spec || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^([a-zA-Z_$][\w$]*)(?:\s+as\s+([a-zA-Z_$][\w$]*))?$/);
      if (!match) return null;
      return {
        source: match[1],
        target: match[2] || match[1],
      };
    })
    .filter(Boolean);
}

function parseImports(content) {
  const entries = [];
  const namedImportRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match = null;
  while ((match = namedImportRegex.exec(content)) !== null) {
    entries.push({
      source: match[2],
      pairs: splitNamedSpecifiers(match[1]).map(pair => ({
        source: pair.source,
        target: pair.target,
      })),
      kind: 'import',
    });
  }

  const starImportRegex = /import\s+\*\s+as\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = starImportRegex.exec(content)) !== null) {
    entries.push({
      source: match[2],
      pairs: [{ source: '*', target: match[1] }],
      kind: 'import',
    });
  }

  return entries;
}

function parseReexports(content) {
  const entries = [];
  let match = null;

  const namedReexportRegex = /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = namedReexportRegex.exec(content)) !== null) {
    entries.push({
      source: match[2],
      pairs: splitNamedSpecifiers(match[1]).map(pair => ({
        source: pair.source,
        target: pair.target,
      })),
      kind: 'reexport',
    });
  }

  const starReexportRegex = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = starReexportRegex.exec(content)) !== null) {
    entries.push({
      source: match[1],
      pairs: [{ source: '*', target: '*' }],
      kind: 'reexport',
    });
  }

  return entries;
}

function parseNamedExports(content) {
  const out = new Set();
  const directRegex = /\bexport\s+(?:const|let|var|function|class|type|interface|enum)\s+([a-zA-Z_$][\w$]*)/g;
  let match = null;
  while ((match = directRegex.exec(content)) !== null) {
    out.add(match[1]);
  }

  const listRegex = /export\s+\{([^}]+)\}(?!\s+from)/g;
  while ((match = listRegex.exec(content)) !== null) {
    splitNamedSpecifiers(match[1]).forEach(pair => out.add(pair.target));
  }

  return out;
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

function resolveExportSets(modulesByFile, reexportEdgesByFile) {
  let changed = true;

  while (changed) {
    changed = false;
    reexportEdgesByFile.forEach((edges, file) => {
      const fileExports = modulesByFile.get(file).exports;
      edges.forEach(edge => {
        const sourceModule = modulesByFile.get(edge.from);
        if (!sourceModule) return;
        edge.pairs.forEach(pair => {
          if (pair.source === '*' && pair.target === '*') {
            sourceModule.exports.forEach(name => {
              if (!fileExports.has(name)) {
                fileExports.add(name);
                changed = true;
              }
            });
            return;
          }
          if (pair.source === '*') {
            if (!fileExports.has(pair.target)) {
              fileExports.add(pair.target);
              changed = true;
            }
            return;
          }
          if (!fileExports.has(pair.target)) {
            fileExports.add(pair.target);
            changed = true;
          }
        });
      });
    });
  }
}

function buildConsumerGraph(configInput) {
  const config = resolveRuntimeConfig(configInput && typeof configInput === 'object' ? configInput : {});
  const repoRoot = config?.repo_root || process.cwd();
  const ignoreRules = ignoredDirsForConfig(config, repoRoot);
  const files = listConfiguredCodeFiles(repoRoot, config, ignoreRules);
  const fileSet = new Set(files);
  const modulesByFile = new Map();
  const outgoingBySource = new Map();
  const reexportEdgesByFile = new Map();

  files.forEach(file => {
    const content = readFile(repoRoot, file);
    modulesByFile.set(file, {
      file,
      exports: parseNamedExports(content),
      imports: parseImports(content),
      reexports: parseReexports(content),
    });
  });

  modulesByFile.forEach(moduleInfo => {
    const localReexports = [];
    [...moduleInfo.imports, ...moduleInfo.reexports].forEach(edge => {
      const resolved = resolveRelativeModule(moduleInfo.file, edge.source, fileSet);
      if (!resolved) return;

      const normalizedEdge = {
        from: resolved,
        to: moduleInfo.file,
        kind: edge.kind,
        pairs: edge.pairs.map(pair => ({
          source: pair.source,
          target: pair.target,
        })),
      };

      const list = outgoingBySource.get(resolved) || [];
      list.push(normalizedEdge);
      outgoingBySource.set(resolved, list);

      if (edge.kind === 'reexport') localReexports.push(normalizedEdge);
    });

    reexportEdgesByFile.set(moduleInfo.file, localReexports);
  });

  resolveExportSets(modulesByFile, reexportEdgesByFile);

  return {
    repo_root: repoRoot,
    files,
    modules_by_file: modulesByFile,
    outgoing_by_source: outgoingBySource,
  };
}

function resolveTargetFilePath(graph, filePath) {
  const repoRoot = graph.repo_root || process.cwd();
  const normalizedInput = normalizePath(filePath);
  if (!normalizedInput) return null;

  if (graph.modules_by_file.has(normalizedInput)) return normalizedInput;
  const normalizedInputLower = normalizedInput.toLowerCase();
  const caseInsensitiveDirect = graph.files.find(file => file.toLowerCase() === normalizedInputLower);
  if (caseInsensitiveDirect) return caseInsensitiveDirect;

  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const rel = normalizePath(path.relative(repoRoot, absolute));
  if (graph.modules_by_file.has(rel)) return rel;
  const relLower = rel.toLowerCase();
  const caseInsensitiveRel = graph.files.find(file => file.toLowerCase() === relLower);
  if (caseInsensitiveRel) return caseInsensitiveRel;

  if (!path.extname(rel)) {
    const candidates = [];
    RESOLVE_EXTENSIONS.forEach(ext => candidates.push(`${rel}${ext}`));
    RESOLVE_EXTENSIONS.forEach(ext => candidates.push(`${rel}/index${ext}`));
    const match = candidates.find(candidate => graph.modules_by_file.has(candidate));
    if (match) return match;
    const matchInsensitive = candidates
      .map(candidate => graph.files.find(file => file.toLowerCase() === candidate.toLowerCase()))
      .find(Boolean);
    if (matchInsensitive) return matchInsensitive;
  }

  return null;
}

function reexportSymbol(pair, incomingSymbol) {
  if (pair.source === '*' && pair.target === '*') return incomingSymbol;
  if (pair.source === incomingSymbol) return pair.target;
  if (pair.source === '*') return pair.target;
  return null;
}

function traceExportChains(graph, targetFile, exportName, maxDepth = 20) {
  const outgoing = graph.outgoing_by_source;
  const queue = [{
    file: targetFile,
    symbol: exportName,
    chain: [targetFile],
    depth: 0,
  }];
  const visited = new Set([`${targetFile}|${exportName}`]);
  const chains = [];

  while (queue.length > 0) {
    const state = queue.shift();
    const edges = outgoing.get(state.file) || [];
    if (!edges.length) continue;

    edges.forEach(edge => {
      const nextChain = [...state.chain, edge.to];
      if (edge.kind === 'import') {
        const matched = edge.pairs.some(pair => pair.source === '*' || pair.source === state.symbol);
        if (matched) chains.push(nextChain);
        return;
      }

      const nextSymbols = edge.pairs
        .map(pair => reexportSymbol(pair, state.symbol))
        .filter(Boolean);

      if (!nextSymbols.length) return;
      if (state.depth >= maxDepth) return;

      nextSymbols.forEach(symbol => {
        const key = `${edge.to}|${symbol}`;
        if (visited.has(key)) return;
        visited.add(key);
        queue.push({
          file: edge.to,
          symbol,
          chain: nextChain,
          depth: state.depth + 1,
        });
      });
    });
  }

  const unique = new Map();
  chains.forEach(chain => {
    const key = chain.join('>');
    if (!unique.has(key)) unique.set(key, chain);
  });
  return Array.from(unique.values());
}

function summarizeConsumersForFile(graph, filePath) {
  const resolvedTarget = resolveTargetFilePath(graph, filePath);
  if (!resolvedTarget) {
    return {
      target_file: null,
      exports: [],
      chains: [],
      by_export: [],
      consumers: [],
      downstream_count: 0,
    };
  }

  const moduleInfo = graph.modules_by_file.get(resolvedTarget);
  const exports = Array.from(moduleInfo?.exports || []).sort((a, b) => a.localeCompare(b));
  const allChains = [];
  const byExport = [];
  const consumers = new Set();

  exports.forEach(exportName => {
    const chains = traceExportChains(graph, resolvedTarget, exportName);
    chains.forEach(chain => {
      allChains.push({
        export: exportName,
        chain,
      });
      const consumer = chain[chain.length - 1];
      if (consumer && consumer !== resolvedTarget) consumers.add(consumer);
    });

    byExport.push({
      export: exportName,
      chains,
      consumers: Array.from(new Set(chains.map(chain => chain[chain.length - 1]).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    });
  });

  return {
    target_file: resolvedTarget,
    exports,
    chains: allChains,
    by_export: byExport,
    consumers: Array.from(consumers).sort((a, b) => a.localeCompare(b)),
    downstream_count: consumers.size,
  };
}

function analyzeConsumers(configInput, filePath) {
  const graph = buildConsumerGraph(configInput);
  return {
    graph,
    summary: summarizeConsumersForFile(graph, filePath),
  };
}

module.exports = {
  analyzeConsumers,
  buildConsumerGraph,
  summarizeConsumersForFile,
};
