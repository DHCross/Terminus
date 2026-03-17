const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORTABLE_CONFIG_PATH_KEYS = [
  'velocity_log',
  'gap_history_log',
  'gap_acknowledgements',
  'profile_run_history_log',
  'profile_run_artifacts_dir',
  'core_suite_history_log',
  'report_output_markdown',
  'summary_output_json',
  'gap_weights',
  'context_map',
  'generated_context_map',
  'self_model_index',
  'repomix_manifest',
  'hygiene_history_log',
  'retrospective_log',
];
const PORTABLE_CONFIG_ARRAY_KEYS = [
  'source_roots',
  'test_roots',
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, defaultValue = '') {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultValue, 'utf8');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function cloneJson(value) {
  return value && typeof value === 'object'
    ? JSON.parse(JSON.stringify(value))
    : value;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function runGit(repoRoot, cmd) {
  return execSync(cmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function detectBranchHead(repoRoot) {
  try {
    return {
      branch: runGit(repoRoot, 'git rev-parse --abbrev-ref HEAD'),
      head: runGit(repoRoot, 'git rev-parse HEAD'),
    };
  } catch {
    return { branch: 'unknown', head: 'unknown' };
  }
}

function parseCommitRows(raw) {
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [sha, date, subject] = line.split('|');
    return { sha, date, subject };
  }).filter(r => r.sha && r.date);
}

function getGitWindowMetrics(repoRoot, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cmd = `git log --since="${since}" --pretty=format:"%H|%ai|%s"`;

  let raw;
  try {
    raw = runGit(repoRoot, cmd);
  } catch {
    return {
      window_days: days,
      total_commits: 0,
      total_duration_seconds: 0,
      commits_per_hour_active: 0,
      commits_per_day_window: 0,
      start: null,
      end: null,
      samples: [],
    };
  }

  const rows = parseCommitRows(raw);
  if (!rows.length) {
    return {
      window_days: days,
      total_commits: 0,
      total_duration_seconds: 0,
      commits_per_hour_active: 0,
      commits_per_day_window: 0,
      start: null,
      end: null,
      samples: [],
    };
  }

  const times = rows.map(r => new Date(r.date).getTime()).filter(Number.isFinite);
  const startMs = Math.min(...times);
  const endMs = Math.max(...times);
  const durationSec = Math.max(1, Math.round((endMs - startMs) / 1000));

  return {
    window_days: days,
    total_commits: rows.length,
    total_duration_seconds: durationSec,
    commits_per_hour_active: rows.length / (durationSec / 3600),
    commits_per_day_window: rows.length / days,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    samples: rows.slice(0, 20),
  };
}

function rolling(entries, limit = 10) {
  const slice = entries.slice(-limit);
  if (!slice.length) return null;
  const commits = slice.reduce((sum, row) => sum + (row.total_commits || 0), 0);
  const seconds = slice.reduce((sum, row) => sum + (row.total_duration_seconds || 0), 0);
  const days = slice.reduce((sum, row) => sum + (row.window_days || 0), 0);

  return {
    sample: slice.length,
    commits,
    seconds,
    days,
    commits_per_hour_active: seconds > 0 ? commits / (seconds / 3600) : 0,
    commits_per_day_window: days > 0 ? commits / days : 0,
  };
}

function confidenceFromSample(size) {
  if (size >= 5) return 'high';
  if (size >= 3) return 'medium';
  return 'low';
}

function normalizeConfigPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

const LEGACY_ROOT_PREFIXES = ['vessel'];

function repoRelativePathVariants(value) {
  const normalized = normalizeConfigPath(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  LEGACY_ROOT_PREFIXES.forEach(prefix => {
    if (normalized !== prefix && !normalized.startsWith(`${prefix}/`)) {
      variants.add(`${prefix}/${normalized}`);
    }
    if (normalized.startsWith(`${prefix}/`)) {
      const stripped = normalized.slice(prefix.length + 1);
      if (stripped) variants.add(stripped);
    }
  });

  return Array.from(variants);
}

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveRepoRoot(configuredRepoRoot, fallbackRoot = process.cwd()) {
  const fallback = path.resolve(String(fallbackRoot || process.cwd()));
  const configured = String(configuredRepoRoot || '').trim();

  if (configured) {
    const candidate = path.isAbsolute(configured)
      ? configured
      : path.resolve(fallback, configured);
    if (isDirectory(candidate)) return candidate;
  }

  return fallback;
}

function resolveConfigPath(repoRoot, value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(repoRoot, candidate);
}

function toPortablePath(repoRoot, value) {
  const candidate = String(value || '').trim();
  if (!candidate) return null;

  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(repoRoot, candidate);
  const relative = normalizeConfigPath(path.relative(repoRoot, absolute));

  if (!relative) return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return normalizeConfigPath(candidate);
  }

  return relative;
}

function normalizePortablePathArray(repoRoot, values = []) {
  return (Array.isArray(values) ? values : [])
    .map(value => toPortablePath(repoRoot, value))
    .filter(Boolean);
}

function resolveRuntimeConfig(configInput, options = {}) {
  if (!configInput || typeof configInput !== 'object') return configInput;

  const config = cloneJson(configInput);
  const repoRoot = resolveRepoRoot(config.repo_root, options.cwd || process.cwd());

  config.repo_root = repoRoot;

  if (config.context?.map_file) {
    config.context.map_file = resolveConfigPath(repoRoot, config.context.map_file);
  }

  config.paths = config.paths && typeof config.paths === 'object'
    ? config.paths
    : {};

  PORTABLE_CONFIG_PATH_KEYS.forEach((key) => {
    if (!config.paths[key]) return;
    config.paths[key] = resolveConfigPath(repoRoot, config.paths[key]);
  });

  PORTABLE_CONFIG_ARRAY_KEYS.forEach((key) => {
    if (!config.paths[key]) return;
    config.paths[key] = normalizePortablePathArray(repoRoot, config.paths[key]);
  });

  return config;
}

function toPortableConfig(configInput, repoRootInput = null) {
  if (!configInput || typeof configInput !== 'object') return configInput;

  const config = cloneJson(configInput);
  const repoRoot = resolveRepoRoot(repoRootInput || config.repo_root, process.cwd());

  config.repo_root = '.';

  if (config.context?.map_file) {
    config.context.map_file = toPortablePath(repoRoot, config.context.map_file);
  }

  config.paths = config.paths && typeof config.paths === 'object'
    ? config.paths
    : {};

  PORTABLE_CONFIG_PATH_KEYS.forEach((key) => {
    if (!config.paths[key]) return;
    config.paths[key] = toPortablePath(repoRoot, config.paths[key]);
  });

  PORTABLE_CONFIG_ARRAY_KEYS.forEach((key) => {
    if (!config.paths[key]) return;
    config.paths[key] = normalizePortablePathArray(repoRoot, config.paths[key]);
  });

  return config;
}

module.exports = {
  confidenceFromSample,
  detectBranchHead,
  ensureDir,
  ensureFile,
  getGitWindowMetrics,
  readJson,
  readJsonLines,
  repoRelativePathVariants,
  resolveConfigPath,
  resolveRepoRoot,
  resolveRuntimeConfig,
  rolling,
  toPortableConfig,
};
