const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.repomix',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.astro',
  'archive',
  'archives',
  'archived',
  'attic',
  'obsolete',
  'retired',
  'inspiration folder',
  'inspiration-folder',
  'inspiration_folder',
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
]);

const RESOLVABLE_CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const DEFAULT_SELF_MODEL_PATH = path.join('sherlog-velocity', 'data', 'self-model.json');
const DEFAULT_INACTIVITY_DAYS = 30;

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function resolveSelfModelPath(repoRoot, options = {}) {
  const configured = options.outputPath || options.selfModelPath || options.config?.paths?.self_model_index || DEFAULT_SELF_MODEL_PATH;
  return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadSelfModel(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.summary || !Array.isArray(parsed.modules)) return null;
  const hasModernSummary = parsed.summary?.liveness_counts && typeof parsed.summary.liveness_counts === 'object';
  const hasModernModules = parsed.modules.length === 0 || parsed.modules.every(mod => (
    mod
    && typeof mod === 'object'
    && mod.fragility
    && mod.coupling
    && mod.liveness
  ));
  if (!hasModernSummary || !hasModernModules) return null;
  return parsed;
}

function writeSelfModel(filePath, model) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(model, null, 2) + '\n', 'utf8');
  return filePath;
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root, visit, limit = 80000) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReadDir(current)) {
      if (seen++ > limit) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(path.join(current, entry.name));
        continue;
      }
      visit(path.join(current, entry.name));
    }
  }
}

function gitChurnTop(repoRoot, days, limit) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const raw = execSync(
      `git log --since="${since}" --name-only --pretty=format: -- '*.ts' '*.tsx' '*.js' '*.jsx'`,
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!raw) return [];
    const counts = new Map();
    for (const line of raw.split('\n')) {
      const file = normalizePath(line.trim());
      if (!file) continue;
      const fullPath = path.join(repoRoot, file);
      if (!fs.existsSync(fullPath)) continue;
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      counts.set(file, (counts.get(file) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([file, commits]) => ({ file, commits }));
  } catch {
    return [];
  }
}

function gitFileActivity(repoRoot) {
  try {
    const raw = execSync(
      `git log --diff-filter=AMR --pretty=format:%ct --name-only -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.mts' '*.cts'`,
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!raw) return new Map();

    const activity = new Map();
    let currentEpoch = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d{9,}$/.test(trimmed)) {
        currentEpoch = Number(trimmed);
        continue;
      }

      if (!Number.isFinite(currentEpoch)) continue;
      const relPath = normalizePath(trimmed);
      if (!relPath || activity.has(relPath)) continue;

      const ageDays = (Date.now() - (currentEpoch * 1000)) / 86400000;
      activity.set(relPath, {
        last_commit_epoch: currentEpoch,
        last_commit_at: new Date(currentEpoch * 1000).toISOString(),
        days_since_last_commit: Math.max(0, Math.round((ageDays + Number.EPSILON) * 10) / 10),
      });
    }

    return activity;
  } catch {
    return new Map();
  }
}

function classifyRole(relPath) {
  const lower = relPath.toLowerCase();
  const base = path.basename(lower);

  if (/\.test\.|\.spec\.|__tests__/.test(lower)) return 'test';
  if (/\.md$|\.mdx$/.test(lower)) return 'doc';
  if (/\.json$|\.ya?ml$/.test(lower)) return 'config';

  if (/\/app\/api\//.test(lower) || /\/pages\/api\//.test(lower)) return 'route';
  if (/\/hooks\//.test(lower) || base.startsWith('use')) return 'hook';
  if (/\/components\//.test(lower)) return 'component';
  if (base === 'page.tsx' || base === 'page.jsx' || base === 'layout.tsx') return 'page';
  if (/\/lib\//.test(lower) || /\/utils\//.test(lower) || /\/helpers\//.test(lower)) return 'lib';
  if (/\/server\//.test(lower)) return 'server';

  return 'source';
}

const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+(?:const|let|var)\s+(\w+)/g,
  /export\s+(?:type|interface)\s+(\w+)/g,
  /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
  /export\s+default\s+class\s+(\w+)/g,
];

function extractExports(content) {
  const symbols = [];
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.push(match[1]);
    }
  }
  return Array.from(new Set(symbols));
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]+?\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function tryResolveCandidate(repoRoot, candidatePath) {
  const normalizedCandidate = normalizePath(candidatePath);
  const variants = [];

  if (path.extname(normalizedCandidate)) {
    variants.push(normalizedCandidate);
  } else {
    for (const ext of RESOLVABLE_CODE_EXTENSIONS) variants.push(`${normalizedCandidate}${ext}`);
    for (const ext of RESOLVABLE_CODE_EXTENSIONS) variants.push(path.posix.join(normalizedCandidate, `index${ext}`));
  }

  for (const variant of variants) {
    try {
      const fullPath = path.join(repoRoot, variant);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return normalizePath(variant);
      }
    } catch {
      continue;
    }
  }

  return null;
}

function resolveImportTarget(specifier, relPath, options = {}) {
  if (!specifier || !relPath || !options.repoRoot) return null;
  const normalizedSpecifier = String(specifier).trim();
  if (!normalizedSpecifier) return null;

  if (normalizedSpecifier.startsWith('.')) {
    const fromDir = path.posix.dirname(normalizePath(relPath));
    const candidate = normalizePath(path.posix.join(fromDir, normalizedSpecifier));
    return tryResolveCandidate(options.repoRoot, candidate);
  }

  if (normalizedSpecifier.startsWith('@/') || normalizedSpecifier.startsWith('~/')) {
    const subPath = normalizedSpecifier.slice(2);
    const sourceRoots = Array.isArray(options.sourceRoots) ? options.sourceRoots : [];
    for (const root of sourceRoots) {
      const candidate = normalizePath(path.posix.join(normalizePath(root), subPath));
      const resolved = tryResolveCandidate(options.repoRoot, candidate);
      if (resolved) return resolved;
    }
  }

  return null;
}

function extractImportEdges(content, relPath, options = {}) {
  const edges = [];
  const seen = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1];
      if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('~/'))) {
        continue;
      }

      const resolved = resolveImportTarget(specifier, relPath, options);
      const key = `${relPath}::${specifier}::${resolved || 'unresolved'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: relPath,
        to: specifier,
        resolved_to: resolved,
      });
    }
  }
  return edges;
}

function computeFragility(lineCount, exportCount, importEdgeCount, churnCommits, inboundCount = 0) {
  let score = 0;
  if (lineCount > 800) score += 2;
  else if (lineCount > 400) score += 1;

  if (exportCount > 20) score += 2;
  else if (exportCount > 10) score += 1;

  if (importEdgeCount > 15) score += 1;
  const totalCoupling = Number(importEdgeCount || 0) + Number(inboundCount || 0);
  if (totalCoupling > 24) score += 1;
  else if (totalCoupling > 12) score += 0.5;
  if (churnCommits > 12) score += 2;
  else if (churnCommits > 6) score += 1;

  return Math.min(Math.round(score), 7);
}

function fragilityLabel(score) {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function resolveZoneOwnership(relPath, zones) {
  for (const zone of zones) {
    for (const pattern of (zone.paths || [])) {
      if (pathMatchesSimple(relPath, pattern)) return zone.name;
    }
  }
  return null;
}

function pathMatchesSimple(relPath, pattern) {
  const normalizedPath = normalizePath(relPath);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPattern) return false;
  const prefix = normalizedPattern.replace(/\*\*\/?\*?$/, '').replace(/\/+$/, '');
  if (!prefix) return true;
  return normalizedPath.startsWith(`${prefix}/`) || normalizedPath === prefix;
}

function detectPlaceholderSignals(content) {
  const lowered = String(content || '').toLowerCase();
  const signals = [];

  if (/\b(todo|fixme|tbd|stub|placeholder)\b/.test(lowered)) signals.push('todo_marker');
  if (/throw\s+new\s+error\s*\(\s*['"`](?:not implemented|todo|unimplemented|stub)/i.test(content)) {
    signals.push('not_implemented_throw');
  }
  if (/return\s+null\s*;/.test(lowered)) signals.push('returns_null');
  if (/return\s+undefined\s*;/.test(lowered)) signals.push('returns_undefined');

  return Array.from(new Set(signals));
}

function isLikelyEntrypoint(relPath, role) {
  const normalized = normalizePath(relPath).toLowerCase();
  const base = path.basename(normalized);

  if (role === 'route' || role === 'page') return true;
  if (normalized.startsWith('scripts/')) return true;
  if (normalized.includes('/cli/')) return true;
  if (base === 'main.ts' || base === 'main.js' || base === 'index.ts' || base === 'index.js') return true;
  return false;
}

function classifyLiveness({ placeholderSignals = [], inboundCount = 0, outboundCount = 0, churn = 0, daysSinceLastCommit = null, entrypoint = false }) {
  const incomplete = Array.isArray(placeholderSignals) && placeholderSignals.length > 0;
  const wired = entrypoint || inboundCount > 0;
  const stale = Number.isFinite(daysSinceLastCommit) && daysSinceLastCommit >= DEFAULT_INACTIVITY_DAYS;

  if (incomplete && wired) return 'Misleading';
  if (incomplete) return 'Scaffold';
  if (!entrypoint && inboundCount === 0 && outboundCount === 0 && churn === 0 && stale) return 'Dead';
  if (!entrypoint && inboundCount === 0 && outboundCount === 0 && churn === 0 && stale && (!Number.isFinite(daysSinceLastCommit) || daysSinceLastCommit >= 45)) {
    return 'Dead';
  }
  return 'Active';
}

const CONTRACT_SIGNALS = [
  { pattern: /SessionTracker|session tracker/i, role: 'session_contract' },
  { pattern: /detectGaps|gap detector/i, role: 'gap_contract' },
  { pattern: /createEstimatePayload|velocity estimate/i, role: 'estimate_contract' },
  { pattern: /ensureContextMap|sherlog\.context\.json/i, role: 'context_contract' },
];

function detectContractAnchors(content) {
  const anchors = [];
  for (const signal of CONTRACT_SIGNALS) {
    if (signal.pattern.test(content)) anchors.push(signal.role);
  }
  return anchors;
}

function buildNarrative(modules, edges, fragileFiles, zoneStats, contractAnchors, livenessCounts) {
  const roleGroups = {};
  for (const mod of modules) {
    roleGroups[mod.role] = (roleGroups[mod.role] || 0) + 1;
  }

  const lines = [];
  lines.push('This codebase contains:');
  const roleSummary = Object.entries(roleGroups)
    .sort((left, right) => right[1] - left[1])
    .map(([role, count]) => `${count} ${role} file${count > 1 ? 's' : ''}`)
    .join(', ');
  lines.push(`- ${roleSummary}`);
  lines.push(`- ${edges.length} internal dependency edges`);

  if (fragileFiles.length > 0) {
    lines.push(`- ${fragileFiles.length} file${fragileFiles.length > 1 ? 's' : ''} with elevated fragility`);
  }

  if (livenessCounts) {
    const livenessSummary = Object.entries(livenessCounts)
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${count} ${label.toLowerCase()}`)
      .join(', ');
    if (livenessSummary) lines.push(`- Liveness profile: ${livenessSummary}`);
  }

  if (zoneStats.covered > 0) {
    lines.push(`- ${zoneStats.covered} of ${zoneStats.total} files mapped to declared zones (${zoneStats.unmapped} unmapped)`);
  }

  if (contractAnchors.length > 0) {
    const anchorRoles = Array.from(new Set(contractAnchors.flatMap(anchor => anchor.anchors)));
    lines.push(`- Contract anchor surfaces: ${anchorRoles.join(', ')}`);
  }

  return lines.join('\n');
}

function generateSelfModel(repoRoot, options = {}) {
  const sourceRoots = Array.isArray(options.sourceRoots) && options.sourceRoots.length > 0
    ? options.sourceRoots
    : ['src'];
  const contextMapPath = options.contextMapPath || path.join(repoRoot, 'sherlog.context.json');
  const churnDays = options.churnDays || 14;
  const fragilityThreshold = options.fragilityThreshold || 3;
  const normalizedSourceRoots = sourceRoots.map(root => normalizePath(root)).filter(Boolean);

  const contextMap = readJson(contextMapPath);
  const zones = Array.isArray(contextMap?.zones) ? contextMap.zones : [];
  const churnData = gitChurnTop(repoRoot, churnDays, 200);
  const churnMap = new Map(churnData.map(item => [normalizePath(item.file), item.commits]));
  const activityMap = gitFileActivity(repoRoot);

  const modules = [];
  const allEdges = [];
  const contractAnchorFiles = [];
  const seenPaths = new Set();

  for (const srcRoot of sourceRoots) {
    const fullRoot = path.join(repoRoot, srcRoot);
    walk(fullRoot, (fullPath) => {
      const ext = path.extname(fullPath).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) return;

      const relPath = normalizePath(path.relative(repoRoot, fullPath));
      if (seenPaths.has(relPath)) return;
      seenPaths.add(relPath);
      const content = readText(fullPath);
      if (!content) return;

      const lineCount = content.split('\n').length;
      const role = classifyRole(relPath);
      const exports = extractExports(content);
      const importEdges = extractImportEdges(content, relPath, {
        repoRoot,
        sourceRoots: normalizedSourceRoots,
      });
      const churn = churnMap.get(relPath) || 0;
      const activity = activityMap.get(relPath) || null;
      const zone = resolveZoneOwnership(relPath, zones);
      const anchors = detectContractAnchors(content);
      const placeholderSignals = detectPlaceholderSignals(content);

      modules.push({
        path: relPath,
        role,
        lines: lineCount,
        exports: exports.length > 0 ? exports : undefined,
        export_count: exports.length,
        churn,
        placeholder_signals: placeholderSignals.length > 0 ? placeholderSignals : undefined,
        activity: activity || undefined,
        zone: zone || undefined,
        _outbound_count: importEdges.length,
        _entrypoint: isLikelyEntrypoint(relPath, role),
      });

      allEdges.push(...importEdges);
      if (anchors.length > 0) {
        contractAnchorFiles.push({ path: relPath, anchors });
      }
    });
  }

  const normalizedEdges = allEdges
    .map(edge => ({
      ...edge,
      from: normalizePath(edge.from),
      resolved_to: edge.resolved_to ? normalizePath(edge.resolved_to) : null,
    }))
    .filter(edge => edge.from && edge.resolved_to);

  const inboundCounts = new Map();
  const outboundCounts = new Map();
  normalizedEdges.forEach(edge => {
    inboundCounts.set(edge.resolved_to, (inboundCounts.get(edge.resolved_to) || 0) + 1);
    outboundCounts.set(edge.from, (outboundCounts.get(edge.from) || 0) + 1);
  });

  const livenessCounts = {
    Active: 0,
    Scaffold: 0,
    Dead: 0,
    Misleading: 0,
  };

  modules.forEach(mod => {
    const inboundCount = inboundCounts.get(mod.path) || 0;
    const outboundCount = outboundCounts.get(mod.path) || 0;
    const daysSinceLastCommit = Number.isFinite(mod.activity?.days_since_last_commit)
      ? Number(mod.activity.days_since_last_commit)
      : null;
    const liveness = classifyLiveness({
      placeholderSignals: mod.placeholder_signals || [],
      inboundCount,
      outboundCount,
      churn: mod.churn,
      daysSinceLastCommit,
      entrypoint: mod._entrypoint === true,
    });
    const fragility = computeFragility(mod.lines, mod.export_count, outboundCount, mod.churn, inboundCount);

    mod.import_count = outboundCount;
    mod.inbound_count = inboundCount;
    mod.outbound_count = outboundCount;
    mod.coupling = {
      inbound: inboundCount,
      outbound: outboundCount,
      total: inboundCount + outboundCount,
    };
    mod.fragility = {
      score: fragility,
      label: fragilityLabel(fragility),
    };
    mod.liveness = {
      category: liveness,
      entrypoint: mod._entrypoint === true,
      inactivity_days_threshold: DEFAULT_INACTIVITY_DAYS,
      placeholder_signals: mod.placeholder_signals || [],
    };

    delete mod._outbound_count;
    delete mod._entrypoint;
    if (!mod.placeholder_signals) delete mod.placeholder_signals;
    livenessCounts[liveness] = (livenessCounts[liveness] || 0) + 1;
  });

  modules.sort((left, right) => right.fragility.score - left.fragility.score);

  const fragileFiles = modules
    .filter(mod => mod.fragility.score >= fragilityThreshold)
    .map(mod => ({
      path: mod.path,
      score: mod.fragility.score,
      label: mod.fragility.label,
      lines: mod.lines,
      churn: mod.churn,
      liveness: mod.liveness.category,
      coupling: mod.coupling.total,
    }));

  const zoneStats = {
    total: modules.length,
    covered: modules.filter(mod => mod.zone).length,
    unmapped: modules.filter(mod => !mod.zone).length,
    zones: zones.map(zone => ({
      name: zone.name,
      belief: zone.belief || null,
      file_count: modules.filter(mod => mod.zone === zone.name).length,
    })),
  };

  const dependencyHubs = Array.from(inboundCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([target, count]) => ({ target, inbound_count: count }));

  const narrative = buildNarrative(modules, normalizedEdges, fragileFiles, zoneStats, contractAnchorFiles, livenessCounts);
  const liveStaleFiles = modules.filter(mod => {
    const category = mod?.liveness?.category;
    const days = Number(mod?.activity?.days_since_last_commit);
    return (category === 'Active' || category === 'Misleading') && Number.isFinite(days) && days >= DEFAULT_INACTIVITY_DAYS;
  });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    source_roots: sourceRoots,
    summary: {
      total_modules: modules.length,
      total_edges: normalizedEdges.length,
      fragile_file_count: fragileFiles.length,
      contract_anchor_count: contractAnchorFiles.length,
      zone_coverage_pct: modules.length > 0 ? Math.round((zoneStats.covered / modules.length) * 100) : 0,
      liveness_counts: livenessCounts,
      dead_or_scaffold_files: (livenessCounts.Dead || 0) + (livenessCounts.Scaffold || 0),
      stale_live_file_count: liveStaleFiles.length,
    },
    narrative,
    modules,
    edges: normalizedEdges,
    fragile_files: fragileFiles,
    dependency_hubs: dependencyHubs,
    contract_anchors: contractAnchorFiles,
    zone_ownership: zoneStats,
    churn_window_days: churnDays,
    churn_hotspots: churnData.slice(0, 15),
    stale_live_files: liveStaleFiles.map(mod => ({
      path: mod.path,
      days_since_last_commit: mod.activity.days_since_last_commit,
      liveness: mod.liveness.category,
    })),
  };
}

function getSelfModel(repoRoot, options = {}) {
  const modelPath = resolveSelfModelPath(repoRoot, options);
  if (!options.force) {
    const cached = loadSelfModel(modelPath);
    if (cached) {
      return {
        model: cached,
        model_path: modelPath,
        source: 'cache',
      };
    }
  }

  const model = generateSelfModel(repoRoot, options);
  if (options.persist !== false) {
    writeSelfModel(modelPath, model);
  }
  return {
    model,
    model_path: modelPath,
    source: 'generated',
  };
}

function renderSelfModel(model) {
  const lines = [];
  lines.push('SHERLOG SELF-MODEL');
  lines.push(`Generated: ${model.generated_at}`);
  lines.push('');

  lines.push('NARRATIVE');
  lines.push(model.narrative);
  lines.push('');

  lines.push('SUMMARY');
  lines.push(`  Modules indexed: ${model.summary.total_modules}`);
  lines.push(`  Dependency edges: ${model.summary.total_edges}`);
  lines.push(`  Fragile files: ${model.summary.fragile_file_count}`);
  lines.push(`  Contract anchors: ${model.summary.contract_anchor_count}`);
  lines.push(`  Zone coverage: ${model.summary.zone_coverage_pct}%`);
  if (model.summary.liveness_counts) {
    lines.push(`  Liveness: active ${model.summary.liveness_counts.Active || 0}, misleading ${model.summary.liveness_counts.Misleading || 0}, scaffold ${model.summary.liveness_counts.Scaffold || 0}, dead ${model.summary.liveness_counts.Dead || 0}`);
  }
  lines.push('');

  if (model.fragile_files.length > 0) {
    lines.push('FRAGILE FILES');
    for (const file of model.fragile_files.slice(0, 10)) {
      lines.push(`  [${file.label.toUpperCase()}] ${file.path} (${file.lines} lines, ${file.churn} recent commits, score ${file.score})`);
    }
    lines.push('');
  }

  if (model.contract_anchors.length > 0) {
    lines.push('CONTRACT ANCHORS');
    for (const anchor of model.contract_anchors) {
      lines.push(`  ${anchor.path}: ${anchor.anchors.join(', ')}`);
    }
    lines.push('');
  }

  if (model.dependency_hubs.length > 0) {
    lines.push('DEPENDENCY HUBS (most imported)');
    for (const hub of model.dependency_hubs) {
      lines.push(`  ${hub.target} (${hub.inbound_count} inbound)`);
    }
    lines.push('');
  }

  if (model.churn_hotspots.length > 0) {
    lines.push(`CHURN HOTSPOTS (${model.churn_window_days}-day window)`);
    for (const hotspot of model.churn_hotspots.slice(0, 10)) {
      lines.push(`  ${hotspot.file} (${hotspot.commits} commits)`);
    }
    lines.push('');
  }

  const zones = model.zone_ownership?.zones || [];
  if (zones.length > 0) {
    lines.push('ZONE OWNERSHIP');
    for (const zone of zones) {
      const belief = zone.belief && !String(zone.belief).startsWith('TODO') ? ` - ${zone.belief}` : '';
      lines.push(`  ${zone.name}: ${zone.file_count} files${belief}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  classifyRole,
  computeFragility,
  extractExports,
  extractImportEdges,
  fragilityLabel,
  generateSelfModel,
  getSelfModel,
  loadSelfModel,
  renderSelfModel,
  resolveImportTarget,
  resolveSelfModelPath,
  writeSelfModel,
};
