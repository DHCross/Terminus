#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const {
  detectGitRepoRoot,
  findRuntimeConfigPath,
  resolveSherlogStateRoot,
  toPortableConfig,
} = require('./src/core/shared');

const DROP_ROOT = __dirname;
const DROP_PACKAGE_PATH = path.join(DROP_ROOT, 'package.json');

const REQUIRED_DROP_FILES = [
  'src/core/analyzer.js',
  'src/core/reporter.js',
  'src/core/estimate.js',
  'src/core/gap-detector.js',
  'src/core/digest.js',
  'src/core/self-model.js',
  'src/core/consumers.js',
  'src/core/dead-code.js',
  'src/core/boundary-mapper.js',
  'src/cli/doctor.js',
  'src/cli/verify.js',
  'src/cli/gaps.js',
  'src/cli/digest.js',
  'src/cli/consumers.js',
  'src/cli/dead-code.js',
  'src/cli/bounds.js',
  'src/cli/prompt.js',
  'src/cli/init-context.js',
  'src/cli/index-sync.js',
  'src/cli/ack.js',
  'src/cli/hygiene.js',
  'src/cli/skills.js',
  'src/cli/retrospective.js',
  'src/cli/session.js',
  'src/cli/bridge.js',
  'src/cli/setup.js',
  'config/gap-weights.json',
  'schemas/sherlog.context.schema.json',
  'schemas/sherlog.gaps-output.schema.json',
  'schemas/sherlog.bounds-output.schema.json',
  'schemas/sherlog.doctor-output.schema.json',
  'LESSONS_LEARNED.md',
  'templates/sherlog.acknowledgements.example.json',
];

const SOURCE_DIR_NAMES = ['src', 'lib', 'app', 'server', 'services'];
const TEST_DIR_NAMES = ['test', 'tests', '__tests__'];
const ARCHIVE_DIR_NAMES = ['archive', 'archives', 'attic', 'legacy', 'deprecated', 'old'];
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb',
  '.php', '.cs', '.swift', '.scala',
]);
const DISCOVERY_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.repomix',
  '.venv',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'vendor',
  'tmp',
  'temp',
]);
const TRACKED_FILE_CACHE = new Map();

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function mergeValues(preferred, fallback) {
  return preferred === undefined ? fallback : preferred;
}

function mergeRecords(base = {}, existing = {}) {
  return {
    ...(base || {}),
    ...(existing || {}),
  };
}

function preserveExistingConfig(baseConfig, existingConfig) {
  if (!existingConfig || typeof existingConfig !== 'object') return baseConfig;

  const merged = {
    ...baseConfig,
    version: Math.max(Number(baseConfig.version || 0), Number(existingConfig.version || 0) || 0),
    repo_root: mergeValues(existingConfig.repo_root, baseConfig.repo_root),
    installed_at: mergeValues(existingConfig.installed_at, baseConfig.installed_at),
    stack: mergeRecords(baseConfig.stack, existingConfig.stack),
    bundler: mergeRecords(baseConfig.bundler, existingConfig.bundler),
    context: mergeRecords(baseConfig.context, existingConfig.context),
    paths: mergeRecords(baseConfig.paths, existingConfig.paths),
    settings: mergeRecords(baseConfig.settings, existingConfig.settings),
  };

  if (Array.isArray(existingConfig.settings?.path_lanes) && existingConfig.settings.path_lanes.length > 0) {
    merged.settings.path_lanes = existingConfig.settings.path_lanes;
  }
  if (Array.isArray(existingConfig.settings?.gap_scan_ignore_dirs) && existingConfig.settings.gap_scan_ignore_dirs.length > 0) {
    merged.settings.gap_scan_ignore_dirs = existingConfig.settings.gap_scan_ignore_dirs;
  }
  if (Array.isArray(existingConfig.paths?.source_roots) && existingConfig.paths.source_roots.length > 0) {
    merged.paths.source_roots = existingConfig.paths.source_roots;
  }
  if (Array.isArray(existingConfig.paths?.test_roots) && existingConfig.paths.test_roots.length > 0) {
    merged.paths.test_roots = existingConfig.paths.test_roots;
  }
  if (existingConfig.context?.map_file) {
    merged.context.map_file = existingConfig.context.map_file;
    merged.paths.context_map = existingConfig.context.map_file;
  }

  return merged;
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function normalizeRelative(relPath) {
  const normalized = normalizePath(relPath);
  return normalized || '.';
}

function uniquePaths(paths = []) {
  const seen = new Set();
  const out = [];
  for (const raw of paths) {
    const normalized = normalizeRelative(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sortBySpecificity(paths = []) {
  return [...paths].sort((a, b) => {
    const aDepth = a === '.' ? 0 : a.split('/').length;
    const bDepth = b === '.' ? 0 : b.split('/').length;
    if (bDepth !== aDepth) return bDepth - aDepth;
    return a.localeCompare(b);
  });
}

function toDateStamp(date = new Date()) {
  return date.toISOString().split('T')[0];
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function repoHasTrackedFiles(repoRoot) {
  if (TRACKED_FILE_CACHE.has(repoRoot)) return TRACKED_FILE_CACHE.get(repoRoot);

  let hasTracked = false;
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    hasTracked = Boolean(raw);
  } catch {
    hasTracked = false;
  }

  TRACKED_FILE_CACHE.set(repoRoot, hasTracked);
  return hasTracked;
}

function pathHasTrackedFiles(repoRoot, relPath) {
  if (!repoHasTrackedFiles(repoRoot)) return true;

  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--', relPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Boolean(raw);
  } catch {
    return true;
  }
}

function containsCodeFiles(rootDir, limit = 8000) {
  if (!isDirectory(rootDir)) return false;
  const stack = [rootDir];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReadDir(current);

    for (const entry of entries) {
      if (seen++ > limit) return true;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (!DISCOVERY_IGNORED_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) return true;
    }
  }

  return false;
}

function containsCodeFilesOutside(repoRoot, excludedRoots = [], limit = 8000) {
  if (!isDirectory(repoRoot)) return false;
  const stack = [repoRoot];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = safeReadDir(current);

    for (const entry of entries) {
      if (seen++ > limit) return true;
      const fullPath = path.join(current, entry.name);
      const rel = normalizePath(path.relative(repoRoot, fullPath));
      if (rel && isExcludedPath(rel, excludedRoots)) continue;

      if (entry.isDirectory()) {
        if (!DISCOVERY_IGNORED_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext) && pathHasTrackedFiles(repoRoot, rel)) return true;
    }
  }

  return false;
}

function workspacePatterns(pkg) {
  if (Array.isArray(pkg?.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg?.workspaces?.packages)) return pkg.workspaces.packages;
  return [];
}

function expandWorkspacePattern(repoRoot, pattern) {
  const normalized = normalizePath(pattern);
  if (!normalized || normalized.startsWith('!')) return [];

  if (!normalized.includes('*')) {
    const full = path.join(repoRoot, normalized);
    return isDirectory(full) ? [normalized] : [];
  }

  if (normalized.endsWith('/*') && normalized.indexOf('*') === normalized.length - 1) {
    const parent = normalized.slice(0, -2);
    const fullParent = path.join(repoRoot, parent);
    if (!isDirectory(fullParent)) return [];
    return safeReadDir(fullParent)
      .filter(entry => entry.isDirectory() && !DISCOVERY_IGNORED_DIRS.has(entry.name))
      .map(entry => normalizePath(path.join(parent, entry.name)));
  }

  return [];
}

function detectWorkspaceRoots(repoRoot) {
  const pkg = readJson(path.join(repoRoot, 'package.json'), null);
  if (!pkg) return [];

  const patterns = workspacePatterns(pkg);
  if (!patterns.length) return [];

  const roots = patterns.flatMap(pattern => expandWorkspacePattern(repoRoot, pattern));
  return uniquePaths(roots.filter(Boolean)).filter(rel => rel !== '.');
}

function defaultExcludedRoots(repoRoot) {
  const relDropPath = normalizePath(path.relative(repoRoot, DROP_ROOT));
  if (!relDropPath || relDropPath.startsWith('..')) return [];
  return [relDropPath];
}

function isExcludedPath(relPath, excludedRoots = []) {
  const normalized = normalizePath(relPath);
  if (!normalized) return false;
  return excludedRoots.some(excluded => normalized === excluded || normalized.startsWith(`${excluded}/`));
}

function discoverNamedDirs(repoRoot, names, maxDepth = 4, excludedRoots = []) {
  const wanted = new Set(names);
  const found = new Set();
  const stack = [{ dir: repoRoot, depth: 0 }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item.depth > maxDepth) continue;

    const entries = safeReadDir(item.dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DISCOVERY_IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(item.dir, entry.name);
      const rel = normalizePath(path.relative(repoRoot, fullPath));
      if (!rel) continue;
      if (isExcludedPath(rel, excludedRoots)) continue;

      if (wanted.has(entry.name)) found.add(rel);
      if (item.depth < maxDepth) stack.push({ dir: fullPath, depth: item.depth + 1 });
    }
  }

  return Array.from(found);
}

function detectSourceRoots(repoRoot, options = {}) {
  const excludedRoots = uniquePaths([...(options.excludedRoots || []), ...defaultExcludedRoots(repoRoot)])
    .filter(root => root !== '.');
  const workspaceRoots = detectWorkspaceRoots(repoRoot);
  const discovered = discoverNamedDirs(repoRoot, SOURCE_DIR_NAMES, 4, excludedRoots);

  const directCandidates = SOURCE_DIR_NAMES;
  const workspaceCandidates = workspaceRoots.flatMap(root => [
    root,
    ...SOURCE_DIR_NAMES.map(name => normalizePath(path.join(root, name))),
  ]);

  const preferred = uniquePaths([
    ...directCandidates,
    ...discovered,
    ...workspaceCandidates,
  ])
    .filter(rel => rel !== '.')
    .filter(rel => !isExcludedPath(rel, excludedRoots))
    .filter(rel => isDirectory(path.join(repoRoot, rel)))
    .filter(rel => containsCodeFiles(path.join(repoRoot, rel)))
    .filter(rel => pathHasTrackedFiles(repoRoot, rel));

  if (preferred.length > 0) return sortBySpecificity(preferred);

  const workspaceFallback = uniquePaths(workspaceRoots)
    .filter(rel => rel !== '.')
    .filter(rel => !isExcludedPath(rel, excludedRoots))
    .filter(rel => isDirectory(path.join(repoRoot, rel)))
    .filter(rel => containsCodeFiles(path.join(repoRoot, rel)))
    .filter(rel => pathHasTrackedFiles(repoRoot, rel));

  if (workspaceFallback.length > 0) return sortBySpecificity(workspaceFallback);
  if (containsCodeFilesOutside(repoRoot, excludedRoots)) return ['.'];
  return [];
}

function detectTestRoots(repoRoot, sourceRoots = [], options = {}) {
  const excludedRoots = uniquePaths([...(options.excludedRoots || []), ...defaultExcludedRoots(repoRoot)])
    .filter(root => root !== '.');
  const discovered = discoverNamedDirs(repoRoot, TEST_DIR_NAMES, 5, excludedRoots);
  const baseCandidates = [...TEST_DIR_NAMES, ...discovered];

  const sourceAdjacent = [];
  uniquePaths(sourceRoots)
    .filter(root => root !== '.')
    .forEach(root => {
      const parent = normalizePath(path.dirname(root));
      for (const name of TEST_DIR_NAMES) {
        sourceAdjacent.push(parent && parent !== '.' ? normalizePath(path.join(parent, name)) : name);
      }
    });

  const workspaceAdjacent = detectWorkspaceRoots(repoRoot).flatMap(root =>
    TEST_DIR_NAMES.map(name => normalizePath(path.join(root, name)))
  );

  return sortBySpecificity(
    uniquePaths([...baseCandidates, ...sourceAdjacent, ...workspaceAdjacent])
      .filter(rel => rel !== '.')
      .filter(rel => !isExcludedPath(rel, excludedRoots))
      .filter(rel => isDirectory(path.join(repoRoot, rel)))
      .filter(rel => containsCodeFiles(path.join(repoRoot, rel)))
      .filter(rel => pathHasTrackedFiles(repoRoot, rel))
  );
}

function detectArchiveLikeDirs(repoRoot, options = {}) {
  const excludedRoots = uniquePaths([...(options.excludedRoots || []), ...defaultExcludedRoots(repoRoot)])
    .filter(root => root !== '.');
  return sortBySpecificity(
    discoverNamedDirs(repoRoot, ARCHIVE_DIR_NAMES, 6, excludedRoots)
      .filter(rel => rel !== '.')
      .filter(rel => isDirectory(path.join(repoRoot, rel)))
      .filter(rel => pathHasTrackedFiles(repoRoot, rel))
  );
}

function titleCasePath(value) {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .map(segment => segment.replace(/[-_]+/g, ' '))
    .join(' ')
    .replace(/\b[a-z]/g, char => char.toUpperCase());
}

function buildContextZones({ sourceRoots = [], testRoots = [], docsDir = 'docs', dateStamp = toDateStamp() } = {}) {
  const zones = [];
  const seenPathSets = new Set();

  function addZone(name, paths, belief) {
    const cleanPaths = uniquePaths(paths)
      .map(item => normalizePath(item))
      .filter(Boolean);
    if (!cleanPaths.length) return;

    const key = cleanPaths.join('|');
    if (seenPathSets.has(key)) return;
    seenPathSets.add(key);

    zones.push({
      name,
      paths: cleanPaths,
      belief,
      last_updated: dateStamp,
    });
  }

  const roots = uniquePaths(sourceRoots);
  if (roots.length === 0) roots.push('src');

  roots.forEach(root => {
    const pattern = root === '.' ? '**/*' : `${root}/**/*`;
    const zoneName = root === '.' ? 'Repository Core' : `${titleCasePath(root)} Zone`;
    addZone(zoneName, [pattern], 'TODO: Describe what this zone governs.');
  });

  const tests = uniquePaths(testRoots).filter(root => root !== '.');
  if (tests.length > 0) {
    addZone(
      'Tests',
      tests.map(root => `${root}/**/*`),
      'Automated checks that validate behavior and integration boundaries.'
    );
  }

  const docsPath = normalizePath(docsDir);
  if (docsPath && docsPath !== '.') {
    addZone('Documentation', [`${docsPath}/**/*`], 'User-facing and internal documentation for this codebase.');
  }

  return zones;
}

function ensureContextMap(repoRoot, mapFile, options = {}) {
  const mapPath = path.isAbsolute(mapFile)
    ? mapFile
    : path.join(repoRoot, mapFile || 'sherlog.context.json');
  const existed = fs.existsSync(mapPath);

  if (existed && !options.force) {
    return { created: false, updated: false, mapPath, zones: 0 };
  }

  const zones = buildContextZones({
    sourceRoots: options.sourceRoots,
    testRoots: options.testRoots,
    docsDir: options.docsDir,
  });

  ensureDir(path.dirname(mapPath));
  fs.writeFileSync(mapPath, JSON.stringify({ zones }, null, 2) + '\n', 'utf8');

  return {
    created: !existed,
    updated: existed,
    mapPath,
    zones: zones.length,
  };
}

function validateDropIntegrity() {
  const missing = REQUIRED_DROP_FILES.filter(relPath => !fs.existsSync(path.join(DROP_ROOT, relPath)));
  if (missing.length === 0) return;

  const details = missing.map(item => `- ${item}`).join('\n');
  throw new Error(
    `Drop package is incomplete. Missing required files:\n${details}\n` +
      'Re-copy sherlog-velocity and re-run install.'
  );
}

function loadDropVersion() {
  const pkg = readJson(DROP_PACKAGE_PATH, {});
  return String(pkg.version || '0.0.0');
}

function detectRepoRoot() {
  return detectGitRepoRoot(process.cwd());
}

function detectStack(root) {
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const framework =
        deps.next ? 'Next.js' :
        deps.astro ? 'Astro' :
        deps.express ? 'Express' :
        deps['@remix-run/react'] ? 'Remix' :
        deps['@nestjs/core'] ? 'NestJS' :
        deps.electron ? 'Electron' :
        deps.react ? 'React' :
        null;

      return {
        language: 'JavaScript/TypeScript',
        framework,
      };
    } catch {
      return { language: 'JavaScript', framework: null };
    }
  }

  if (fs.existsSync(path.join(root, 'requirements.txt')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
    return { language: 'Python', framework: null };
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) return { language: 'Go', framework: null };
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return { language: 'Rust', framework: null };
  return { language: 'Generic', framework: null };
}

function detectCI(root) {
  if (fs.existsSync(path.join(root, '.github', 'workflows'))) return 'github-actions';
  if (fs.existsSync(path.join(root, '.gitlab-ci.yml'))) return 'gitlab-ci';
  if (fs.existsSync(path.join(root, '.circleci', 'config.yml'))) return 'circleci';
  return null;
}

function detectBundler(root) {
  if (fs.existsSync(path.join(root, 'context.json'))) {
    return { type: 'context.ai', bundles: [] };
  }

  return { type: null, bundles: [] };
}

function detectContext(root) {
  const sherlogMap = path.join(root, 'sherlog.context.json');

  if (fs.existsSync(sherlogMap)) {
    return { mode: 'sherlog-map', map_file: sherlogMap };
  }

  return { mode: 'sherlog-map', map_file: sherlogMap };
}

function detectDocsDir(root) {
  const candidates = ['docs', 'documentation', 'wiki'];
  for (const dir of candidates) {
    const full = path.join(root, dir);
    if (isDirectory(full)) return dir;
  }
  return 'docs';
}

function pathPatternForRoot(root) {
  const normalized = normalizePath(root);
  if (!normalized || normalized === '.') return '**/*';
  return `${normalized}/**`;
}

function inferPathLanes(repoRoot, options = {}) {
  const sourceRoots = uniquePaths(options.sourceRoots || detectSourceRoots(repoRoot));
  const testRoots = uniquePaths(options.testRoots || detectTestRoots(repoRoot, sourceRoots));
  const archiveRoots = uniquePaths(options.archiveRoots || detectArchiveLikeDirs(repoRoot));
  const generatedRoots = uniquePaths(options.generatedRoots || [
    'dist',
    'build',
    'coverage',
    'out',
    'generated',
    'velocity-artifacts',
    '.astro',
    '.next',
  ]);
  const lanes = [
    {
      name: 'core',
      mode: 'strict',
      include: [],
      exclude: [],
    },
  ];

  if (testRoots.length > 0) {
    lanes.push({
      name: 'tests',
      mode: 'strict',
      include: testRoots.map(pathPatternForRoot),
      exclude: [],
    });
  }

  if (isDirectory(path.join(repoRoot, 'scripts'))) {
    lanes.push({
      name: 'scripts',
      mode: 'relaxed',
      include: ['scripts/**'],
      exclude: [],
    });
  }

  const legacyPatterns = uniquePaths([
    ...archiveRoots.map(pathPatternForRoot),
    'legacy/**',
    'archive/**',
    'deprecated/**',
    'prototype/**',
    'prototypes/**',
    'experimental/**',
    'sandbox/**',
  ]);
  if (legacyPatterns.length > 0) {
    lanes.push({
      name: 'legacy',
      mode: 'relaxed',
      include: legacyPatterns,
      exclude: [],
    });
  }

  const generatedPatterns = uniquePaths([
    ...generatedRoots.map(pathPatternForRoot),
    '**/*.generated.js',
    '**/*.generated.ts',
    '**/*.generated.jsx',
    '**/*.generated.tsx',
  ]);
  if (generatedPatterns.length > 0) {
    lanes.push({
      name: 'generated',
      mode: 'excluded',
      include: generatedPatterns,
      exclude: [],
    });
  }

  return {
    default_lane: 'core',
    lanes,
  };
}

function buildAutoContextGuess(repoRoot, options = {}) {
  const stack = detectStack(repoRoot);
  const docsDir = options.docsDir || detectDocsDir(repoRoot);
  const sourceRoots = uniquePaths(options.sourceRoots || detectSourceRoots(repoRoot));
  const testRoots = uniquePaths(options.testRoots || detectTestRoots(repoRoot, sourceRoots));
  const archiveRoots = uniquePaths(options.archiveRoots || detectArchiveLikeDirs(repoRoot));
  const pathLanes = inferPathLanes(repoRoot, {
    sourceRoots,
    testRoots,
    archiveRoots,
  });

  return {
    stack,
    docs_dir: docsDir,
    source_roots: sourceRoots,
    test_roots: testRoots,
    archive_roots: archiveRoots,
    path_lanes_default: pathLanes.default_lane,
    path_lanes: pathLanes.lanes,
  };
}

function parseInstallArgs(argv) {
  const out = {
    sourceRoots: [],
    forceContext: false,
    auto: false,
    targetRepo: '',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source-root' && argv[i + 1]) out.sourceRoots.push(argv[++i]);
    else if (arg === '--force-context') out.forceContext = true;
    else if (arg === '--auto') out.auto = true;
    else if (arg === '--target-repo' && argv[i + 1]) out.targetRepo = argv[++i];
  }

  return out;
}

function normalizeSourceRootArg(repoRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const normalized = normalizePath(relative);
  return normalized || '.';
}

function nodeScriptCommand(relDropPath, scriptPath) {
  const normalizedRoot = relDropPath && relDropPath !== '.' ? relDropPath : '';
  const full = path.posix.join(normalizedRoot, scriptPath);
  return `node ${full}`;
}

function cliScriptCommand(command, suffix = '') {
  return `sherlog ${command}${suffix ? ` ${suffix}` : ''}`;
}

function canonicalScriptCommand(command) {
  return String(command || '')
    .trim()
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ');
}

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function shouldBootstrapLocalInstall(repoRoot) {
  if (DROP_ROOT === repoRoot) return false;
  const localDropRoot = path.join(repoRoot, 'sherlog-velocity');
  const nodeModulesDropRoot = path.join(repoRoot, 'node_modules', 'sherlog-velocity');
  if (DROP_ROOT === localDropRoot || DROP_ROOT === nodeModulesDropRoot) return false;
  return !isWithin(repoRoot, DROP_ROOT);
}

function bootstrapInstalledPackage(repoRoot, cliArgs) {
  const pkg = readJson(DROP_PACKAGE_PATH, {});
  const packageName = String(pkg.name || 'sherlog-velocity');
  const packageVersion = String(pkg.version || 'latest');
  const installTarget = `${packageName}@${packageVersion}`;

  console.log(`Bootstrapping local Sherlog package in ${repoRoot}...`);
  execSync(`npm install --save-dev ${installTarget}`, { cwd: repoRoot, stdio: 'inherit' });

  const delegatedInstallPath = path.join(repoRoot, 'node_modules', packageName, 'install.js');
  const delegatedArgs = [];
  if (cliArgs.auto) delegatedArgs.push('--auto');
  if (cliArgs.forceContext) delegatedArgs.push('--force-context');
  cliArgs.sourceRoots.forEach(root => delegatedArgs.push('--source-root', root));
  delegatedArgs.push('--target-repo', repoRoot);

  execFileSync(process.execPath, [delegatedInstallPath, ...delegatedArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function wireHostScripts(repoRoot) {
  const hostPkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(hostPkgPath)) {
    console.log('No host package.json found. Skipping script wiring.');
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(hostPkgPath, 'utf8'));
  } catch {
    console.log('Could not parse host package.json. Skipping script wiring.');
    return;
  }

  const { installedPackageMode } = findRuntimeConfigPath({ cwd: repoRoot, packageRoot: DROP_ROOT });
  const relDropPath = normalizePath(path.relative(repoRoot, DROP_ROOT)) || '.';
  const commandFor = (command, scriptPath, suffix = '') =>
    installedPackageMode
      ? cliScriptCommand(command, suffix)
      : `${nodeScriptCommand(relDropPath, scriptPath)}${suffix ? ` ${suffix}` : ''}`;
  const desiredScripts = {
    'velocity:run': commandFor('analyze', 'src/core/analyzer.js'),
    'velocity:report': commandFor('report', 'src/core/reporter.js'),
    'velocity:estimate': commandFor('estimate', 'src/core/estimate.js'),
    'sherlog:init': commandFor('init', 'src/cli/init-context.js'),
    'sherlog:verify': commandFor('verify', 'src/cli/verify.js', '--strict'),
    'sherlog:doctor': commandFor('doctor', 'src/cli/doctor.js'),
    'sherlog:gaps': commandFor('gaps', 'src/cli/gaps.js'),
    'sherlog:digest': commandFor('digest', 'src/cli/digest.js'),
    'sherlog:update': commandFor('update', 'src/cli/update.js'),
    'sherlog:setup': commandFor('setup', 'src/cli/setup.js'),
    'sherlog:consumers': commandFor('consumers', 'src/cli/consumers.js'),
    'sherlog:bounds': commandFor('bounds', 'src/cli/bounds.js'),
    'sherlog:prompt': commandFor('prompt', 'src/cli/prompt.js'),
    'sherlog:init-context': commandFor('init-context', 'src/cli/init-context.js'),
    'sherlog:index-sync': commandFor('index-sync', 'src/cli/index-sync.js'),
    'sherlog:bridge': commandFor('bridge', 'src/cli/bridge.js'),
    'sherlog:retrospective': commandFor('retrospective', 'src/cli/retrospective.js'),
    'sherlog:hygiene': commandFor('hygiene', 'src/cli/hygiene.js'),
    'sherlog:dead-code': commandFor('dead-code', 'src/cli/dead-code.js'),
    'sherlog:skills:suggest': commandFor('skills', 'src/cli/skills.js', '--suggest'),
    'sherlog:skills:generate': commandFor('skills', 'src/cli/skills.js', '--generate'),
    'sherlog:session:start': commandFor('session', 'src/cli/session.js', 'start'),
    'sherlog:session:end': commandFor('session', 'src/cli/session.js', 'end'),
    'sherlog:session:report': commandFor('session', 'src/cli/session.js', 'report'),
    'sherlog:session:status': commandFor('session', 'src/cli/session.js', 'status'),
    'sherlog:session:note': commandFor('session', 'src/cli/session.js', 'note'),
    'velocity:all': 'npm run velocity:run && npm run velocity:report',
  };

  pkg.scripts = pkg.scripts || {};
  for (const [name, cmd] of Object.entries(desiredScripts)) {
    const legacyName = `${name}:legacy`;
    const existing = pkg.scripts[name];

    if (existing && canonicalScriptCommand(existing) !== canonicalScriptCommand(cmd)) {
      if (!pkg.scripts[legacyName]) pkg.scripts[legacyName] = pkg.scripts[name];
    }

    pkg.scripts[name] = cmd;

    if (
      pkg.scripts[legacyName] &&
      canonicalScriptCommand(pkg.scripts[legacyName]) === canonicalScriptCommand(cmd)
    ) {
      delete pkg.scripts[legacyName];
    }
  }

  fs.writeFileSync(hostPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('Host package.json scripts wired.');
}

function runBaseline(repoRoot) {
  const analyzerPath = path.join(DROP_ROOT, 'src', 'core', 'analyzer.js');
  const reporterPath = path.join(DROP_ROOT, 'src', 'core', 'reporter.js');
  try {
    execSync(`node "${analyzerPath}"`, { cwd: repoRoot, stdio: 'inherit' });
    execSync(`node "${reporterPath}"`, { cwd: repoRoot, stdio: 'inherit' });
  } catch (err) {
    console.log(`Baseline run did not fully complete: ${err.message}`);
  }
}

function runPostInstallVerification(repoRoot) {
  const verifierPath = path.join(DROP_ROOT, 'src', 'cli', 'verify.js');
  try {
    console.log('');
    console.log('Running post-install verification...');
    execSync(`node "${verifierPath}" --strict`, { cwd: repoRoot, stdio: 'inherit' });
  } catch (err) {
    console.log(`Verification command encountered an error: ${err.message}`);
  }
}

function writeNextStepsGuide(repoRoot, docsDir) {
  const guidePath = path.join(repoRoot, docsDir, 'sherlog-next-steps.md');
  const nextStepsContent = `
# Sherlog Velocity: Operational Protocol

## Phase 1: Establish Baseline (Immediate)
- [ ] Verify install wiring and config:
  \`npm run sherlog:verify -- --json\`
- [ ] Seed data: run \`npm run velocity:run\` at least 5 times (or once per day) to build history.
- [ ] First report: run \`npm run velocity:report\` and verify \`${docsDir}/velocity-forecast.md\`.

## Phase 2: Active Workflow (Daily)
- [ ] One-command system health check:
  \`npm run sherlog:doctor -- --feature "Feature Name" --json\`
- [ ] Estimation before work:
  \`npm run velocity:estimate -- --feature "Feature Name"\`
- [ ] Inspect raw gaps:
  \`npm run sherlog:gaps -- --feature "Feature Name" --json\`
- [ ] Review salience ranking and delta trend in gap output (RC2 contradiction score).
- [ ] AI context prompt:
  \`npm run sherlog:prompt -- "Feature Name"\`

## Phase 3: Automation (Weekly)
- [ ] CI/Hooks: add \`npm run velocity:run\` to \`.husky/pre-commit\` or CI.
- [ ] Context map maintenance: run \`npm run sherlog:init-context -- --force\` after major refactors.
- [ ] Optional acknowledgements: maintain \`sherlog.acknowledgements.json\` with defer/exempt entries and expiries.
- [ ] Inspect raw context drift: \`npm run sherlog:gaps -- --feature "Feature Name" --json\`
- [ ] Phase 4 active: map staleness/drift checks run during \`velocity:estimate\`, \`sherlog:gaps\`, and \`sherlog:prompt\`.
- [ ] Review known integration pitfalls: \`${docsDir}/sherlog-lessons-learned.md\`
`.trim();

  ensureDir(path.dirname(guidePath));
  fs.writeFileSync(guidePath, nextStepsContent + '\n', 'utf8');
  return guidePath;
}

function writeWhySherlogGuide(repoRoot, docsDir) {
  const whyPath = path.join(repoRoot, docsDir, 'why-sherlog.md');
  const content = `
# Why Sherlog

Sherlog is a context-intelligence layer for planning and execution.

1. Personalized velocity:
   it uses your repository history to estimate timelines from real delivery pace.
2. Explicit gaps:
   it turns vague uncertainty into concrete missing pieces (implementation/tests/docs/context).
3. Context drift detection:
   it compares code changes against your context map and flags stale or uncovered areas.

Use this command first when planning a feature:

\`\`\`bash
npm run sherlog:doctor -- --feature "Feature Name" --json
\`\`\`
`.trim();

  ensureDir(path.dirname(whyPath));
  fs.writeFileSync(whyPath, content + '\n', 'utf8');
  return whyPath;
}

function writeLessonsLearnedGuide(repoRoot, docsDir) {
  const lessonsPath = path.join(repoRoot, docsDir, 'sherlog-lessons-learned.md');
  const content = `
# Sherlog Lessons Learned

These are the most common reasons Sherlog appears installed but is not truly operational.

## 1) UI exists but is not mounted
- Symptom: \`VelocityPanel\` file exists, but no route/page imports it.
- Fix: mount \`VelocityPanel\` in a real route if you want in-app visibility.

## 2) AGENTS instructions drift from scripts
- Symptom: \`AGENTS.md\` says run \`sherlog:doctor\`, but host \`package.json\` lacks that script.
- Fix: run \`node sherlog-velocity/install.js\` again, then \`npm run sherlog:verify -- --json\`.

## 3) Empty or over-broad source roots
- Symptom: constant \`missing_implementation\` false positives.
- Fix: set \`paths.source_roots\` to real code roots (for example \`vessel/src\`), avoid \`.\` when possible.

## 4) Archive directories inflate drift
- Symptom: \`context_drift\` triggered by legacy/archived files unrelated to current work.
- Fix: add archive paths to \`settings.gap_scan_ignore_dirs\` in Sherlog config.

## Operational Rule
Before planning features in a new repo, run:

\`\`\`bash
npm run sherlog:verify -- --json
npm run sherlog:doctor -- --feature "Feature Name" --json
npm run sherlog:gaps -- --feature "Feature Name" --json
\`\`\`
`.trim();

  ensureDir(path.dirname(lessonsPath));
  fs.writeFileSync(lessonsPath, content + '\n', 'utf8');
  return lessonsPath;
}

function ensureAgentsInstructions(repoRoot, docsDir) {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  const markerStart = '<!-- SHERLOG START -->';
  const markerEnd = '<!-- SHERLOG END -->';
  const docsGuideBase = normalizePath(docsDir || 'docs') || 'docs';
  const nextStepsPath = `/${docsGuideBase}/sherlog-next-steps.md`;
  const whyPath = `/${docsGuideBase}/why-sherlog.md`;
  const block = [
    markerStart,
    '## Sherlog Preflight (Required)',
    '',
    'Before proposing plans, estimates, or implementation order for a feature, run:',
    '',
    '```bash',
    'npm run sherlog:verify -- --json',
    'npm run sherlog:doctor -- --feature "Feature Name" --json',
    'npm run sherlog:gaps -- --feature "Feature Name" --json',
    'npm run sherlog:prompt -- "Feature Name"',
    '```',
    '',
    '## Sherlog Session Contract (Required)',
    '',
    'Run session tracking for every coding session:',
    '',
    '```bash',
    'npm run sherlog:session:start -- "Feature Name"',
    'npm run sherlog:session:note -- "what changed"',
    'npm run sherlog:session:prompt -- --lookback 5',
    'npm run sherlog:session:end',
    '```',
    '',
    'The agent should explicitly start the current coding session instead of inheriting an unrelated active session.',
    '',
    'If `settings.session_autostart_on_feature_commands` is true, `doctor`/`gaps`/`prompt`/`estimate` may auto-start a session when none is active, but that mode is optional and still command-time only.',
    '',
    `Use \`${nextStepsPath}\` and \`${whyPath}\` as the local operating guide.`,
    markerEnd,
    '',
  ].join('\n');

  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, `# Agent Guide\n\n${block}`, 'utf8');
    return { path: agentsPath, status: 'created' };
  }

  const current = fs.readFileSync(agentsPath, 'utf8');
  const hasMarkers = current.includes(markerStart) && current.includes(markerEnd);
  let next;

  if (hasMarkers) {
    const start = current.indexOf(markerStart);
    const end = current.indexOf(markerEnd) + markerEnd.length;
    next = `${current.slice(0, start)}${block}${current.slice(end)}`.replace(/\n{3,}/g, '\n\n');
  } else {
    next = `${current.trimEnd()}\n\n${block}`;
  }

  fs.writeFileSync(agentsPath, next, 'utf8');
  return { path: agentsPath, status: hasMarkers ? 'updated' : 'appended' };
}

function main() {
  console.log('Sherlog Velocity: initializing drop package');
  validateDropIntegrity();
  const cliArgs = parseInstallArgs(process.argv);

  const repoRoot = cliArgs.targetRepo
    ? path.resolve(cliArgs.targetRepo)
    : detectRepoRoot();
  if (shouldBootstrapLocalInstall(repoRoot)) {
    bootstrapInstalledPackage(repoRoot, cliArgs);
    return;
  }
  const stateRoot = resolveSherlogStateRoot(repoRoot, { packageRoot: DROP_ROOT, cwd: repoRoot });
  const configDir = path.join(stateRoot, 'config');
  const dataDir = path.join(stateRoot, 'data');
  const configPath = path.join(configDir, 'sherlog.config.json');
  const docsDir = detectDocsDir(repoRoot);
  const autoGuess = buildAutoContextGuess(repoRoot, {
    docsDir,
    sourceRoots: cliArgs.sourceRoots
      .map(item => normalizeSourceRootArg(repoRoot, item))
      .filter(Boolean),
  });
  const stack = autoGuess.stack;
  const ci = detectCI(repoRoot);
  const bundler = detectBundler(repoRoot);
  const sourceRoots = autoGuess.source_roots;
  const testRoots = autoGuess.test_roots;
  const archiveIgnoreDirs = autoGuess.archive_roots;
  const context = detectContext(repoRoot);
  const dropVersion = loadDropVersion();

  ensureDir(configDir);
  ensureDir(dataDir);
  const existingConfig = readJson(configPath, null);

  let contextMapUpdate = { created: false, updated: false, mapPath: context.map_file, zones: 0 };
  if (context.mode === 'sherlog-map') {
    contextMapUpdate = ensureContextMap(repoRoot, context.map_file, {
      sourceRoots,
      testRoots,
      docsDir,
      force: cliArgs.forceContext,
    });
    context.map_file = contextMapUpdate.mapPath;
  }

  const generatedConfig = {
    version: 2,
    drop_version: dropVersion,
    repo_root: repoRoot,
    installed_at: new Date().toISOString(),
    stack,
    ci,
    bundler,
    context,
    paths: {
      velocity_log: path.join(dataDir, 'velocity-log.jsonl'),
      gap_history_log: path.join(dataDir, 'gap-history.jsonl'),
      gap_acknowledgements: path.join(repoRoot, 'sherlog.acknowledgements.json'),
      profile_run_history_log: path.join(dataDir, 'profile-run-history.jsonl'),
      profile_run_artifacts_dir: path.join(repoRoot, 'velocity-artifacts', 'sherlog-runs'),
      core_suite_history_log: path.join(dataDir, 'core-suite-history.jsonl'),
      report_output_markdown: path.join(repoRoot, docsDir, 'velocity-forecast.md'),
      summary_output_json: path.join(repoRoot, 'velocity-artifacts', 'velocity-summary.json'),
      gap_weights: path.join(configDir, 'gap-weights.json'),
      docs_dir: docsDir,
      source_roots: sourceRoots,
      test_roots: testRoots,
      context_map: context.map_file,
    },
    settings: {
      window_days: Number(process.env.VELOCITY_WINDOW_DAYS || 7),
      session_autostart_on_feature_commands: false,
      gap_analysis: Boolean(bundler.type) || context.mode !== 'none',
      gap_scan_ignore_dirs: archiveIgnoreDirs,
      path_lanes_default: autoGuess.path_lanes_default,
      path_lanes: autoGuess.path_lanes,
      lane_multipliers: {
        strict: 1,
        relaxed: 0.35,
        excluded: 0,
      },
      convergence_thresholds: {
        implementation: 0.5,
        tests: 0.45,
        docs: 0.5,
        overall: 0.45,
      },
      convergence_weights: {
        implementation: { path: 0.45, export: 0.35, callsite: 0.2 },
        tests: { path: 0.65, content: 0.35 },
        docs: { path: 0.55, content: 0.45 },
        overall: { implementation: 0.45, tests: 0.3, docs: 0.25 },
      },
      core_suite_features: [
        'Sherlog Control Center UI',
        'Sherlog Vibe Coder Doctrine',
        'Sherlog Session Summary Launch Risk',
        'Sherlog Feature Profile Registry',
        'Sherlog Acknowledgement Expiry Flow',
      ],
      feature_profiles: {
        'sherlog-control-center-ui': {
          aliases: ['sherlog control center', 'velocity panel', 'sherlog panel'],
          path_hints: ['sherlog-vscode/**'],
          implementation_path_hints: ['sherlog-vscode/extension.js'],
          doc_path_hints: ['sherlog-vscode/README.md', 'docs/sherlog-next-steps.md', 'docs/why-sherlog.md'],
          export_hints: ['runProfileCheck', 'saveHeuristics', 'saveProfiles', 'saveAcknowledgements', 'loadRunHistory'],
          callsite_hints: ['sherlog.openPanel', 'runTaskfile', 'loadControlState'],
        },
      },
    },
  };

  const config = preserveExistingConfig(generatedConfig, existingConfig);
  fs.writeFileSync(configPath, JSON.stringify(toPortableConfig(config, repoRoot), null, 2) + '\n', 'utf8');
  console.log(`Config written: ${configPath}`);
  console.log(`Drop version: ${dropVersion}`);
  console.log(`Detected stack: ${stack.language}${stack.framework ? ` (${stack.framework})` : ''}`);
  console.log(`Detected CI: ${ci || 'none'}`);
  console.log(`Detected bundler: ${bundler.type || 'none'}`);
  console.log(`Detected source roots: ${sourceRoots.length ? sourceRoots.join(', ') : 'none'}`);
  if (testRoots.length) {
    console.log(`Detected test roots: ${testRoots.join(', ')}`);
  }
  if (archiveIgnoreDirs.length) {
    console.log(`Detected archive-like dirs (ignored for gaps): ${archiveIgnoreDirs.join(', ')}`);
  }
  console.log(`Detected context mode: ${context.mode}`);
  console.log(`Context map file: ${context.map_file}`);
  console.log(`Sherlog state root: ${stateRoot}`);

  if (context.mode === 'sherlog-map') {
    if (contextMapUpdate.created) {
      console.log(`Context map created with ${contextMapUpdate.zones} zone(s).`);
    } else if (contextMapUpdate.updated) {
      console.log(`Context map refreshed with ${contextMapUpdate.zones} zone(s).`);
    } else {
      console.log('Context map already exists. Preserving existing file.');
    }
  }

  wireHostScripts(repoRoot);
  runBaseline(repoRoot);
  const guidePath = writeNextStepsGuide(repoRoot, docsDir);
  const whyPath = writeWhySherlogGuide(repoRoot, docsDir);
  const lessonsPath = writeLessonsLearnedGuide(repoRoot, docsDir);
  const agentsStatus = ensureAgentsInstructions(repoRoot, docsDir);
  console.log(`AI guidance written: ${guidePath}`);
  console.log(`Why guide written: ${whyPath}`);
  console.log(`Lessons guide written: ${lessonsPath}`);
  console.log(`Agent instructions ${agentsStatus.status}: ${agentsStatus.path}`);
  runPostInstallVerification(repoRoot);

  console.log('');
  console.log('Sherlog Velocity installed successfully.');
  console.log('');
  console.log('NEXT STEPS (Phase 2+)');
  console.log('1. Run `npm run sherlog:verify -- --json` and resolve any FAIL/WARN checks.');
  console.log('2. Run `npm run velocity:run` (need 5+ runs for stable accuracy).');
  console.log('3. Run `npm run velocity:report` to generate docs/artifacts.');
  console.log('4. Run `npm run sherlog:doctor -- --feature "Your Feature" --json` for machine-readable health.');
  console.log('5. Use `npm run sherlog:prompt -- "Your Feature"` for AI instructions.');
  console.log('6. Use `npm run sherlog:init-context -- --force` after major structure changes.');
  console.log('7. Enable CI/pre-commit automation.');
  console.log('');
  console.log(`Guide: ${guidePath}`);
}

if (require.main === module) main();

module.exports = {
  buildAutoContextGuess,
  buildContextZones,
  detectDocsDir,
  detectRepoRoot,
  detectSourceRoots,
  detectTestRoots,
  detectArchiveLikeDirs,
  detectStack,
  ensureContextMap,
  inferPathLanes,
  normalizePath,
  wireHostScripts,
};
