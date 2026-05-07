const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  loadRuntimeConfig,
  readJson,
  readJsonLines,
  repoRelativePathVariants,
  resolveRepoRoot: resolveSharedRepoRoot,
  resolveRuntimeConfig,
} = require('./shared');
const { scanHygiene } = require('./hygiene');
const { getSelfModel } = require('./self-model');
const {
  detectSourceRoots: detectInstalledSourceRoots,
  detectTestRoots: detectInstalledTestRoots,
} = require('../../install');

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

const DEFAULT_IGNORED_PREFIXES = [
  '.claude/worktrees',
];

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
  const tokens = new Set([
    normalized,
    normalized.replace(/-/g, ''),
  ]);

  words.forEach(word => tokens.add(word));
  if (words.length > 1) {
    tokens.add(words.join('_'));
    tokens.add(words.join('-'));
    tokens.add(words.join(''));
  }

  return Array.from(tokens).filter(Boolean);
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function dedupeCaseInsensitive(values = []) {
  const seen = new Set();
  const out = [];
  values.forEach(value => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  return out;
}

function dedupeTokens(values = []) {
  const seen = new Set();
  const out = [];
  values.forEach(value => {
    const token = String(value || '').trim().toLowerCase();
    if (!token) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  });
  return out;
}

function collectTokenVariants(values = []) {
  const expanded = [];
  dedupeCaseInsensitive(values).forEach(value => {
    expanded.push(value.toLowerCase());
    featureTokens(value).forEach(token => expanded.push(token));
  });
  return dedupeTokens(expanded);
}

const WEAK_SIGNAL_TOKENS = new Set([
  'api',
  'app',
  'code',
  'core',
  'data',
  'doc',
  'docs',
  'net',
  'task',
  'test',
  'ui',
  'ux',
]);

const GENERIC_SIGNAL_TOKENS = new Set([
  'feature',
  'features',
  'issue',
  'issues',
  'bug',
  'bugs',
  'request',
  'requests',
  'work',
  'update',
  'updates',
  'index',
  'indexes',
  'system',
  'systems',
  'module',
  'modules',
  'precision',
]);

const LOW_SIGNAL_REQUEST_TOKENS = new Set([
  'better',
  'cleanup',
  'enhance',
  'enhancement',
  'enhancements',
  'fix',
  'fixes',
  'improve',
  'improved',
  'improvement',
  'improvements',
  'polish',
  'refine',
  'refinement',
  'streamline',
  'tuning',
  'upgrade',
  'usability',
]);

function signalTokens(values = []) {
  const tokens = dedupeTokens(values);
  const strong = tokens.filter(token => {
    const compact = collapseAlphaNumeric(token);
    if (!compact) return false;
    if (GENERIC_SIGNAL_TOKENS.has(compact)) return false;
    if (LOW_SIGNAL_REQUEST_TOKENS.has(compact) && !token.includes('-') && !token.includes('_')) return false;
    if (token.includes('-') || token.includes('_')) return true;
    if (compact.length >= 4) return !WEAK_SIGNAL_TOKENS.has(compact);
    return !WEAK_SIGNAL_TOKENS.has(compact) && compact.length >= 3;
  });
  const nonGeneric = tokens.filter(token => {
    const compact = collapseAlphaNumeric(token);
    if (GENERIC_SIGNAL_TOKENS.has(compact)) return false;
    if (LOW_SIGNAL_REQUEST_TOKENS.has(compact) && !token.includes('-') && !token.includes('_')) return false;
    return true;
  });
  if (strong.length > 0) return strong;
  if (nonGeneric.length > 0) return nonGeneric;
  return tokens.filter(token => token.includes('-') || token.includes('_'));
}

function featureScopedEntries(table, featureName) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return [];
  const featureKey = normalizeFeature(featureName);
  const matches = [];

  Object.entries(table).forEach(([key, value]) => {
    if (key === '*') {
      matches.push(value);
      return;
    }
    if (normalizeFeature(key) === featureKey) matches.push(value);
  });

  return matches;
}

function normalizeProbeMetadataEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      aliases: [],
      shared: [],
      implementation: [],
      tests: [],
      docs: [],
      shared_paths: [],
      implementation_paths: [],
      test_paths: [],
      doc_paths: [],
      export_hints: [],
      callsite_hints: [],
      scope_mode: null,
      convergence_thresholds: {},
      convergence_weights: {},
      lane_multipliers: {},
      lanes: [],
    };
  }

  const convergence = entry?.convergence && typeof entry.convergence === 'object'
    ? entry.convergence
    : {};

  function normalizeNumericTable(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    Object.entries(value).forEach(([key, raw]) => {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return;
      out[String(key).trim().toLowerCase()] = numeric;
    });
    return out;
  }

  function normalizeLaneEntry(nameHint, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const laneName = String(value.name || nameHint || '').trim().toLowerCase();
    if (!laneName) return null;
    const mode = String(value.mode || 'strict').trim().toLowerCase();
    const include = [
      ...toStringArray(value.include),
      ...toStringArray(value.includes),
      ...toStringArray(value.paths),
      ...toStringArray(value.path_hints),
    ].map(item => normalizePath(item).toLowerCase()).filter(Boolean);
    const exclude = [
      ...toStringArray(value.exclude),
      ...toStringArray(value.excludes),
      ...toStringArray(value.ignore),
      ...toStringArray(value.ignore_paths),
    ].map(item => normalizePath(item).toLowerCase()).filter(Boolean);
    return {
      name: laneName,
      mode: mode === 'excluded' ? 'excluded' : mode === 'relaxed' ? 'relaxed' : 'strict',
      include: dedupeCaseInsensitive(include),
      exclude: dedupeCaseInsensitive(exclude),
    };
  }

  function normalizeLaneTable(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map(item => normalizeLaneEntry(item?.name || null, item))
        .filter(Boolean);
    }
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([key, item]) => normalizeLaneEntry(key, item))
        .filter(Boolean);
    }
    return [];
  }

  return {
    aliases: [
      ...toStringArray(entry.aliases),
      ...toStringArray(entry.alias),
    ],
    shared: [
      ...toStringArray(entry.tokens),
      ...toStringArray(entry.token),
    ],
    implementation: [
      ...toStringArray(entry.implementation_tokens),
      ...toStringArray(entry.implementation),
      ...toStringArray(entry.impl_tokens),
      ...toStringArray(entry.impl),
    ],
    tests: [
      ...toStringArray(entry.test_tokens),
      ...toStringArray(entry.tests),
      ...toStringArray(entry.test),
    ],
    docs: [
      ...toStringArray(entry.doc_tokens),
      ...toStringArray(entry.docs),
      ...toStringArray(entry.documentation_tokens),
      ...toStringArray(entry.documentation),
    ],
    shared_paths: [
      ...toStringArray(entry.path_hints),
      ...toStringArray(entry.paths),
    ],
    implementation_paths: [
      ...toStringArray(entry.implementation_path_hints),
      ...toStringArray(entry.implementation_paths),
      ...toStringArray(entry.impl_path_hints),
      ...toStringArray(entry.impl_paths),
    ],
    test_paths: [
      ...toStringArray(entry.test_path_hints),
      ...toStringArray(entry.test_paths),
    ],
    doc_paths: [
      ...toStringArray(entry.doc_path_hints),
      ...toStringArray(entry.docs_path_hints),
      ...toStringArray(entry.doc_paths),
      ...toStringArray(entry.docs_paths),
      ...toStringArray(entry.documentation_paths),
    ],
    export_hints: [
      ...toStringArray(entry.export_hints),
      ...toStringArray(entry.exports),
      ...toStringArray(entry.export_tokens),
    ],
    callsite_hints: [
      ...toStringArray(entry.callsite_hints),
      ...toStringArray(entry.callsites),
      ...toStringArray(entry.call_tokens),
    ],
    scope_mode: normalizeScopeMode(
      entry.scope_mode
      || entry.match_mode
      || entry.scoped_mode
      || entry.path_scope_mode
    ),
    convergence_thresholds: normalizeNumericTable(entry.convergence_thresholds || convergence.thresholds || {}),
    convergence_weights: normalizeNumericTable(entry.convergence_weights || convergence.weights || {}),
    lane_multipliers: normalizeNumericTable(entry.lane_multipliers || convergence.lane_multipliers || {}),
    lanes: normalizeLaneTable(entry.path_lanes || entry.lanes || convergence.path_lanes || []),
  };
}

function mergeProbeMetadata(entries = []) {
  const merged = {
    aliases: [],
    shared: [],
    implementation: [],
    tests: [],
    docs: [],
    shared_paths: [],
    implementation_paths: [],
    test_paths: [],
    doc_paths: [],
    export_hints: [],
    callsite_hints: [],
    scope_mode: null,
    convergence_thresholds: {},
    convergence_weights: {},
    lane_multipliers: {},
    lanes: [],
  };

  entries
    .map(normalizeProbeMetadataEntry)
    .forEach(entry => {
      merged.aliases.push(...entry.aliases);
      merged.shared.push(...entry.shared);
      merged.implementation.push(...entry.implementation);
      merged.tests.push(...entry.tests);
      merged.docs.push(...entry.docs);
      merged.shared_paths.push(...entry.shared_paths);
      merged.implementation_paths.push(...entry.implementation_paths);
      merged.test_paths.push(...entry.test_paths);
      merged.doc_paths.push(...entry.doc_paths);
      merged.export_hints.push(...entry.export_hints);
      merged.callsite_hints.push(...entry.callsite_hints);
      merged.lanes.push(...entry.lanes);
      if (entry.scope_mode) merged.scope_mode = entry.scope_mode;
      Object.assign(merged.convergence_thresholds, entry.convergence_thresholds);
      Object.assign(merged.convergence_weights, entry.convergence_weights);
      Object.assign(merged.lane_multipliers, entry.lane_multipliers);
    });

  return {
    aliases: dedupeCaseInsensitive(merged.aliases),
    shared: dedupeCaseInsensitive(merged.shared),
    implementation: dedupeCaseInsensitive(merged.implementation),
    tests: dedupeCaseInsensitive(merged.tests),
    docs: dedupeCaseInsensitive(merged.docs),
    shared_paths: dedupeCaseInsensitive(merged.shared_paths),
    implementation_paths: dedupeCaseInsensitive(merged.implementation_paths),
    test_paths: dedupeCaseInsensitive(merged.test_paths),
    doc_paths: dedupeCaseInsensitive(merged.doc_paths),
    export_hints: dedupeCaseInsensitive(merged.export_hints),
    callsite_hints: dedupeCaseInsensitive(merged.callsite_hints),
    scope_mode: merged.scope_mode,
    convergence_thresholds: merged.convergence_thresholds,
    convergence_weights: merged.convergence_weights,
    lane_multipliers: merged.lane_multipliers,
    lanes: merged.lanes,
  };
}

function resolveFeatureProfile(featureName, config, options = {}) {
  const profileTables = [];
  if (config?.settings?.feature_profiles && typeof config.settings.feature_profiles === 'object') {
    profileTables.push(config.settings.feature_profiles);
  }

  const repoRoot = resolveRepoRoot(config);
  const profileFilePath = path.join(repoRoot, 'sherlog.feature-profiles.json');
  const profileFile = readJson(profileFilePath, null);
  if (profileFile && typeof profileFile === 'object' && !Array.isArray(profileFile)) {
    const table = profileFile.feature_profiles && typeof profileFile.feature_profiles === 'object'
      ? profileFile.feature_profiles
      : profileFile;
    profileTables.push(table);
  }

  const featureKey = normalizeFeature(featureName);
  const requestedKey = normalizeFeature(options?.profile || '');
  const normalized = [];

  profileTables.forEach(profiles => {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return;
    Object.entries(profiles).forEach(([key, value]) => {
      const normalizedKey = normalizeFeature(key) || String(key).trim().toLowerCase();
      if (!normalizedKey) return;
      const profile = normalizeProbeMetadataEntry(value);
      const aliasKeys = dedupeCaseInsensitive(profile.aliases)
        .map(alias => normalizeFeature(alias))
        .filter(Boolean);
      normalized.push({
        key: normalizedKey,
        profile,
        alias_keys: aliasKeys,
      });
    });
  });

  function findByKey(key) {
    if (!key) return null;
    return normalized.find(item => item.key === key) || null;
  }

  function findByAlias(key) {
    if (!key) return null;
    return normalized.find(item => item.alias_keys.includes(key)) || null;
  }

  if (requestedKey) {
    const direct = findByKey(requestedKey) || findByAlias(requestedKey);
    if (direct) return { ...direct, source: 'explicit' };
  }

  const directFeature = findByKey(featureKey);
  if (directFeature) return { ...directFeature, source: 'feature-key' };

  const aliasFeature = findByAlias(featureKey);
  if (aliasFeature) return { ...aliasFeature, source: 'feature-alias' };

  const wildcard = findByKey('*');
  if (wildcard) return { ...wildcard, source: 'wildcard' };

  return {
    key: null,
    profile: normalizeProbeMetadataEntry(null),
    alias_keys: [],
    source: 'none',
  };
}

function resolveFeatureProbes(featureName, config, options = {}) {
  const resolvedProfile = resolveFeatureProfile(featureName, config, options);
  const configuredAliases = featureScopedEntries(config?.settings?.feature_aliases, featureName)
    .flatMap(entry => toStringArray(entry));
  const cliAliases = Array.isArray(options?.aliases) ? options.aliases : [];

  const metadataEntries = [
    resolvedProfile.profile,
    ...featureScopedEntries(config?.settings?.feature_metadata, featureName),
  ];
  if (options?.metadata) metadataEntries.push(options.metadata);
  const metadata = mergeProbeMetadata(metadataEntries);

  const aliases = dedupeCaseInsensitive([...configuredAliases, ...cliAliases, ...metadata.aliases]);
  const baseTokens = featureTokens(featureName);
  const aliasTokens = collectTokenVariants(aliases);
  const sharedTokens = collectTokenVariants(metadata.shared);
  const implementationTokens = collectTokenVariants(metadata.implementation);
  const testTokens = collectTokenVariants(metadata.tests);
  const docTokens = collectTokenVariants(metadata.docs);

  const featureProbeTokens = dedupeTokens([
    ...baseTokens,
    ...aliasTokens,
    ...sharedTokens,
  ]);

  return {
    aliases,
    metadata,
    intent: {
      feature_key: normalizeFeature(featureName) || 'current-task',
      profile_key: resolvedProfile.key,
      profile_source: resolvedProfile.source,
      requested_profile: options?.profile || null,
    },
    feature_tokens: featureProbeTokens,
    implementation_tokens: dedupeTokens([...featureProbeTokens, ...implementationTokens]),
    test_tokens: dedupeTokens([...featureProbeTokens, ...testTokens]),
    doc_tokens: dedupeTokens([...featureProbeTokens, ...docTokens]),
    path_hints: {
      shared: dedupeCaseInsensitive(metadata.shared_paths),
      implementation: dedupeCaseInsensitive([...metadata.shared_paths, ...metadata.implementation_paths]),
      tests: dedupeCaseInsensitive([...metadata.shared_paths, ...metadata.test_paths]),
      docs: dedupeCaseInsensitive([...metadata.shared_paths, ...metadata.doc_paths]),
    },
    export_hints: collectTokenVariants(metadata.export_hints),
    callsite_hints: collectTokenVariants(metadata.callsite_hints),
    scope: {
      mode: metadata.scope_mode,
      enforced: metadata.scope_mode === 'bounded',
    },
    lane_overrides: metadata.lanes,
    convergence_overrides: {
      thresholds: metadata.convergence_thresholds,
      weights: metadata.convergence_weights,
      lane_multipliers: metadata.lane_multipliers,
    },
  };
}

function resolveOutsideContextWarningThreshold(config) {
  const raw = Number(
    config?.settings?.feature_files_outside_context_map_warning_threshold
    ?? config?.settings?.context_warning_threshold
    ?? 1
  );
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.floor(raw));
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeScopeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return null;
  if (['bounded', 'bound', 'scoped', 'in-scope-only', 'in_scope_only', 'path-bounded'].includes(mode)) {
    return 'bounded';
  }
  if (['advisory', 'weighted', 'default', 'off', 'disabled'].includes(mode)) {
    return 'advisory';
  }
  return null;
}

function normalizedRepoPathVariants(p) {
  return repoRelativePathVariants(normalizePath(p))
    .map(item => normalizePath(item).toLowerCase())
    .filter(Boolean);
}

function resolvePath(repoRoot, p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

function resolveRepoRoot(config) {
  return resolveSharedRepoRoot(config?.repo_root, process.cwd());
}

function resolveContextMapPath(repoRoot, config) {
  const candidates = [
    config?.paths?.generated_context_map,
    config?.context?.map_file,
    config?.paths?.context_map,
    'sherlog.context.json',
  ];

  for (const candidate of candidates) {
    const resolved = resolvePath(repoRoot, candidate);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }

  return path.join(repoRoot, 'sherlog.context.json');
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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

function collapseAlphaNumeric(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function textMatchesToken(text, token) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(token || '').trim().toLowerCase();
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;

  const collapsedNeedle = collapseAlphaNumeric(needle);
  if (collapsedNeedle.length >= 5 && collapseAlphaNumeric(haystack).includes(collapsedNeedle)) {
    return true;
  }

  if (/^[a-z0-9_-]+$/.test(needle)) {
    const bounded = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`);
    if (bounded.test(haystack)) return true;
  }

  return false;
}

function looksLikeGlob(value) {
  return /[*?[\]]/.test(String(value || ''));
}

function pathMatchesHint(relPath, hint) {
  const pathVariants = normalizedRepoPathVariants(relPath);
  const hintVariants = normalizedRepoPathVariants(hint);
  if (pathVariants.length === 0 || hintVariants.length === 0) return false;

  return hintVariants.some(normalizedHint => {
    if (looksLikeGlob(normalizedHint)) {
      return pathVariants.some(normalizedPath => pathMatchesGlob(normalizedPath, normalizedHint));
    }
    return pathVariants.some(normalizedPath => textMatchesToken(normalizedPath, normalizedHint));
  });
}

function matchesScopedPath(relPath, hints = []) {
  if (!Array.isArray(hints) || hints.length === 0) return false;
  return hints.some(hint => pathMatchesHint(relPath, hint));
}

function textIncludesAny(text, probes = []) {
  return probes.some(probe => textMatchesToken(text, probe));
}

function normalizeIndexPhrase(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildIndexMatcher(featureName, aliases = []) {
  const phrases = dedupeCaseInsensitive([featureName, ...(Array.isArray(aliases) ? aliases : [])]);
  const normalizedPhrases = phrases.map(normalizeIndexPhrase).filter(Boolean);
  if (normalizedPhrases.length === 0) {
    return {
      strictTokens: [],
      wordTokens: [],
    };
  }

  const strictTokenSet = new Set();
  const wordTokenSet = new Set();
  normalizedPhrases.forEach(phrase => {
    const words = phrase.split('-').filter(Boolean);
    strictTokenSet.add(phrase);
    strictTokenSet.add(phrase.replace(/-/g, ''));
    strictTokenSet.add(words.join('_'));
    strictTokenSet.add(words.join('-'));
    strictTokenSet.add(words.join(''));
    words
      .filter(word => word.length >= 3 && !GENERIC_SIGNAL_TOKENS.has(word) && !LOW_SIGNAL_REQUEST_TOKENS.has(word))
      .forEach(word => wordTokenSet.add(word));
  });

  return {
    strictTokens: Array.from(strictTokenSet).filter(Boolean),
    wordTokens: Array.from(wordTokenSet).filter(Boolean),
  };
}

function tokenizeIndexText(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !GENERIC_SIGNAL_TOKENS.has(token));
}

function tokenDocumentFrequency(modules = []) {
  const counts = new Map();
  for (const mod of modules) {
    const tokenSet = new Set(tokenizeIndexText(mod.path));
    for (const symbol of Array.isArray(mod.exports) ? mod.exports : []) {
      tokenizeIndexText(symbol).forEach(token => tokenSet.add(token));
    }
    for (const token of tokenSet) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

function scoreIndexText(text, matcher, docFrequency, totalModules) {
  const haystack = String(text || '').toLowerCase();
  const tokens = new Set(tokenizeIndexText(text));
  let score = 0;
  const reasons = [];

  for (const strictToken of matcher.strictTokens || []) {
    if (!strictToken) continue;
    if (haystack.includes(strictToken)) {
      score += 6;
      reasons.push(`strict:${strictToken}`);
      break;
    }
  }

  for (const token of matcher.wordTokens || []) {
    if (!tokens.has(token)) continue;
    const df = docFrequency.get(token) || totalModules;
    const rarity = df <= 3 ? 4 : df <= 12 ? 3 : df <= 32 ? 2 : 1;
    score += rarity;
    reasons.push(`token:${token}`);
  }

  return { score, reasons };
}

function confidenceForIndexScore(score) {
  if (score >= 10) return 'high';
  if (score >= 6) return 'medium';
  return 'low';
}

function analyzeFeatureIndex(selfModel, matcher, pathHints, directMatches) {
  if (!selfModel || !Array.isArray(selfModel.modules) || selfModel.modules.length === 0) {
    return {
      available: false,
      confidence: 'low',
      raw_feature_file_count: directMatches.size,
      indexed_feature_files: [],
      indexed_feature_matches: [],
      summary: null,
    };
  }

  const modules = selfModel.modules;
  const totalModules = modules.length;
  const totalEdges = Array.isArray(selfModel.edges) ? selfModel.edges.length : 0;
  const docFrequency = tokenDocumentFrequency(modules);
  const adjacency = new Map();

  for (const edge of Array.isArray(selfModel.edges) ? selfModel.edges : []) {
    const from = normalizePath(edge.from);
    const to = normalizePath(edge.resolved_to || edge.to);
    if (!from || !to) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    if (!adjacency.has(to)) adjacency.set(to, new Set());
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  }

  const matches = [];
  for (const mod of modules) {
    const filePath = normalizePath(mod.path);
    const reasons = [];
    let score = 0;

    if (Array.isArray(pathHints) && pathHints.some(hint => pathMatchesHint(filePath, hint))) {
      score += 10;
      reasons.push('path_hint');
    }

    if (directMatches.has(filePath)) {
      score += 5;
      reasons.push('direct_match');
    }

    const pathScore = scoreIndexText(filePath, matcher, docFrequency, totalModules);
    score += pathScore.score;
    reasons.push(...pathScore.reasons.map(reason => `path:${reason}`));

    for (const symbol of Array.isArray(mod.exports) ? mod.exports : []) {
      const symbolScore = scoreIndexText(symbol, matcher, docFrequency, totalModules);
      if (symbolScore.score <= 0) continue;
      score += Math.min(4, symbolScore.score);
      reasons.push(...symbolScore.reasons.map(reason => `export:${reason}`));
    }

    matches.push({
      path: filePath,
      score,
      reasons: Array.from(new Set(reasons)),
    });
  }

  const highSignal = new Set(matches.filter(item => item.score >= 8).map(item => item.path));
  for (const item of matches) {
    const neighbors = adjacency.get(item.path);
    if (!neighbors || neighbors.size === 0) continue;
    const linkedSignals = Array.from(neighbors).filter(neighbor => highSignal.has(neighbor));
    if (linkedSignals.length === 0) continue;
    item.score += Math.min(2, linkedSignals.length);
    item.reasons.push('graph:adjacent_to_high_signal');
  }

  const indexedMatches = matches
    .filter(item => item.score >= 6)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const strongest = indexedMatches[0]?.score || 0;
  return {
    available: true,
    confidence: confidenceForIndexScore(strongest),
    raw_feature_file_count: directMatches.size,
    indexed_feature_files: indexedMatches.map(item => item.path),
    indexed_feature_matches: indexedMatches.slice(0, 40),
    summary: {
      strongest_score: strongest,
      total_modules: totalModules,
      total_edges: totalEdges,
      matched_modules: indexedMatches.length,
    },
  };
}

function summarizeFeatureRisk(selfModel, candidateFiles = []) {
  if (!selfModel || !Array.isArray(selfModel.modules)) {
    return {
      available: false,
      matched_files: [],
      matched_modules: [],
      summary: null,
    };
  }

  const moduleByPath = new Map(
    selfModel.modules
      .filter(mod => mod && typeof mod === 'object')
      .map(mod => [normalizePath(mod.path), mod])
      .filter(([file]) => Boolean(file))
  );

  const matchedFiles = Array.from(new Set((candidateFiles || []).map(normalizePath).filter(file => moduleByPath.has(file))))
    .sort((left, right) => left.localeCompare(right));
  const matchedModules = matchedFiles.map(file => moduleByPath.get(file)).filter(Boolean);
  const livenessCounts = {
    Active: 0,
    Scaffold: 0,
    Dead: 0,
    Misleading: 0,
  };

  if (matchedModules.length === 0) {
    return {
      available: true,
      matched_files: [],
      matched_modules: [],
      summary: {
        matched_modules: 0,
        liveness_counts: livenessCounts,
        dead_or_scaffold_files: 0,
        misleading_files: 0,
        average_fragility: 0,
        peak_fragility: 0,
        peak_fragility_files: [],
        average_coupling: 0,
        peak_coupling: 0,
        peak_coupling_files: [],
        max_live_days_since_touch: 0,
        stale_live_files: [],
      },
    };
  }

  let fragilityTotal = 0;
  let couplingTotal = 0;
  let peakFragility = 0;
  let peakCoupling = 0;

  matchedModules.forEach(mod => {
    const category = String(mod?.liveness?.category || 'Active');
    if (!Object.prototype.hasOwnProperty.call(livenessCounts, category)) {
      livenessCounts[category] = 0;
    }
    livenessCounts[category] += 1;

    const fragility = Number(mod?.fragility?.score || 0);
    const coupling = Number(mod?.coupling?.total || 0);
    fragilityTotal += fragility;
    couplingTotal += coupling;
    peakFragility = Math.max(peakFragility, fragility);
    peakCoupling = Math.max(peakCoupling, coupling);
  });

  const peakFragilityFiles = matchedModules
    .filter(mod => Number(mod?.fragility?.score || 0) === peakFragility)
    .map(mod => mod.path)
    .slice(0, 5);
  const peakCouplingFiles = matchedModules
    .filter(mod => Number(mod?.coupling?.total || 0) === peakCoupling)
    .map(mod => mod.path)
    .slice(0, 5);
  const staleLiveFiles = matchedModules
    .filter(mod => {
      const category = String(mod?.liveness?.category || 'Active');
      const days = Number(mod?.activity?.days_since_last_commit);
      return (category === 'Active' || category === 'Misleading') && Number.isFinite(days) && days >= 30;
    })
    .map(mod => ({
      path: mod.path,
      days_since_last_commit: Number(mod.activity.days_since_last_commit),
      liveness: mod.liveness.category,
    }))
    .sort((left, right) => right.days_since_last_commit - left.days_since_last_commit);
  const maxLiveDaysSinceTouch = staleLiveFiles.length > 0
    ? Number(staleLiveFiles[0].days_since_last_commit || 0)
    : 0;

  return {
    available: true,
    matched_files: matchedFiles,
    matched_modules: matchedModules.map(mod => ({
      path: mod.path,
      lines: Number(mod?.lines || 0),
      fragility: mod?.fragility || { score: 0, label: 'low' },
      coupling: mod?.coupling || { inbound: 0, outbound: 0, total: 0 },
      liveness: mod?.liveness || { category: 'Active' },
      activity: mod?.activity || null,
    })),
    summary: {
      matched_modules: matchedModules.length,
      liveness_counts: livenessCounts,
      dead_or_scaffold_files: Number(livenessCounts.Dead || 0) + Number(livenessCounts.Scaffold || 0),
      misleading_files: Number(livenessCounts.Misleading || 0),
      average_fragility: round(fragilityTotal / matchedModules.length, 2),
      peak_fragility: peakFragility,
      peak_fragility_files: peakFragilityFiles,
      average_coupling: round(couplingTotal / matchedModules.length, 2),
      peak_coupling: peakCoupling,
      peak_coupling_files: peakCouplingFiles,
      max_live_days_since_touch: maxLiveDaysSinceTouch,
      stale_live_files: staleLiveFiles,
    },
  };
}

function pathIncludesToken(filePath, lowerName, tokens, extensions = null, pathHints = []) {
  if (extensions && !extensions.some(ext => lowerName.endsWith(ext))) return false;
  const lowerPath = filePath.toLowerCase();
  if (tokens.some(token => textMatchesToken(lowerName, token) || textMatchesToken(lowerPath, token))) return true;
  return pathHints.some(hint => pathMatchesHint(lowerPath, hint));
}

function matchingPathTriggers(relPath, tokens = [], pathHints = []) {
  const lowerPath = normalizePath(relPath).toLowerCase();
  const matchedTokens = dedupeTokens(tokens.filter(token => textMatchesToken(lowerPath, token))).slice(0, 6);
  const matchedHints = dedupeCaseInsensitive((pathHints || []).filter(hint => pathMatchesHint(lowerPath, hint))).slice(0, 4);
  const triggers = matchedTokens.map(token => `token:${token}`);
  matchedHints.forEach(hint => triggers.push(`path_hint:${hint}`));
  return triggers;
}

function normalizeLaneMode(value) {
  const mode = String(value || 'strict').trim().toLowerCase();
  if (mode === 'excluded') return 'excluded';
  if (mode === 'relaxed') return 'relaxed';
  return 'strict';
}

function normalizeLaneDefinition(nameHint, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = String(entry.name || nameHint || '').trim().toLowerCase();
  if (!name) return null;

  const include = [
    ...toStringArray(entry.include),
    ...toStringArray(entry.includes),
    ...toStringArray(entry.paths),
  ].map(item => normalizePath(item).toLowerCase()).filter(Boolean);
  const exclude = [
    ...toStringArray(entry.exclude),
    ...toStringArray(entry.excludes),
    ...toStringArray(entry.ignore),
  ].map(item => normalizePath(item).toLowerCase()).filter(Boolean);

  return {
    name,
    mode: normalizeLaneMode(entry.mode),
    include: dedupeCaseInsensitive(include),
    exclude: dedupeCaseInsensitive(exclude),
  };
}

function laneDefinitionsFromConfig(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeLaneDefinition(item?.name || null, item))
      .filter(Boolean);
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => normalizeLaneDefinition(key, entry))
      .filter(Boolean);
  }
  return [];
}

function mergeLaneDefinitions(base = [], overrides = []) {
  const merged = new Map();
  base.forEach(entry => merged.set(entry.name, entry));
  overrides.forEach(entry => merged.set(entry.name, entry));
  return Array.from(merged.values());
}

function resolvePathLanes(config, probes = {}) {
  const defaultLanes = [
    { name: 'core', mode: 'strict', include: [], exclude: [] },
    {
      name: 'legacy',
      mode: 'relaxed',
      include: [
        'legacy/**',
        'archive/**',
        'deprecated/**',
        'prototype/**',
        'prototypes/**',
        'experimental/**',
        'sandbox/**',
      ],
      exclude: [],
    },
  ];

  const configured = laneDefinitionsFromConfig(config?.settings?.path_lanes);
  const profileOverrides = Array.isArray(probes?.lane_overrides) ? probes.lane_overrides : [];

  const laneList = mergeLaneDefinitions(
    configured.length > 0 ? configured : defaultLanes,
    profileOverrides
  );
  const defaultLaneName = String(
    config?.settings?.path_lanes_default
    || config?.settings?.default_path_lane
    || 'core'
  ).trim().toLowerCase();
  const hasDefault = laneList.some(lane => lane.name === defaultLaneName);

  return {
    lanes: hasDefault ? laneList : [{ name: defaultLaneName || 'core', mode: 'strict', include: [], exclude: [] }, ...laneList],
    default_lane: defaultLaneName || 'core',
  };
}

function laneForPath(relPath, laneConfig) {
  const normalized = normalizePath(relPath).toLowerCase();
  const lanes = Array.isArray(laneConfig?.lanes) ? laneConfig.lanes : [];

  for (const lane of lanes) {
    const includeList = Array.isArray(lane.include) ? lane.include : [];
    const excludeList = Array.isArray(lane.exclude) ? lane.exclude : [];
    if (includeList.length === 0) continue;
    const includeMatch = includeList.some(pattern => pathMatchesHint(normalized, pattern));
    if (!includeMatch) continue;

    const excluded = excludeList.some(pattern => pathMatchesHint(normalized, pattern));
    if (excluded) continue;
    return lane;
  }

  const defaultLane = lanes.find(lane => lane.name === laneConfig.default_lane);
  if (defaultLane) {
    const excluded = (defaultLane.exclude || []).some(pattern => pathMatchesHint(normalized, pattern));
    if (!excluded) return defaultLane;
  }

  return defaultLane || { name: laneConfig.default_lane || 'core', mode: 'strict', include: [], exclude: [] };
}

function resolveLaneMultipliers(config, probes = {}) {
  const base = {
    strict: Number(config?.settings?.lane_multipliers?.strict ?? 1),
    relaxed: Number(config?.settings?.lane_multipliers?.relaxed ?? 0.35),
    excluded: Number(config?.settings?.lane_multipliers?.excluded ?? 0),
  };

  const overrides = probes?.convergence_overrides?.lane_multipliers || {};
  Object.entries(overrides).forEach(([mode, value]) => {
    const normalizedMode = normalizeLaneMode(mode);
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    base[normalizedMode] = numeric;
  });

  return {
    strict: Number.isFinite(base.strict) ? base.strict : 1,
    relaxed: Number.isFinite(base.relaxed) ? base.relaxed : 0.35,
    excluded: Number.isFinite(base.excluded) ? base.excluded : 0,
  };
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

function findTestRoots(repoRoot, configuredRoots = []) {
  const configured = findExistingRoots(repoRoot, configuredRoots);
  if (configured.length > 0) return configured;

  const discovered = detectInstalledTestRoots(repoRoot, detectInstalledSourceRoots(repoRoot));
  if (discovered.length > 0) {
    return discovered.map(relPath => path.join(repoRoot, relPath));
  }

  return findExistingRoots(repoRoot, [], ['tests', 'test', '__tests__']);
}

function findDocsRoot(repoRoot, config) {
  const configured = config?.paths?.docs_dir;
  if (configured) {
    const candidate = path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }

  const reportPath = config?.paths?.report_output_markdown;
  if (reportPath) {
    const parent = path.dirname(reportPath);
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) return parent;
  }

  const defaults = ['docs', 'documentation', 'wiki'];
  for (const dir of defaults) {
    const candidate = path.join(repoRoot, dir);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }

  return null;
}

function listRepoFiles(repoRoot, ignoreRules = { names: DEFAULT_IGNORED_DIRS, prefixes: [] }) {
  const relFiles = [];
  walk(repoRoot, fullPath => {
    relFiles.push(normalizePath(path.relative(repoRoot, fullPath)));
  }, 120000, ignoreRules, repoRoot);
  return relFiles;
}

function isPathInsidePrefix(relPath, prefixes) {
  const p = normalizePath(relPath);
  return prefixes.some(prefix => {
    const normalizedPrefix = normalizePath(prefix);
    if (!normalizedPrefix) return true;
    return p === normalizedPrefix || p.startsWith(`${normalizedPrefix}/`);
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentMatches(fileSegment, globSegment) {
  if (globSegment === '**') return true;
  const regex = new RegExp(
    `^${escapeRegExp(globSegment).replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')}$`
  );
  return regex.test(fileSegment);
}

function matchGlobSegments(fileSegments, globSegments, fi = 0, gi = 0) {
  if (gi >= globSegments.length) return fi >= fileSegments.length;
  const globSegment = globSegments[gi];

  if (globSegment === '**') {
    if (gi === globSegments.length - 1) return true;
    for (let k = fi; k <= fileSegments.length; k++) {
      if (matchGlobSegments(fileSegments, globSegments, k, gi + 1)) return true;
    }
    return false;
  }

  if (fi >= fileSegments.length) return false;
  if (!segmentMatches(fileSegments[fi], globSegment)) return false;
  return matchGlobSegments(fileSegments, globSegments, fi + 1, gi + 1);
}

function pathMatchesGlob(relPath, pattern) {
  const file = normalizePath(relPath).toLowerCase();
  const glob = normalizePath(pattern).toLowerCase();
  if (!glob) return false;

  const fileSegments = file.split('/').filter(Boolean);
  const globSegments = glob.split('/').filter(Boolean);
  if (fileSegments.length === 0 || globSegments.length === 0) return false;
  return matchGlobSegments(fileSegments, globSegments);
}

function weightedHitCount(hits = [], laneMultipliers = { strict: 1, relaxed: 0.35, excluded: 0 }) {
  return hits.reduce((sum, hit) => {
    const mode = normalizeLaneMode(hit?.lane_mode || 'strict');
    const weight = Number(laneMultipliers?.[mode] ?? (mode === 'relaxed' ? 0.35 : mode === 'excluded' ? 0 : 1));
    return sum + (Number.isFinite(weight) ? weight : 0);
  }, 0);
}

function summarizeHits(hits = [], laneMultipliers = { strict: 1, relaxed: 0.35, excluded: 0 }, target = 1) {
  const byMode = { strict: 0, relaxed: 0, excluded: 0 };
  hits.forEach(hit => {
    const mode = normalizeLaneMode(hit?.lane_mode || 'strict');
    byMode[mode] += 1;
  });

  const weightedHits = weightedHitCount(hits, laneMultipliers);
  const divisor = Number.isFinite(target) && target > 0 ? target : 1;
  const score = clamp(weightedHits / divisor, 0, 1);
  return {
    hits: hits.length,
    weighted_hits: round(weightedHits, 3),
    score: round(score, 3),
    by_mode: byMode,
  };
}

function weightedAverage(values = {}, weights = {}) {
  let numerator = 0;
  let denominator = 0;

  Object.entries(weights || {}).forEach(([key, rawWeight]) => {
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) return;
    const value = Number(values?.[key] ?? 0);
    numerator += value * weight;
    denominator += weight;
  });

  if (denominator <= 0) return 0;
  return clamp(numerator / denominator, 0, 1);
}

function readLowerContent(repoRoot, relPath, cache) {
  if (cache.has(relPath)) return cache.get(relPath);
  const fullPath = path.join(repoRoot, relPath);
  let lower = '';
  try {
    lower = fs.readFileSync(fullPath, 'utf8').toLowerCase();
  } catch {
    lower = '';
  }
  cache.set(relPath, lower);
  return lower;
}

function resolveConvergenceConfig(config, probes = {}) {
  const defaults = {
    thresholds: {
      implementation: 0.5,
      tests: 0.45,
      docs: 0.5,
      overall: 0.45,
    },
    weights: {
      implementation: { path: 0.45, export: 0.35, callsite: 0.2 },
      tests: { path: 0.65, content: 0.35 },
      docs: { path: 0.55, content: 0.45 },
      overall: { implementation: 0.45, tests: 0.3, docs: 0.25 },
    },
    saturation: {
      path: 1,
      export: 1,
      callsite: 2,
      content: 1,
    },
  };

  function mergeThresholds(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      const normalized = String(key || '').trim().toLowerCase();
      const numeric = Number(value);
      if (!normalized || !Number.isFinite(numeric)) return;
      defaults.thresholds[normalized] = numeric;
    });
  }

  function mergeWeightGroup(group, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      const normalized = String(key || '').trim().toLowerCase();
      const numeric = Number(value);
      if (!normalized || !Number.isFinite(numeric)) return;
      if (!defaults.weights[group]) defaults.weights[group] = {};
      defaults.weights[group][normalized] = numeric;
    });
  }

  function mergeWeights(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      const normalized = String(key || '').trim().toLowerCase();
      if (!normalized) return;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        mergeWeightGroup(normalized, value);
        return;
      }

      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return;
      const [group, metric] = normalized.split('_');
      if (!group || !metric) return;
      if (!defaults.weights[group]) defaults.weights[group] = {};
      defaults.weights[group][metric] = numeric;
    });
  }

  function mergeSaturation(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    Object.entries(source).forEach(([key, value]) => {
      const normalized = String(key || '').trim().toLowerCase();
      const numeric = Number(value);
      if (!normalized || !Number.isFinite(numeric) || numeric <= 0) return;
      defaults.saturation[normalized] = numeric;
    });
  }

  mergeThresholds(config?.settings?.convergence_thresholds);
  mergeWeights(config?.settings?.convergence_weights);
  mergeSaturation(config?.settings?.convergence_saturation);

  mergeThresholds(probes?.convergence_overrides?.thresholds);
  mergeWeights(probes?.convergence_overrides?.weights);
  mergeSaturation(probes?.convergence_overrides?.saturation);

  return defaults;
}

function parseLastUpdated(rawValue) {
  const raw = rawValue ? String(rawValue).trim() : '';
  if (!raw) return { value: null, epoch: null, granularity: null };

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const normalized = dateOnly ? `${raw}T00:00:00Z` : raw;
  const epoch = Math.floor(new Date(normalized).getTime() / 1000);

  return {
    value: raw,
    epoch: Number.isFinite(epoch) ? epoch : null,
    granularity: dateOnly ? 'date' : 'datetime',
  };
}

function areaIsStale(latestCommitEpoch, area) {
  if (!Number.isFinite(latestCommitEpoch) || !Number.isFinite(area?.last_updated_epoch)) return false;
  if (area.last_updated_granularity === 'date') {
    const latestDay = Math.floor(latestCommitEpoch / 86400);
    const updatedDay = Math.floor(area.last_updated_epoch / 86400);
    return latestDay > updatedDay;
  }
  return latestCommitEpoch > area.last_updated_epoch;
}

function lagDaysForArea(latestCommitEpoch, area) {
  if (!Number.isFinite(latestCommitEpoch) || !Number.isFinite(area?.last_updated_epoch)) return 0;
  if (area.last_updated_granularity === 'date') {
    const latestDay = Math.floor(latestCommitEpoch / 86400);
    const updatedDay = Math.floor(area.last_updated_epoch / 86400);
    return Number((latestDay - updatedDay).toFixed(1));
  }
  return Number(((latestCommitEpoch - area.last_updated_epoch) / 86400).toFixed(1));
}

function normalizeArea(area, idx) {
  const name = area?.name || `area_${idx + 1}`;
  const paths = Array.isArray(area?.paths)
    ? area.paths.map(normalizePath).filter(Boolean)
    : [];
  const lastUpdated = parseLastUpdated(area?.last_updated || area?.lastUpdated || null);
  const shipReady = Boolean(area?.ship_ready);
  const criticalArtifacts = Array.isArray(area?.critical_artifacts)
    ? area.critical_artifacts.filter(a => a && typeof a.path === 'string')
    : [];
  return {
    name,
    paths,
    belief: area?.belief || null,
    last_updated: lastUpdated.value,
    last_updated_epoch: lastUpdated.epoch,
    last_updated_granularity: lastUpdated.granularity,
    ship_ready: shipReady,
    critical_artifacts: criticalArtifacts,
  };
}

function resolveContextMapCandidates(repoRoot, config) {
  const candidates = [];

  const contextMap = resolvePath(repoRoot, config?.context?.map_file);
  if (contextMap) candidates.push(contextMap);

  const pathMap = resolvePath(repoRoot, config?.paths?.context_map);
  if (pathMap) candidates.push(pathMap);

  candidates.push(path.join(repoRoot, 'sherlog.context.json'));

  const seen = new Set();
  return candidates.filter(candidate => {
    const key = normalizePath(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadContextMap(repoRoot, config) {
  const candidates = resolveContextMapCandidates(repoRoot, config);
  let anyExisting = false;
  const notes = [];

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) continue;
    anyExisting = true;

    const parsed = readJson(candidate, null);
    if (!parsed) {
      notes.push(`map_parse_failed:${path.basename(candidate)}`);
      continue;
    }

    if (Array.isArray(parsed.zones)) {
      return {
        map_path: candidate,
        map_mode: 'sherlog-map',
        map_exists: true,
        map_valid: true,
        areas: parsed.zones.map(normalizeArea).filter(Boolean),
        notes,
      };
    }

    notes.push(`map_missing_zones:${path.basename(candidate)}`);
  }

  return {
    map_path: candidates[0] || path.join(repoRoot, 'sherlog.context.json'),
    map_mode: 'none',
    map_exists: anyExisting,
    map_valid: false,
    areas: [],
    notes,
  };
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function latestCommitEpochForPaths(repoRoot, relPaths) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return null;
  const sample = relPaths.slice(0, 200);
  const cmd = `git log -1 --format=%ct -- ${sample.map(shellQuote).join(' ')}`;
  try {
    const out = execSync(cmd, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function gitLines(repoRoot, args = []) {
  try {
    const out = execSync(`git ${args.join(' ')}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function gitValue(repoRoot, args = []) {
  const lines = gitLines(repoRoot, args);
  return lines[0] || null;
}

function changelogPathForRepo(repoRoot) {
  return path.join(repoRoot, 'CHANGELOG.md');
}

function pathLooksLikeUiSurface(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized.startsWith('site/')
    || normalized.startsWith('web/')
    || normalized.startsWith('app/')
    || normalized.includes('/pages/')
    || normalized.includes('/components/')
    || normalized.includes('/layouts/')
    || normalized.includes('/styles/')
    || normalized.includes('extension.js')
    || normalized.includes('panel')
    || normalized.includes('view')
    || normalized.includes('ui')
  );
}

function pathLooksLikeContractSurface(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized.includes('/src/cli/')
    || normalized.includes('/cli/')
    || normalized.includes('debug')
    || normalized.includes('bridge')
    || normalized.includes('sonar')
    || normalized.includes('profile-check-service')
    || normalized.endsWith('.json')
    || normalized.endsWith('.schema.json')
  );
}

function isGeneratedOrArtifactPath(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized.startsWith('.repomix/')
    || normalized.startsWith('velocity-artifacts/')
    || normalized.startsWith('.logs/')
    || normalized.startsWith('coverage/')
    || normalized.endsWith('.code-workspace')
  );
}

function isDocumentationPath(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized === 'changelog.md'
    || normalized === 'readme.md'
    || normalized.startsWith('docs/')
    || normalized.endsWith('.md')
    || normalized.endsWith('.mdx')
    || normalized.endsWith('.rst')
    || normalized.endsWith('.txt')
  );
}

function isTestPath(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.endsWith('.test.js')
    || normalized.endsWith('.spec.js')
    || normalized.endsWith('.test.ts')
    || normalized.endsWith('.spec.ts')
    || normalized.endsWith('.test.tsx')
    || normalized.endsWith('.spec.tsx')
    || normalized.endsWith('.test.jsx')
    || normalized.endsWith('.spec.jsx')
  );
}

function isProfileEvidencePath(relPath) {
  const normalized = normalizePath(relPath).toLowerCase();
  return (
    normalized === 'sherlog.feature-profiles.json'
    || normalized === 'sherlog.context.json'
    || normalized.endsWith('/sherlog.context.json')
    || normalized.endsWith('/sherlog.feature-profiles.json')
  );
}

function isImplementationPath(relPath, sourcePrefixes = []) {
  const normalized = normalizePath(relPath);
  if (isGeneratedOrArtifactPath(normalized) || isDocumentationPath(normalized) || isTestPath(normalized)) {
    return false;
  }
  return isPathInsidePrefix(normalized, sourcePrefixes);
}

function uniqueSorted(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function analyzeChangelogAudit(repoRoot, sourcePrefixes = [], scopedFeatureFiles = []) {
  const changelogPath = changelogPathForRepo(repoRoot);
  const relChangelogPath = normalizePath(path.relative(repoRoot, changelogPath));
  const exists = fs.existsSync(changelogPath) && fs.statSync(changelogPath).isFile();
  const featureSet = new Set((Array.isArray(scopedFeatureFiles) ? scopedFeatureFiles : []).map(normalizePath));
  const empty = {
    enabled: exists,
    path: exists ? relChangelogPath : null,
    exists,
    last_updated_commit: null,
    last_updated_at: null,
    changed_files_since_last_update: [],
    implementation_changes: [],
    test_changes: [],
    profile_changes: [],
    user_facing_changes: [],
    contract_changes: [],
    feature_related_changes: [],
    last_update_commit_files: [],
    last_update_supporting_files: [],
    status: exists ? 'clean' : 'missing',
  };
  if (!exists) return empty;

  const lastCommit = gitValue(repoRoot, ['log', '-1', '--format=%H', '--', shellQuote(relChangelogPath)]);
  const lastCommitAt = gitValue(repoRoot, ['log', '-1', '--format=%cI', '--', shellQuote(relChangelogPath)]);
  if (!lastCommit) {
    return {
      ...empty,
      status: 'untracked',
    };
  }

  const changedSince = gitLines(repoRoot, ['diff', '--name-only', `${lastCommit}..HEAD`])
    .map(normalizePath)
    .filter(file => file !== relChangelogPath);
  const lastUpdateCommitFiles = gitLines(repoRoot, ['show', '--pretty=format:', '--name-only', lastCommit])
    .map(normalizePath)
    .filter(file => file !== relChangelogPath);

  const implementationChanges = changedSince.filter(file => isImplementationPath(file, sourcePrefixes));
  const testChanges = changedSince.filter(file => isTestPath(file));
  const profileChanges = changedSince.filter(file => isProfileEvidencePath(file));
  const userFacingChanges = changedSince.filter(file => isImplementationPath(file, sourcePrefixes) && pathLooksLikeUiSurface(file));
  const contractChanges = changedSince.filter(file => isImplementationPath(file, sourcePrefixes) && pathLooksLikeContractSurface(file));
  const featureRelatedChanges = changedSince.filter(file => featureSet.has(file));
  const lastUpdateSupportingFiles = lastUpdateCommitFiles.filter(file => (
    isImplementationPath(file, sourcePrefixes)
    || isTestPath(file)
    || isProfileEvidencePath(file)
  ));

  let status = 'clean';
  if (
    implementationChanges.length > 0
    || testChanges.length > 0
    || profileChanges.length > 0
  ) {
    status = 'stale_after_feature_change';
  }
  if (
    userFacingChanges.length > 0
    || contractChanges.length > 0
    || featureRelatedChanges.length > 0
  ) {
    status = 'update_missing';
  }
  if (lastUpdateSupportingFiles.length === 0) {
    status = status === 'clean' ? 'scope_mismatch' : `${status}+scope_mismatch`;
  }

  return {
    enabled: true,
    path: relChangelogPath,
    exists: true,
    last_updated_commit: lastCommit,
    last_updated_at: lastCommitAt,
    changed_files_since_last_update: uniqueSorted(changedSince),
    implementation_changes: uniqueSorted(implementationChanges),
    test_changes: uniqueSorted(testChanges),
    profile_changes: uniqueSorted(profileChanges),
    user_facing_changes: uniqueSorted(userFacingChanges),
    contract_changes: uniqueSorted(contractChanges),
    feature_related_changes: uniqueSorted(featureRelatedChanges),
    last_update_commit_files: uniqueSorted(lastUpdateCommitFiles),
    last_update_supporting_files: uniqueSorted(lastUpdateSupportingFiles),
    status,
  };
}

function analyzeContextMap(repoRoot, config, tokens, featureFiles, allFiles, filterZones = []) {
  const loaded = loadContextMap(repoRoot, config);
  const configuredMode = config?.context?.mode || 'none';
  const enabled = configuredMode !== 'none' || loaded.map_mode !== 'none';

  // If --zone filter(s) provided, restrict areas to only those named zones
  let areas = loaded.areas;
  let zoneFiltered = false;
  if (Array.isArray(filterZones) && filterZones.length > 0) {
    const lowerZones = filterZones.map(z => z.toLowerCase().trim());
    areas = loaded.areas.filter(a => lowerZones.includes((a.name || '').toLowerCase().trim()));
    zoneFiltered = true;
  }

  const analysis = {
    enabled,
    map_mode: loaded.map_mode === 'none' ? configuredMode : loaded.map_mode,
    map_path: loaded.map_path,
    map_exists: loaded.map_exists,
    map_valid: loaded.map_valid,
    areas_count: areas.length,
    total_areas_count: loaded.areas.length,
    zone_filter: zoneFiltered ? filterZones : null,
    stale_areas: [],
    drift_areas: [],
    covered_feature_files: [],
    uncovered_feature_files: [],
    feature_file_count: featureFiles.length,
    notes: [...(loaded.notes || [])],
    warnings: [],
  };

  if (!enabled) return analysis;
  if (!analysis.map_exists) {
    analysis.notes.push('context_map_missing');
    return analysis;
  }
  if (!analysis.map_valid) {
    analysis.notes.push('context_map_invalid');
    return analysis;
  }
  if (loaded.areas.length === 0) {
    analysis.notes.push('context_map_empty');
    return analysis;
  }
  if (zoneFiltered && areas.length === 0) {
    analysis.notes.push(`zone_filter_matched_nothing:${filterZones.join(',')}`);
    return analysis;
  }

  const featureCoverage = new Map(featureFiles.map(rel => [rel, false]));
  const shipReadyZones = [];
  const criticalArtifactGaps = [];

  for (const area of areas) {
    if (!area.paths.length) {
      analysis.drift_areas.push({
        area: area.name,
        reason: 'missing_paths',
      });
      continue;
    }

    const areaFiles = allFiles.filter(file => area.paths.some(pattern => pathMatchesHint(file, pattern)));
    if (areaFiles.length === 0) {
      const featureTouchesArea = featureFiles.some(file => area.paths.some(pattern => pathMatchesHint(file, pattern)));
      if (featureTouchesArea) {
        analysis.drift_areas.push({
          area: area.name,
          reason: 'scope_matches_no_files',
        });
      } else {
        analysis.notes.push(`area_scope_empty:${area.name}`);
      }
      continue;
    }

    featureFiles.forEach(file => {
      if (area.paths.some(pattern => pathMatchesHint(file, pattern))) {
        featureCoverage.set(file, true);
      }
    });

    // Track ship_ready zones for missing_implementation escalation
    if (area.ship_ready) {
      shipReadyZones.push(area.name);
    }

    // Check critical_artifacts — absence is a blocking gap (irreversibility)
    for (const artifact of area.critical_artifacts) {
      const artifactPattern = normalizePath(artifact.path);
      const found = allFiles.some(file => pathMatchesHint(file, artifactPattern) || normalizePath(file) === artifactPattern);
      if (!found) {
        criticalArtifactGaps.push({
          area: area.name,
          artifact: artifact.path,
          reason: artifact.reason || 'declared critical artifact missing',
        });
      }
    }

    // Diff-scoped belief decay: only enforce on zones where files were
    // touched AFTER the belief was last written. Untouched legacy stays advisory.
    if (Number.isFinite(area.last_updated_epoch)) {
      const latestCommit = latestCommitEpochForPaths(repoRoot, areaFiles);
      if (areaIsStale(latestCommit, area)) {
        const lagDays = lagDaysForArea(latestCommit, area);
        analysis.stale_areas.push({
          area: area.name,
          last_updated: area.last_updated,
          latest_commit_epoch: latestCommit,
          lag_days: lagDays,
          last_updated_granularity: area.last_updated_granularity || 'datetime',
          enforcement: 'required',
        });
      } else if (!latestCommit) {
        // No git history: zone untouched — staleness is advisory only
        analysis.notes.push(`no_git_history_for_area:${area.name}`);
      }
    } else {
      analysis.notes.push(`area_missing_last_updated:${area.name}`);
    }
  }

  analysis.covered_feature_files = Array.from(featureCoverage.entries())
    .filter(([, covered]) => covered)
    .map(([file]) => file);
  analysis.uncovered_feature_files = Array.from(featureCoverage.entries())
    .filter(([, covered]) => !covered)
    .map(([file]) => file);

  if (analysis.uncovered_feature_files.length > 0) {
    const outsideContextNotes = analysis.uncovered_feature_files.map(file => `feature_files_outside_context_map:${file}`);
    analysis.notes.push(...outsideContextNotes);

    const threshold = resolveOutsideContextWarningThreshold(config);
    if (analysis.uncovered_feature_files.length >= threshold) {
      analysis.warnings.push({
        code: 'feature_files_outside_context_map',
        level: 'warn',
        count: analysis.uncovered_feature_files.length,
        threshold,
      });
      analysis.notes.push(
        `warning_threshold_reached:feature_files_outside_context_map:${analysis.uncovered_feature_files.length}/${threshold}`
      );
    }
  }

  if (tokens.length > 0 && featureFiles.length > 0 && analysis.covered_feature_files.length === 0) {
    analysis.notes.push('feature_not_covered_by_any_area');
  }

  // Expose ship_ready and critical artifact signals for downstream severity routing
  analysis.ship_ready_zones = shipReadyZones;
  analysis.critical_artifact_gaps = criticalArtifactGaps;

  return analysis;
}

function normalizeGapType(gap) {
  return String(gap || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function normalizeGapAliasTable(table = {}) {
  const normalized = {};
  Object.entries(table || {}).forEach(([key, aliases]) => {
    const normalizedKey = normalizeGapType(key);
    if (!normalizedKey) return;
    const normalizedAliases = Array.isArray(aliases)
      ? aliases.map(alias => normalizeGapType(alias)).filter(Boolean)
      : [];
    normalized[normalizedKey] = Array.from(new Set([normalizedKey, ...normalizedAliases]));
  });
  return normalized;
}

function resolveHygieneConfig(config = {}, options = {}) {
  const settings = config?.settings || {};
  const hygieneSettings = settings?.hygiene || {};
  const enabled = options?.include_hygiene !== false && hygieneSettings?.enabled !== false;
  const typeFilter = Array.isArray(hygieneSettings?.include_types)
    ? hygieneSettings.include_types.map(type => String(type || '').trim()).filter(Boolean)
    : null;

  return {
    enabled,
    typeFilter,
  };
}

function mapHygieneFindingsToGapKeys(hygieneSummary = {}) {
  const byType = hygieneSummary?.by_type || {};
  const mapped = new Set();

  if ((byType.todo_cluster || 0) > 0) mapped.add('hygiene_todo_cluster');
  if ((byType.console_log || 0) > 0) mapped.add('hygiene_console_log');
  if ((byType.excessive_any || 0) > 0) mapped.add('hygiene_any_abuse');
  if ((byType.monolith || 0) > 0 || (byType.monolith_size || 0) > 0) mapped.add('arch_monolith');
  if ((byType.nesting_depth || 0) > 0) mapped.add('arch_complexity_hotspot');
  if ((byType.missing_docs || 0) > 0) mapped.add('arch_missing_docs');
  if ((byType.unreachable_code || 0) > 0) mapped.add('dead_code_unreachable');
  if ((byType.unused_variable || 0) > 0 || (byType.unused_function || 0) > 0) mapped.add('dead_code_unused_symbol');
  if ((byType.dead_branch || 0) > 0) mapped.add('dead_code_dead_branch');

  return Array.from(mapped);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatIsoDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function parseEpoch(input) {
  if (!input) return null;
  const epoch = Math.floor(new Date(input).getTime() / 1000);
  return Number.isFinite(epoch) ? epoch : null;
}

function resolveGapHistoryPath(repoRoot, config) {
  const configured = resolvePath(repoRoot, config?.paths?.gap_history_log);
  if (configured) return configured;
  return path.resolve(__dirname, '../../data/gap-history.jsonl');
}

function resolveGapAcknowledgementsPath(repoRoot, config) {
  const configured = resolvePath(repoRoot, config?.paths?.gap_acknowledgements);
  if (configured) return configured;
  return path.join(repoRoot, 'sherlog.acknowledgements.json');
}

function loadGapHistory(repoRoot, config) {
  const historyPath = resolveGapHistoryPath(repoRoot, config);
  const rows = readJsonLines(historyPath).filter(Boolean);
  return {
    path: historyPath,
    rows,
  };
}

function appendGapHistoryRow(historyPath, row) {
  if (!historyPath) return false;
  try {
    const parent = path.dirname(historyPath);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.appendFileSync(historyPath, `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeAcknowledgement(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const featureKey = normalizeFeature(entry.feature || entry.feature_key || '*') || '*';
  const gap = normalizeGapType(entry.gap || '*') || '*';
  const status = String(entry.status || 'deferred').trim().toLowerCase();
  let normalizedStatus = 'deferred';
  if (status === 'exempt') normalizedStatus = 'exempt';
  else if (status === 'open') normalizedStatus = 'open';
  const recordedAt = formatIsoDate(entry.recorded_at || entry.created_at || null);
  const recordedEpoch = parseEpoch(recordedAt);
  const expiresAt = formatIsoDate(entry.expires_at || entry.defer_until || null);
  const expiresEpoch = parseEpoch(expiresAt);
  const reviewedAt = formatIsoDate(entry.reviewed_at || entry.last_reviewed_at || null);
  const reviewedEpoch = parseEpoch(reviewedAt);
  const auditEveryDays = Number(entry.audit_every_days ?? entry.audit_interval_days ?? 30);

  return {
    id: entry.id || `ack_${index + 1}`,
    feature_key: featureKey,
    gap,
    status: normalizedStatus,
    reason: entry.reason || null,
    recorded_at: recordedAt,
    recorded_epoch: recordedEpoch,
    expires_at: expiresAt,
    expires_epoch: expiresEpoch,
    reviewed_at: reviewedAt,
    reviewed_epoch: reviewedEpoch,
    audit_every_days: Number.isFinite(auditEveryDays) && auditEveryDays > 0 ? auditEveryDays : 30,
    source: entry.source || null,
    source_ref: entry.source_ref || null,
  };
}

function loadAcknowledgements(repoRoot, config) {
  const ackPath = resolveGapAcknowledgementsPath(repoRoot, config);
  const parsed = readJson(ackPath, null);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
  return {
    path: ackPath,
    entries: rows.map(normalizeAcknowledgement).filter(Boolean),
  };
}

function selectAcknowledgement(entries, featureKey, gap) {
  const candidates = entries.filter(entry => {
    const featureMatch = entry.feature_key === '*' || entry.feature_key === featureKey;
    const gapMatch = entry.gap === '*' || entry.gap === gap;
    return featureMatch && gapMatch;
  });

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => (b.recorded_epoch || 0) - (a.recorded_epoch || 0))[0];
}

function evaluateAcknowledgement(entry, nowEpoch) {
  if (!entry) {
    return {
      state: 'none',
      active: false,
      expired: false,
      audit_due: false,
      score_multiplier: 1,
      reason: null,
      expires_at: null,
      audit_due_at: null,
    };
  }

  if (entry.status === 'open') {
    const expired = Boolean(entry.expires_epoch && entry.expires_epoch < nowEpoch);
    return {
      state: 'open',
      active: !expired,
      expired,
      audit_due: false,
      score_multiplier: 1,
      reason: entry.reason,
      expires_at: entry.expires_at,
      audit_due_at: null,
    };
  }

  if (entry.status === 'deferred') {
    const expired = Boolean(entry.expires_epoch && entry.expires_epoch < nowEpoch);
    return {
      state: 'deferred',
      active: !expired,
      expired,
      audit_due: false,
      score_multiplier: expired ? 1.25 : 1,
      reason: entry.reason,
      expires_at: entry.expires_at,
      audit_due_at: null,
    };
  }

  const baselineEpoch = entry.reviewed_epoch || entry.recorded_epoch || nowEpoch;
  const auditDueEpoch = baselineEpoch + (entry.audit_every_days * 86400);
  const auditDue = nowEpoch > auditDueEpoch;
  return {
    state: 'exempt',
    active: !auditDue,
    expired: false,
    audit_due: auditDue,
    score_multiplier: auditDue ? 1.2 : 0.85,
    reason: entry.reason,
    expires_at: null,
    audit_due_at: new Date(auditDueEpoch * 1000).toISOString(),
  };
}

function collectOpenAcknowledgementGaps(entries, featureKey, nowEpoch) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  return entries
    .filter(entry => {
      if (entry?.status !== 'open') return false;
      const featureMatch = entry.feature_key === '*' || entry.feature_key === featureKey;
      if (!featureMatch) return false;
      if (!entry.expires_epoch) return true;
      return entry.expires_epoch >= nowEpoch;
    })
    .map(entry => normalizeGapType(entry.gap))
    .filter(Boolean);
}

function featureHistoryRows(historyRows, featureKey) {
  return historyRows.filter(row => normalizeFeature(row?.feature_key || row?.feature || '') === featureKey);
}

function previousGapRun(historyRows, featureKey) {
  const rows = featureHistoryRows(historyRows, featureKey);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

function gapSet(row) {
  return new Set((Array.isArray(row?.gaps) ? row.gaps : []).map(normalizeGapType).filter(Boolean));
}

function consecutiveGapRuns(historyRows, featureKey, gap) {
  const rows = featureHistoryRows(historyRows, featureKey);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const set = gapSet(rows[i]);
    if (!set.has(gap)) break;
    streak += 1;
  }
  return streak;
}

function firstSeenEpoch(historyRows, featureKey, gap) {
  const rows = featureHistoryRows(historyRows, featureKey);
  for (const row of rows) {
    const set = gapSet(row);
    if (!set.has(gap)) continue;
    const epoch = parseEpoch(row.timestamp || row.recorded_at || null);
    if (epoch) return epoch;
  }
  return null;
}

function contextMetrics(evidence = {}) {
  const context = evidence.context_map || {};
  const staleAreas = Array.isArray(context.stale_areas) ? context.stale_areas : [];
  const driftAreas = Array.isArray(context.drift_areas) ? context.drift_areas : [];
  const uncovered = Array.isArray(context.uncovered_feature_files) ? context.uncovered_feature_files : [];

  return {
    feature_files: Number(evidence.feature_file_count || 0),
    stale_areas: staleAreas.length,
    drift_areas: driftAreas.length,
    uncovered_files: uncovered.length,
    max_lag_days: staleAreas.reduce((max, area) => Math.max(max, Number(area?.lag_days || 0)), 0),
  };
}

function blastRadiusForGap(gap, metrics) {
  const featureFiles = Math.max(1, metrics.feature_files || 1);
  let affectedFiles = featureFiles;
  let affectedAreas = 0;
  let level = 2;

  if (gap === 'missing_implementation') {
    level = 2 + (featureFiles >= 8 ? 2 : featureFiles >= 3 ? 1 : 0);
  } else if (gap === 'test_coverage') {
    level = 2 + (featureFiles >= 10 ? 2 : featureFiles >= 4 ? 1 : 0);
  } else if (gap === 'documentation') {
    level = 1 + (featureFiles >= 12 ? 1 : 0);
  } else if (gap === 'stale_context') {
    affectedAreas = Math.max(1, metrics.stale_areas);
    level = 3 + (affectedAreas >= 4 ? 2 : affectedAreas >= 2 ? 1 : 0);
  } else if (gap === 'context_drift') {
    affectedFiles = Math.max(1, metrics.uncovered_files || featureFiles);
    affectedAreas = Math.max(1, metrics.drift_areas + (metrics.uncovered_files > 0 ? 1 : 0));
    level = 3 + (affectedAreas >= 4 || affectedFiles >= 10 ? 2 : affectedAreas >= 2 || affectedFiles >= 4 ? 1 : 0);
  } else if (gap === 'missing_bundle') {
    affectedFiles = Math.max(1, metrics.uncovered_files || featureFiles);
    affectedAreas = Math.max(1, metrics.drift_areas || (metrics.uncovered_files > 0 ? 1 : 0));
    level = 3 + (affectedFiles >= 10 ? 2 : affectedFiles >= 4 ? 1 : 0);
  } else if (gap === 'integration') {
    level = 2 + (featureFiles >= 6 ? 1 : 0);
  } else if (gap === 'changelog_update_missing') {
    level = 2 + (featureFiles >= 6 ? 1 : 0);
  } else if (gap === 'changelog_scope_mismatch') {
    level = 2;
  } else if (gap === 'changelog_stale_after_feature_change') {
    level = 2 + (featureFiles >= 8 ? 1 : 0);
  }

  const clampedLevel = clamp(level, 1, 5);
  const scope = clampedLevel >= 4 ? 'cross-cutting' : clampedLevel >= 3 ? 'feature-wide' : 'local';
  return {
    level: clampedLevel,
    scope,
    affected_files: affectedFiles,
    affected_areas: affectedAreas,
  };
}

function temporalPressure(gap, metrics, ageDays) {
  const driftSignal = metrics.drift_areas + metrics.uncovered_files;
  const lagSignal = metrics.max_lag_days > 0 ? Math.min(1.2, metrics.max_lag_days / 45) : 0;
  const ageSignal = ageDays > 0 ? Math.min(0.8, ageDays / 45) : 0;

  let pressure = 1 + (driftSignal * 0.06) + (lagSignal * 0.2) + (ageSignal * 0.15);
  if (gap === 'stale_context') {
    pressure += 0.25 + Math.min(0.35, metrics.stale_areas * 0.08);
  } else if (gap === 'context_drift' || gap === 'missing_bundle') {
    pressure += 0.2 + Math.min(0.3, driftSignal * 0.05);
  } else if (gap === 'changelog_update_missing' || gap === 'changelog_stale_after_feature_change') {
    pressure += 0.12;
  }
  return round(Math.max(1, pressure));
}

function persistencePressure(consecutiveRuns) {
  return round(1 + Math.min(1.5, Math.max(0, consecutiveRuns - 1) * 0.18));
}

const STRUCTURAL_GAPS = new Set([
  'missing_implementation',
  'test_coverage',
  'documentation',
  'arch_monolith',
  'arch_complexity_hotspot',
  'arch_missing_docs',
  'hygiene_todo_cluster',
  'hygiene_console_log',
  'hygiene_any_abuse',
  'dead_code_unreachable',
  'dead_code_unused_symbol',
  'dead_code_dead_branch',
  'dead_code_stale_module',
  'dead_code_misleading_module',
]);

function structuralGapUsesCodeIndex(gap) {
  return STRUCTURAL_GAPS.has(normalizeGapType(gap));
}

function featureRiskSummaryFromEvidence(evidence) {
  return evidence?.code_index?.feature_risk?.summary || null;
}

function fragilityRiskMultiplier(gap, featureRiskSummary) {
  if (!structuralGapUsesCodeIndex(gap) || !featureRiskSummary) return 1;
  const matchedModules = Number(featureRiskSummary.matched_modules || 0);
  if (matchedModules <= 0) return 1;

  const averageFragility = Number(featureRiskSummary.average_fragility || 0);
  const peakFragility = Number(featureRiskSummary.peak_fragility || 0);
  const peakCoupling = Number(featureRiskSummary.peak_coupling || 0);
  const misleadingFiles = Number(featureRiskSummary.misleading_files || 0);

  let multiplier = 1;
  multiplier += Math.min(0.6, (averageFragility / 7) * 0.45);
  multiplier += Math.min(0.25, (peakFragility / 7) * 0.2);
  multiplier += Math.min(0.3, peakCoupling / 24);
  if (misleadingFiles > 0) {
    multiplier += Math.min(0.35, (misleadingFiles / matchedModules) * 0.5);
  }

  return round(clamp(multiplier, 1, 2.25));
}

function noiseAdjustmentMultiplier(gap, featureRiskSummary) {
  if (!structuralGapUsesCodeIndex(gap) || !featureRiskSummary) return 1;
  const matchedModules = Number(featureRiskSummary.matched_modules || 0);
  if (matchedModules <= 0) return 1;

  const deadOrScaffold = Number(featureRiskSummary.dead_or_scaffold_files || 0);
  const misleading = Number(featureRiskSummary.misleading_files || 0);
  const activeLike = Math.max(0, matchedModules - deadOrScaffold);
  if (deadOrScaffold <= 0) return 1;
  if (activeLike <= 0 && misleading <= 0) return 0.4;

  const ratio = deadOrScaffold / matchedModules;
  return round(clamp(1 - (ratio * 0.45), 0.55, 1));
}

function codeRotMultiplier(gap, featureRiskSummary) {
  if (!structuralGapUsesCodeIndex(gap) || !featureRiskSummary) return 1;
  const maxDays = Number(featureRiskSummary.max_live_days_since_touch || 0);
  if (!Number.isFinite(maxDays) || maxDays < 30) return 1;

  const periods = Math.max(0, (maxDays - 30) / 15);
  const multiplier = 1 + Math.min(2.5, Math.pow(1.35, periods + 1) - 1);
  return round(clamp(multiplier, 1, 3.5));
}

function classifyTrend(delta) {
  if (!Number.isFinite(delta)) return 'new';
  if (delta > 0.5) return 'worsening';
  if (delta < -0.5) return 'improving';
  return 'steady';
}

function salienceTrend(delta) {
  if (!Number.isFinite(delta)) return 'new';
  if (delta > 1) return 'worsening';
  if (delta < -1) return 'improving';
  return 'steady';
}

function convergenceTrend(delta) {
  if (!Number.isFinite(delta)) return 'new';
  if (delta > 0.02) return 'improving';
  if (delta < -0.02) return 'worsening';
  return 'steady';
}

function entropyTrend(delta) {
  if (!Number.isFinite(delta)) return 'new';
  if (delta > 0.02) return 'worsening';
  if (delta < -0.02) return 'improving';
  return 'steady';
}

function buildSalience(featureName, gaps, evidence, config, options = {}) {
  const repoRoot = config?.repo_root || process.cwd();
  const featureKey = normalizeFeature(featureName) || 'current-task';
  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const metrics = contextMetrics(evidence);
  const featureRiskSummary = featureRiskSummaryFromEvidence(evidence);

  const weightsPath = resolvePath(repoRoot, config?.paths?.gap_weights) || path.resolve(__dirname, '../../config/gap-weights.json');
  const rawWeights = readJson(weightsPath, { unknown: 10 }) || { unknown: 10 };

  // Support both v1 flat format ({gap: number}) and v2 structured format ({weights: {gap: {weight, tier, blocks_ship}}})
  const isStructured = rawWeights.weights && typeof rawWeights.weights === 'object';
  const weightEntries = isStructured ? rawWeights.weights : rawWeights;
  const aliasConfig = {
    hygiene_todo_cluster: ['incomplete_implementation'],
    hygiene_console_log: ['debug_artifacts'],
    hygiene_any_abuse: ['type_safety_risk'],
    arch_monolith: ['architectural_limit_exceeded'],
    arch_complexity_hotspot: ['architectural_limit_exceeded'],
    arch_missing_docs: ['undocumented_module'],
    ...(config?.settings?.gap_weight_aliases || {}),
  };
  const gapAliases = normalizeGapAliasTable(aliasConfig);

  function findWeightEntryWithAliases(gap) {
    const normalizedGap = normalizeGapType(gap);
    const aliases = gapAliases[normalizedGap] || [normalizedGap];
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(weightEntries, alias)) {
        return weightEntries[alias];
      }
    }

    if (Object.prototype.hasOwnProperty.call(weightEntries, 'unknown')) {
      return weightEntries.unknown;
    }
    return 10;
  }

  function resolveWeight(gap) {
    const entry = findWeightEntryWithAliases(gap);
    if (typeof entry === 'number') return { weight: entry, tier: 'advisory', blocks_ship: false, blocks_ship_when: null };
    return {
      weight: Number(entry.weight ?? 10),
      tier: entry.tier || 'advisory',
      blocks_ship: Boolean(entry.blocks_ship),
      blocks_ship_when: entry.blocks_ship_when || null,
    };
  }

  const history = loadGapHistory(repoRoot, config);
  const previous = previousGapRun(history.rows, featureKey);
  const previousRanked = Array.isArray(previous?.salience?.ranked) ? previous.salience.ranked : [];
  const previousByGap = new Map(
    previousRanked
      .map(item => [normalizeGapType(item?.gap), Number(item?.score)])
      .filter(([, score]) => Number.isFinite(score))
  );
  const convergenceScore = Number(evidence?.convergence?.overall?.score);
  const convergenceEntropy = Number(evidence?.convergence?.overall?.entropy);
  const previousConvergenceScore = Number.isFinite(previous?.salience?.summary?.convergence_score)
    ? Number(previous.salience.summary.convergence_score)
    : Number.isFinite(previous?.evidence?.convergence_score)
      ? Number(previous.evidence.convergence_score)
      : null;
  const previousConvergenceEntropy = Number.isFinite(previous?.salience?.summary?.convergence_entropy)
    ? Number(previous.salience.summary.convergence_entropy)
    : Number.isFinite(previous?.evidence?.convergence_entropy)
      ? Number(previous.evidence.convergence_entropy)
      : null;
  const convergenceDelta = Number.isFinite(convergenceScore) && Number.isFinite(previousConvergenceScore)
    ? round(convergenceScore - previousConvergenceScore, 3)
    : null;
  const entropyDelta = Number.isFinite(convergenceEntropy) && Number.isFinite(previousConvergenceEntropy)
    ? round(convergenceEntropy - previousConvergenceEntropy, 3)
    : null;

  const acknowledgements = loadAcknowledgements(repoRoot, config);
  const normalizedGaps = gaps.map(normalizeGapType).filter(Boolean);
  const uniqueGaps = Array.from(new Set(normalizedGaps));

  // Resolve ship_ready status from context map for conditional blocking
  const contextShipReadyZones = evidence?.context_map?.ship_ready_zones || [];
  const anyShipReady = contextShipReadyZones.length > 0;

  // Check for critical_artifact_missing gaps from context map
  const criticalArtifactGaps = evidence?.context_map?.critical_artifact_gaps || [];
  if (criticalArtifactGaps.length > 0 && !uniqueGaps.includes('critical_artifact_missing')) {
    uniqueGaps.push('critical_artifact_missing');
  }

  const ranked = uniqueGaps.map(gap => {
    const weightInfo = resolveWeight(gap);
    const baseWeight = weightInfo.weight;

    // Determine effective blocking status
    let effectiveBlocking = weightInfo.blocks_ship;
    if (!effectiveBlocking && weightInfo.blocks_ship_when && gap === 'missing_implementation' && anyShipReady) {
      effectiveBlocking = true;
    }

    const priorStreak = consecutiveGapRuns(history.rows, featureKey, gap);
    const consecutiveRuns = priorStreak + 1;
    const firstEpoch = firstSeenEpoch(history.rows, featureKey, gap);
    const ageDays = firstEpoch ? round((nowEpoch - firstEpoch) / 86400, 1) : 0;
    const blast = blastRadiusForGap(gap, metrics);
    const temporal = temporalPressure(gap, metrics, ageDays);
    const persistence = persistencePressure(consecutiveRuns);
    const ackEntry = selectAcknowledgement(acknowledgements.entries, featureKey, gap);
    const ackState = evaluateAcknowledgement(ackEntry, nowEpoch);
    const riskMultiplier = fragilityRiskMultiplier(gap, featureRiskSummary);
    const noiseMultiplier = noiseAdjustmentMultiplier(gap, featureRiskSummary);
    const rotMultiplier = codeRotMultiplier(gap, featureRiskSummary);

    const blastMultiplier = round(1 + ((blast.level - 1) * 0.25));
    const score = round(
      baseWeight
      * blastMultiplier
      * temporal
      * persistence
      * riskMultiplier
      * noiseMultiplier
      * rotMultiplier
      * ackState.score_multiplier
    );
    const previousScore = previousByGap.has(gap) ? previousByGap.get(gap) : null;
    const deltaScore = previousScore === null ? null : round(score - previousScore);

    return {
      gap,
      score,
      previous_score: previousScore,
      delta_score: deltaScore,
      tier: weightInfo.tier,
      blocks_ship: effectiveBlocking,
      trend: classifyTrend(deltaScore),
      base_weight: baseWeight,
      blast_radius: blast,
      temporal_pressure: temporal,
      risk_multiplier: riskMultiplier,
      noise_multiplier: noiseMultiplier,
      code_rot_multiplier: rotMultiplier,
      persistence: {
        consecutive_runs: consecutiveRuns,
        age_days: ageDays,
      },
      acknowledgement: {
        state: ackState.state,
        active: ackState.active,
        expired: ackState.expired,
        audit_due: ackState.audit_due,
        reason: ackState.reason,
        expires_at: ackState.expires_at,
        audit_due_at: ackState.audit_due_at,
      },
    };
  }).sort((a, b) => b.score - a.score);

  const currentGapSet = new Set(uniqueGaps);
  const resolved = Array.from(previousByGap.entries())
    .filter(([gap]) => !currentGapSet.has(gap))
    .map(([gap, previousScore]) => ({
      gap,
      previous_score: previousScore,
      delta_score: round(-previousScore),
      trend: 'resolved',
    }))
    .sort((a, b) => b.previous_score - a.previous_score);

  const totalScore = round(ranked.reduce((sum, item) => sum + item.score, 0));
  const explicitPreviousTotal = Number.isFinite(previous?.salience?.summary?.total_score)
    ? Number(previous.salience.summary.total_score)
    : null;
  const derivedPreviousTotal = previousRanked.length > 0
    ? previousRanked.reduce((sum, item) => sum + (Number(item?.score) || 0), 0)
    : null;
  const previousTotal = explicitPreviousTotal ?? derivedPreviousTotal;
  const hasPreviousComparable = Number.isFinite(previousTotal);
  const totalDelta = hasPreviousComparable ? round(totalScore - previousTotal) : null;
  const maxAgeDays = ranked.reduce((max, item) => Math.max(max, Number(item?.persistence?.age_days || 0)), 0);
  const expiredAckCount = ranked.filter(item => item?.acknowledgement?.expired).length;
  const overdueAuditCount = ranked.filter(item => item?.acknowledgement?.audit_due).length;
  const peakCodeRotMultiplier = ranked.reduce((max, item) => Math.max(max, Number(item?.code_rot_multiplier || 1)), 1);
  const peakRiskMultiplier = ranked.reduce((max, item) => Math.max(max, Number(item?.risk_multiplier || 1)), 1);

  const salience = {
    feature: featureName,
    feature_key: featureKey,
    recorded_at: now.toISOString(),
    summary: {
      total_score: totalScore,
      previous_total_score: hasPreviousComparable ? round(previousTotal) : null,
      delta_score: totalDelta,
      trend: salienceTrend(totalDelta),
      blocking_gaps: ranked.filter(item => item.blocks_ship).length,
      advisory_gaps: ranked.filter(item => !item.blocks_ship).length,
      ship_blocked: ranked.some(item => item.blocks_ship),
      active_gaps: ranked.length,
      resolved_gaps: resolved.length,
      max_gap_age_days: round(maxAgeDays, 1),
      context_max_lag_days: round(metrics.max_lag_days, 1),
      blast_peak_level: ranked.reduce((max, item) => Math.max(max, Number(item?.blast_radius?.level || 0)), 0),
      expired_acknowledgements: expiredAckCount,
      audit_overdue_exemptions: overdueAuditCount,
      convergence_score: Number.isFinite(convergenceScore) ? round(convergenceScore, 3) : null,
      previous_convergence_score: Number.isFinite(previousConvergenceScore) ? round(previousConvergenceScore, 3) : null,
      convergence_delta: convergenceDelta,
      convergence_trend: convergenceTrend(convergenceDelta),
      convergence_entropy: Number.isFinite(convergenceEntropy) ? round(convergenceEntropy, 3) : null,
      previous_convergence_entropy: Number.isFinite(previousConvergenceEntropy) ? round(previousConvergenceEntropy, 3) : null,
      convergence_entropy_delta: entropyDelta,
      convergence_entropy_trend: entropyTrend(entropyDelta),
      feature_fragility_avg: Number.isFinite(featureRiskSummary?.average_fragility) ? round(featureRiskSummary.average_fragility, 2) : null,
      feature_peak_fragility: Number.isFinite(featureRiskSummary?.peak_fragility) ? Number(featureRiskSummary.peak_fragility) : null,
      dead_scaffold_feature_files: Number(featureRiskSummary?.dead_or_scaffold_files || 0),
      misleading_feature_files: Number(featureRiskSummary?.misleading_files || 0),
      code_rot_max_days: Number(featureRiskSummary?.max_live_days_since_touch || 0),
      code_rot_peak_multiplier: peakCodeRotMultiplier,
      feature_risk_peak_multiplier: peakRiskMultiplier,
    },
    ranked,
    resolved,
    history: {
      path: history.path,
      previous_recorded_at: previous?.timestamp || previous?.recorded_at || null,
      compared_runs: featureHistoryRows(history.rows, featureKey).length,
    },
    acknowledgements: {
      path: acknowledgements.path,
      loaded_entries: acknowledgements.entries.length,
    },
  };

  const shouldRecord = options?.record === true;
  if (shouldRecord) {
    const persisted = appendGapHistoryRow(history.path, {
      id: `gap_run_${Date.now()}`,
      timestamp: now.toISOString(),
      feature: featureName,
      feature_key: featureKey,
      gaps: uniqueGaps,
      salience: {
        summary: salience.summary,
        ranked: ranked.map(item => ({
          gap: item.gap,
          score: item.score,
          delta_score: item.delta_score,
          trend: item.trend,
          blast_level: item.blast_radius.level,
          tier: item.tier,
          blocks_ship: item.blocks_ship,
          temporal_pressure: item.temporal_pressure,
          risk_multiplier: item.risk_multiplier,
          noise_multiplier: item.noise_multiplier,
          code_rot_multiplier: item.code_rot_multiplier,
          persistence: item.persistence,
        })),
      },
      evidence: {
        feature_file_count: evidence?.feature_file_count || 0,
        context_drift_areas: metrics.drift_areas,
        context_stale_areas: metrics.stale_areas,
        context_uncovered_files: metrics.uncovered_files,
        convergence_score: Number.isFinite(convergenceScore) ? round(convergenceScore, 3) : null,
        convergence_entropy: Number.isFinite(convergenceEntropy) ? round(convergenceEntropy, 3) : null,
        lane_summary: evidence?.convergence?.lane_summary || null,
        code_index: evidence?.code_index?.feature_risk?.summary || null,
      },
    });
    salience.history.recorded = persisted;
  } else {
    salience.history.recorded = false;
  }

  return salience;
}

function detectGaps(featureName, configInput = null, options = {}) {
  const rawConfig = configInput || loadRuntimeConfig({ fromDir: __dirname }).config;
  const config = resolveRuntimeConfig(rawConfig);
  if (!config) return { gaps: [], evidence: { reason: 'missing_config' }, salience: null };

  const repoRoot = resolveRepoRoot(config);
  const featureKey = normalizeFeature(featureName) || 'current-task';
  const ignoredDirs = ignoredDirsForConfig(config, repoRoot);
  const probes = resolveFeatureProbes(featureName, config, options);
  const tokens = probes.feature_tokens;
  const implementationTokens = probes.implementation_tokens;
  const testTokens = probes.test_tokens;
  const docTokens = probes.doc_tokens;
  const featureSignalTokens = signalTokens(tokens);
  const implementationSignalTokens = signalTokens(implementationTokens);
  const testSignalTokens = signalTokens(testTokens);
  const docSignalTokens = signalTokens(docTokens);

  if (!tokens.length) {
    return {
      gaps: [],
      evidence: {
        reason: 'missing_feature_name',
        feature: featureName || '',
        aliases: probes.aliases,
      },
      salience: null,
    };
  }

  const allFiles = listRepoFiles(repoRoot, ignoredDirs);
  const sourceRoots = findSourceRoots(repoRoot, config?.paths?.source_roots);
  const sourcePrefixes = sourceRoots.map(root => normalizePath(path.relative(repoRoot, root)));
  const testRoots = findTestRoots(repoRoot, config?.paths?.test_roots);
  const testPrefixes = testRoots.map(root => normalizePath(path.relative(repoRoot, root)));

  const testFileExts = [
    '.test.js', '.spec.js',
    '.test.ts', '.spec.ts',
    '.test.jsx', '.spec.jsx',
    '.test.tsx', '.spec.tsx',
    '_test.go',
    '_test.py',
  ];

  const docsRoot = findDocsRoot(repoRoot, config);
  const docsPrefix = docsRoot ? normalizePath(path.relative(repoRoot, docsRoot)) : null;
  const pathLanes = resolvePathLanes(config, probes);
  const laneMultipliers = resolveLaneMultipliers(config, probes);
  const convergence = resolveConvergenceConfig(config, probes);

  const laneByFile = new Map();
  const laneSummary = {
    total_files: allFiles.length,
    strict_files: 0,
    relaxed_files: 0,
    excluded_files: 0,
    by_lane: {},
  };

  allFiles.forEach(rel => {
    const lane = laneForPath(rel, pathLanes);
    laneByFile.set(rel, lane);

    laneSummary.by_lane[lane.name] = laneSummary.by_lane[lane.name] || {
      mode: lane.mode,
      files: 0,
    };
    laneSummary.by_lane[lane.name].files += 1;

    if (lane.mode === 'excluded') laneSummary.excluded_files += 1;
    else if (lane.mode === 'relaxed') laneSummary.relaxed_files += 1;
    else laneSummary.strict_files += 1;
  });

  function isExcluded(relPath) {
    const lane = laneByFile.get(relPath) || { mode: 'strict' };
    return lane.mode === 'excluded';
  }

  function recordHit(hits, seen, relPath) {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const lane = laneByFile.get(relPath) || { name: pathLanes.default_lane, mode: 'strict' };
    hits.push({
      file: relPath,
      lane: lane.name,
      lane_mode: lane.mode,
    });
  }

  const featurePathHints = dedupeCaseInsensitive([
    ...(probes.path_hints?.shared || []),
    ...(probes.path_hints?.implementation || []),
    ...(probes.path_hints?.tests || []),
    ...(probes.path_hints?.docs || []),
  ]);
  const scopeMode = probes?.scope?.mode || null;
  const enforceScopedPaths = probes?.scope?.enforced === true && featurePathHints.length > 0;
  const scopedPathHints = {
    feature: featurePathHints,
    implementation: dedupeCaseInsensitive(probes.path_hints?.implementation || []),
    tests: dedupeCaseInsensitive(probes.path_hints?.tests || []),
    docs: dedupeCaseInsensitive(probes.path_hints?.docs || []),
  };
  const ignoredOutOfScope = {
    feature: new Set(),
    implementation: new Set(),
    tests: new Set(),
    docs: new Set(),
  };

  function scopeHintsFor(kind) {
    const specific = scopedPathHints[kind] || [];
    if (specific.length > 0) return specific;
    return scopedPathHints.feature;
  }

  function inScopedPaths(relPath, kind) {
    const hints = scopeHintsFor(kind);
    if (!enforceScopedPaths || hints.length === 0) return true;
    return matchesScopedPath(relPath, hints);
  }

  function trackOutOfScope(kind, relPath) {
    if (!enforceScopedPaths) return;
    ignoredOutOfScope[kind].add(relPath);
  }

  const featureFiles = [];
  const strictFeatureFiles = [];
  const relaxedFeatureFiles = [];
  allFiles.forEach(rel => {
    if (isExcluded(rel)) return;
    const lower = rel.toLowerCase();
    const matches = pathIncludesToken(rel, lower, featureSignalTokens, null, featurePathHints);
    if (!matches) return;
    if (!inScopedPaths(rel, 'feature')) {
      trackOutOfScope('feature', rel);
      return;
    }
    featureFiles.push(rel);
    const lane = laneByFile.get(rel) || { mode: 'strict' };
    if (lane.mode === 'strict') strictFeatureFiles.push(rel);
    else if (lane.mode === 'relaxed') relaxedFeatureFiles.push(rel);
  });

  const directFeatureMatches = new Set(featureFiles.map(normalizePath));
  const selfModelResult = getSelfModel(repoRoot, {
    config,
    sourceRoots: sourcePrefixes.length > 0 ? sourcePrefixes : ['.'],
    contextMapPath: resolveContextMapPath(repoRoot, config),
    persist: options?.persistSelfModel === true,
  });
  const indexMatcher = buildIndexMatcher(featureName, probes.aliases);
  const indexAnalysis = analyzeFeatureIndex(selfModelResult.model, indexMatcher, featurePathHints, directFeatureMatches);
  const allFilesSet = new Set(allFiles);
  const indexedFeatureFiles = indexAnalysis.indexed_feature_files.filter(file => allFilesSet.has(file));
  const scopedFeatureFiles = indexedFeatureFiles.length > 0
    ? indexedFeatureFiles
    : featureFiles;
  const scopedStrictFeatureFiles = [];
  const scopedRelaxedFeatureFiles = [];
  scopedFeatureFiles.forEach(rel => {
    const lane = laneByFile.get(rel) || laneForPath(rel, pathLanes);
    if (lane.mode === 'excluded') return;
    if (lane.mode === 'relaxed') scopedRelaxedFeatureFiles.push(rel);
    else scopedStrictFeatureFiles.push(rel);
  });
  const featureRisk = summarizeFeatureRisk(selfModelResult.model, scopedFeatureFiles);
  const indexedMatchMap = new Map(
    (indexAnalysis.indexed_feature_matches || []).map(item => [normalizePath(item.path), Array.isArray(item.reasons) ? item.reasons.slice() : []])
  );

  const contentCache = new Map();
  const exportProbes = dedupeTokens([...implementationSignalTokens, ...probes.export_hints]);
  const callsiteProbes = dedupeTokens([...implementationSignalTokens, ...probes.callsite_hints]);
  const testContentProbes = dedupeTokens([...testSignalTokens, ...callsiteProbes, ...exportProbes]);
  const docContentProbes = dedupeTokens([...docSignalTokens, ...featureSignalTokens]);

  const implementationPathHits = [];
  const implementationPathSeen = new Set();
  const implementationExportHits = [];
  const implementationExportSeen = new Set();
  const implementationCallsiteHits = [];
  const implementationCallsiteSeen = new Set();

  allFiles.forEach(rel => {
    if (isExcluded(rel)) return;
    if (!isPathInsidePrefix(rel, sourcePrefixes)) return;
    const lower = rel.toLowerCase();
    const pathHit = pathIncludesToken(
      rel,
      lower,
      implementationSignalTokens,
      null,
      probes.path_hints?.implementation || []
    );
    const scopedIn = inScopedPaths(rel, 'implementation');
    if (!scopedIn && pathHit) {
      trackOutOfScope('implementation', rel);
    }
    if (!scopedIn) return;
    if (pathHit) {
      recordHit(implementationPathHits, implementationPathSeen, rel);
    }

    const content = readLowerContent(repoRoot, rel, contentCache);
    if (!content) return;

    const exportPattern = /(?:^|\n)\s*(?:export\s+(?:default|const|let|var|function|class|async|type|interface)|module\.exports|exports\.)/m;
    if (enforceScopedPaths && !pathHit && textIncludesAny(content, exportProbes)) {
      trackOutOfScope('implementation', rel);
    }
    if (exportPattern.test(content) && (pathHit || textIncludesAny(content, exportProbes))) {
      recordHit(implementationExportHits, implementationExportSeen, rel);
    }

    const callsitePattern = /(?:import\s.+from\s+['"]|require\s*\(|\bnew\s+[a-z_][a-z0-9_]*\s*\(|\b[a-z_][a-z0-9_]*\s*\()/i;
    if (enforceScopedPaths && !pathHit && textIncludesAny(content, callsiteProbes)) {
      trackOutOfScope('implementation', rel);
    }
    if (callsitePattern.test(content) && (pathHit || textIncludesAny(content, callsiteProbes))) {
      recordHit(implementationCallsiteHits, implementationCallsiteSeen, rel);
    }
  });

  const testPathHits = [];
  const testPathSeen = new Set();
  const testContentHits = [];
  const testContentSeen = new Set();

  allFiles.forEach(rel => {
    if (isExcluded(rel)) return;
    if (!isPathInsidePrefix(rel, testPrefixes)) return;

    const lower = rel.toLowerCase();
    const isTestFile = /(?:^|\.|_)test|(?:^|\.|_)spec/.test(lower) || testFileExts.some(ext => lower.endsWith(ext));
    if (!isTestFile) return;

    const pathHit = pathIncludesToken(
      rel,
      lower,
      testSignalTokens,
      null,
      probes.path_hints?.tests || []
    );
    const scopedIn = inScopedPaths(rel, 'tests');
    if (!scopedIn && pathHit) {
      trackOutOfScope('tests', rel);
    }
    if (!scopedIn) return;
    if (pathHit) {
      recordHit(testPathHits, testPathSeen, rel);
    }

    const content = readLowerContent(repoRoot, rel, contentCache);
    if (!content) return;
    const testPattern = /(?:describe|it|test)\s*\(|assert\s*\(|pytest|unittest|expect\s*\(/;
    if (enforceScopedPaths && textIncludesAny(content, testContentProbes) && !pathHit) {
      trackOutOfScope('tests', rel);
    }
    if (testPattern.test(content) && textIncludesAny(content, testContentProbes)) {
      recordHit(testContentHits, testContentSeen, rel);
    }
  });

  const docPathHits = [];
  const docPathSeen = new Set();
  const docContentHits = [];
  const docContentSeen = new Set();
  if (docsPrefix) {
    allFiles.forEach(rel => {
      if (isExcluded(rel)) return;
      if (!isPathInsidePrefix(rel, [docsPrefix])) return;

      const lower = rel.toLowerCase();
      const pathHit = pathIncludesToken(
        rel,
        lower,
        docSignalTokens,
        ['.md', '.mdx', '.txt', '.rst'],
        probes.path_hints?.docs || []
      );
      const scopedIn = inScopedPaths(rel, 'docs');
      if (!scopedIn && pathHit) {
        trackOutOfScope('docs', rel);
      }
      if (!scopedIn) return;
      if (pathHit) {
        recordHit(docPathHits, docPathSeen, rel);
      }

      const content = readLowerContent(repoRoot, rel, contentCache);
      if (!content) return;
      if (enforceScopedPaths && textIncludesAny(content, docContentProbes) && !pathHit) {
        trackOutOfScope('docs', rel);
      }
      if (textIncludesAny(content, docContentProbes)) {
        recordHit(docContentHits, docContentSeen, rel);
      }
    });
  }

  const implementationPathSummary = summarizeHits(
    implementationPathHits,
    laneMultipliers,
    convergence.saturation.path
  );
  const implementationExportSummary = summarizeHits(
    implementationExportHits,
    laneMultipliers,
    convergence.saturation.export
  );
  const implementationCallsiteSummary = summarizeHits(
    implementationCallsiteHits,
    laneMultipliers,
    convergence.saturation.callsite
  );

  const testsPathSummary = summarizeHits(
    testPathHits,
    laneMultipliers,
    convergence.saturation.path
  );
  const testsContentSummary = summarizeHits(
    testContentHits,
    laneMultipliers,
    convergence.saturation.content
  );

  const docsPathSummary = summarizeHits(
    docPathHits,
    laneMultipliers,
    convergence.saturation.path
  );
  const docsContentSummary = summarizeHits(
    docContentHits,
    laneMultipliers,
    convergence.saturation.content
  );

  const implementationScore = weightedAverage({
    path: implementationPathSummary.score,
    export: implementationExportSummary.score,
    callsite: implementationCallsiteSummary.score,
  }, convergence.weights.implementation);

  const testsScore = weightedAverage({
    path: testsPathSummary.score,
    content: testsContentSummary.score,
  }, convergence.weights.tests);

  const docsScore = weightedAverage({
    path: docsPathSummary.score,
    content: docsContentSummary.score,
  }, convergence.weights.docs);

  const hasImplementation = implementationScore >= Number(convergence.thresholds.implementation ?? 0.5);
  const hasTests = testsScore >= Number(convergence.thresholds.tests ?? 0.45);
  const docsThreshold = Number(convergence.thresholds.docs ?? 0.5);
  const hasDocs = docsRoot
    ? docsScore >= docsThreshold || (docPathHits.length === 0 && docContentHits.length > 0)
    : false;

  const filterZones = Array.isArray(options.zones) ? options.zones : [];
  const contextMap = analyzeContextMap(repoRoot, config, featureSignalTokens, scopedStrictFeatureFiles, allFiles, filterZones);
  const changelogAudit = analyzeChangelogAudit(repoRoot, sourcePrefixes, scopedFeatureFiles);

  const overallComponents = {
    implementation: implementationScore,
    tests: testsScore,
    docs: docsRoot ? docsScore : 1,
  };
  const overallScore = weightedAverage(overallComponents, convergence.weights.overall);
  const overallThreshold = Number(convergence.thresholds.overall ?? 0.45);
  const overallEntropy = round(1 - overallScore, 3);

  const hygieneConfig = resolveHygieneConfig(config, options);
  const hygieneScan = hygieneConfig.enabled
    ? scanHygiene(config, {
      record: false,
      ...(hygieneConfig.typeFilter && hygieneConfig.typeFilter.length > 0 ? { types: hygieneConfig.typeFilter } : {}),
    })
    : null;
  const hygieneGaps = hygieneScan ? mapHygieneFindingsToGapKeys(hygieneScan.summary) : [];

  const gaps = new Set();
  if (!hasImplementation) gaps.add('missing_implementation');
  if (!hasTests) gaps.add('test_coverage');
  if (docsRoot && !hasDocs) gaps.add('documentation');

  if (Array.isArray(changelogAudit.implementation_changes) && changelogAudit.implementation_changes.length > 0) {
    gaps.add('changelog_stale_after_feature_change');
  }
  if (
    (Array.isArray(changelogAudit.user_facing_changes) && changelogAudit.user_facing_changes.length > 0)
    || (Array.isArray(changelogAudit.contract_changes) && changelogAudit.contract_changes.length > 0)
    || (Array.isArray(changelogAudit.feature_related_changes) && changelogAudit.feature_related_changes.length > 0)
  ) {
    gaps.add('changelog_update_missing');
  }
  if (
    changelogAudit.last_updated_commit
    && Array.isArray(changelogAudit.last_update_supporting_files)
    && changelogAudit.last_update_supporting_files.length === 0
  ) {
    gaps.add('changelog_scope_mismatch');
  }

  if (contextMap.enabled) {
    if (!contextMap.map_exists || !contextMap.map_valid || contextMap.areas_count === 0) {
      gaps.add('missing_bundle');
    }
    if (contextMap.stale_areas.length > 0) {
      gaps.add('stale_context');
    }
    if (contextMap.drift_areas.length > 0 || contextMap.uncovered_feature_files.length > 0) {
      gaps.add('context_drift');
    }
    if (contextMap.uncovered_feature_files.length > 0) {
      gaps.add('missing_bundle');
    }
    // Critical artifact checking — blocking tier (irreversibility)
    if (Array.isArray(contextMap.critical_artifact_gaps) && contextMap.critical_artifact_gaps.length > 0) {
      gaps.add('critical_artifact_missing');
    }
  }

  hygieneGaps.forEach(gap => gaps.add(gap));

  const acknowledgements = loadAcknowledgements(repoRoot, config);
  const nowEpoch = Math.floor(Date.now() / 1000);
  collectOpenAcknowledgementGaps(acknowledgements.entries, featureKey, nowEpoch).forEach(gap => gaps.add(gap));

  const normalizedGaps = Array.from(gaps).map(normalizeGapType).filter(Boolean);
  const evidence = {
    feature: featureName,
    tokens,
    intent: probes.intent,
    feature_aliases: probes.aliases,
    probe_tokens: {
      implementation: implementationTokens,
      tests: testTokens,
      docs: docTokens,
    },
    effective_probe_tokens: {
      feature: featureSignalTokens,
      implementation: implementationSignalTokens,
      tests: testSignalTokens,
      docs: docSignalTokens,
    },
    probe_metadata: probes.metadata,
    probe_path_hints: probes.path_hints,
    probe_scope: probes.scope,
    probe_signal_hints: {
      exports: probes.export_hints,
      callsites: probes.callsite_hints,
    },
    scan_ignore_dirs: [
      ...Array.from(ignoredDirs.names),
      ...ignoredDirs.prefixes.map(prefix => `${prefix}/**`),
    ],
    scan_ignore_dir_names: Array.from(ignoredDirs.names),
    scan_ignore_prefixes: ignoredDirs.prefixes,
    source_roots: sourceRoots.map(root => normalizePath(path.relative(repoRoot, root)) || '.'),
    test_roots: testPrefixes,
    docs_root: docsRoot ? normalizePath(path.relative(repoRoot, docsRoot)) : null,
    has_implementation: hasImplementation,
    has_tests: hasTests,
    has_docs: hasDocs,
    path_lanes: {
      default_lane: pathLanes.default_lane,
      lanes: pathLanes.lanes,
      summary: laneSummary,
      multipliers: laneMultipliers,
    },
    feature_file_count: scopedStrictFeatureFiles.length,
    raw_feature_file_count: featureFiles.length,
    feature_file_count_total: featureFiles.length,
    feature_file_count_relaxed: scopedRelaxedFeatureFiles.length,
    feature_files_strict: scopedStrictFeatureFiles,
    feature_files_relaxed: scopedRelaxedFeatureFiles,
    scope: {
      mode: scopeMode,
      enforced: enforceScopedPaths,
      path_hints: scopedPathHints,
      ignored_out_of_scope: {
        feature: Array.from(ignoredOutOfScope.feature).sort(),
        implementation: Array.from(ignoredOutOfScope.implementation).sort(),
        tests: Array.from(ignoredOutOfScope.tests).sort(),
        docs: Array.from(ignoredOutOfScope.docs).sort(),
      },
      ignored_out_of_scope_counts: {
        feature: ignoredOutOfScope.feature.size,
        implementation: ignoredOutOfScope.implementation.size,
        tests: ignoredOutOfScope.tests.size,
        docs: ignoredOutOfScope.docs.size,
      },
    },
    convergence: {
      thresholds: convergence.thresholds,
      weights: convergence.weights,
      saturation: convergence.saturation,
      lane_summary: laneSummary,
      signals: {
        implementation: {
          threshold: Number(convergence.thresholds.implementation ?? 0.5),
          score: round(implementationScore, 3),
          meets: hasImplementation,
          components: {
            path: implementationPathSummary,
            export: implementationExportSummary,
            callsite: implementationCallsiteSummary,
          },
        },
        tests: {
          threshold: Number(convergence.thresholds.tests ?? 0.45),
          score: round(testsScore, 3),
          meets: hasTests,
          components: {
            path: testsPathSummary,
            content: testsContentSummary,
          },
        },
        docs: {
          threshold: Number(convergence.thresholds.docs ?? 0.5),
          score: round(docsScore, 3),
          meets: docsRoot ? hasDocs : null,
          components: {
            path: docsPathSummary,
            content: docsContentSummary,
          },
        },
      },
      overall: {
        threshold: overallThreshold,
        score: round(overallScore, 3),
        meets: overallScore >= overallThreshold,
        entropy: overallEntropy,
        components: {
          implementation: round(overallComponents.implementation, 3),
          tests: round(overallComponents.tests, 3),
          docs: round(overallComponents.docs, 3),
        },
      },
    },
    hygiene: hygieneScan
      ? {
        enabled: true,
        summary: hygieneScan.summary,
        gaps: hygieneScan.gaps,
        mapped_gaps: hygieneGaps,
      }
      : {
        enabled: false,
      },
    code_index: {
      ...indexAnalysis,
      path: selfModelResult.model_path,
      source: selfModelResult.source,
      indexed_modules: Number(selfModelResult.model?.summary?.total_modules || 0),
      dependency_edges: Number(selfModelResult.model?.summary?.total_edges || 0),
      used_for_scope: indexedFeatureFiles.length > 0,
      feature_risk: featureRisk,
    },
    matched_feature_files: scopedFeatureFiles.map(relPath => {
      const lane = laneByFile.get(relPath) || laneForPath(relPath, pathLanes);
      const indexedReasons = indexedMatchMap.get(normalizePath(relPath)) || [];
      const directTriggers = matchingPathTriggers(relPath, featureSignalTokens, featurePathHints);
      const matchSource = indexedFeatureFiles.includes(relPath) ? 'code_index' : 'direct_scan';
      return {
        path: relPath,
        lane: lane.mode,
        match_source: matchSource,
        triggers: uniqueSorted(matchSource === 'code_index'
          ? [...indexedReasons, ...directTriggers]
          : directTriggers),
      };
    }),
    context_map: contextMap,
    changelog: changelogAudit,
  };
  const salience = buildSalience(featureName, normalizedGaps, evidence, config, options);

  return {
    gaps: normalizedGaps,
    evidence,
    salience,
  };
}

module.exports = {
  detectGaps,
};
