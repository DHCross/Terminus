#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig, readJson, resolveRuntimeConfig } = require('../core/shared');

const IGNORED_DIRS = new Set([
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

const ARCHIVE_HINT_DIRS = new Set(['archive', 'archives', 'attic', 'legacy', 'deprecated', 'old']);
const DEFAULT_GAP_SCAN_IGNORES = new Set([
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

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function parseArgs(argv) {
  const out = {
    json: false,
    strict: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
  }

  return out;
}

function walkFiles(root, visit, maxFiles = 120000) {
  if (!root || !fs.existsSync(root)) return;
  const stack = [root];
  let seen = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      seen += 1;
      if (seen > maxFiles) return;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) visit(fullPath);
    }
  }
}

function discoverArchiveLikeDirs(repoRoot) {
  const found = [];
  walkFiles(repoRoot, fullPath => {
    const rel = normalizePath(path.relative(repoRoot, fullPath));
    if (!rel) return;
    const segments = rel.split('/').slice(0, -1);
    for (let index = 0; index < segments.length; index += 1) {
      const seg = segments[index];
      if (ARCHIVE_HINT_DIRS.has(seg.toLowerCase())) {
        found.push(segments.slice(0, index + 1).join('/'));
        break;
      }
    }
  }, 60000);
  return Array.from(new Set(found));
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  const configPath = runtime.configPath;
  const rawConfig = runtime.config
    ? JSON.parse(JSON.stringify(runtime.config))
    : null;
  if (!rawConfig) {
    return {
      configPath,
      rawConfig: null,
      config: null,
      repoRoot: process.cwd(),
    };
  }

  const config = resolveRuntimeConfig(rawConfig);
  return {
    configPath,
    rawConfig,
    config,
    repoRoot: config.repo_root || process.cwd(),
  };
}

function collectPortabilityIssues(rawConfig, resolvedRepoRoot) {
  if (!rawConfig || typeof rawConfig !== 'object') return [];

  const issues = [];
  const rawRepoRoot = String(rawConfig.repo_root || '').trim();
  if (rawRepoRoot && path.isAbsolute(rawRepoRoot)) {
    issues.push({
      field: 'repo_root',
      value: rawRepoRoot,
      issue: resolvedRepoRoot !== rawRepoRoot ? 'dead_absolute_path' : 'absolute_path',
    });
  }

  const directPathFields = [
    ['context.map_file', rawConfig?.context?.map_file],
    ...Object.entries(rawConfig?.paths || {}).map(([key, value]) => [`paths.${key}`, value]),
  ];
  directPathFields.forEach(([field, value]) => {
    if (typeof value === 'string' && path.isAbsolute(value)) {
      issues.push({ field, value, issue: 'absolute_path' });
    }
  });

  const pathArrays = [
    ['paths.source_roots', rawConfig?.paths?.source_roots],
    ['paths.test_roots', rawConfig?.paths?.test_roots],
  ];
  pathArrays.forEach(([field, values]) => {
    (Array.isArray(values) ? values : []).forEach((value, index) => {
      if (typeof value === 'string' && path.isAbsolute(value)) {
        issues.push({
          field: `${field}[${index}]`,
          value,
          issue: 'absolute_path',
        });
      }
    });
  });

  return issues;
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function checkVelocityPanelMount(repoRoot) {
  const panelFiles = [];
  walkFiles(repoRoot, fullPath => {
    const base = path.basename(fullPath);
    if (base === 'VelocityPanel.tsx' || base === 'VelocityPanel.jsx' || base === 'VelocityPanel.ts') {
      panelFiles.push(fullPath);
    }
  }, 80000);

  if (panelFiles.length === 0) {
    return {
      id: 'ui_velocity_panel_mount',
      status: 'pass',
      message: 'No VelocityPanel component detected (UI panel is optional).',
      evidence: { panel_files: [] },
    };
  }

  let mounted = false;
  walkFiles(repoRoot, fullPath => {
    if (mounted) return;
    if (panelFiles.includes(fullPath)) return;
    const lower = fullPath.toLowerCase();
    if (!lower.endsWith('.tsx') && !lower.endsWith('.jsx') && !lower.endsWith('.ts') && !lower.endsWith('.js')) return;
    const content = safeReadText(fullPath);
    if (/\bVelocityPanel\b/.test(content)) mounted = true;
  }, 100000);

  if (mounted) {
    return {
      id: 'ui_velocity_panel_mount',
      status: 'pass',
      message: 'VelocityPanel appears mounted/imported in the app code.',
      evidence: { panel_files: panelFiles.map(file => normalizePath(path.relative(repoRoot, file))) },
    };
  }

  return {
    id: 'ui_velocity_panel_mount',
    status: 'warn',
    message: 'VelocityPanel exists but appears unmounted; UI will not show Sherlog panel.',
    fix: 'Import and render VelocityPanel in an app route/page if in-app visibility is desired.',
    evidence: { panel_files: panelFiles.map(file => normalizePath(path.relative(repoRoot, file))) },
  };
}

function checkOperationalWiring(context) {
  const checks = [];
  const {
    configPath,
    rawConfig,
    config,
    repoRoot,
  } = context;

  if (!config) {
    checks.push({
      id: 'config_exists',
      status: 'fail',
      message: 'Sherlog config missing.',
      fix: 'Run `node sherlog-velocity/install.js` from the repo root.',
      evidence: { config_path: configPath },
    });
    return checks;
  }

  checks.push({
    id: 'config_exists',
    status: 'pass',
    message: 'Sherlog config found.',
    evidence: { config_path: configPath },
  });

  const portabilityIssues = collectPortabilityIssues(rawConfig, repoRoot);
  checks.push({
    id: 'portable_config_paths',
    status: portabilityIssues.length > 0 ? 'warn' : 'pass',
    message: portabilityIssues.length > 0
      ? 'Sherlog config contains machine-specific absolute paths.'
      : 'Sherlog config paths are portable.',
    fix: portabilityIssues.length > 0
      ? 'Store `repo_root` as "." and serialize Sherlog path fields relative to the repo root.'
      : null,
    evidence: {
      repo_root: rawConfig?.repo_root || null,
      issues: portabilityIssues,
    },
  });

  const hostPkgPath = path.join(repoRoot, 'package.json');
  const hostPkg = readJson(hostPkgPath, null);
  if (!hostPkg || typeof hostPkg !== 'object') {
    checks.push({
      id: 'host_package_json',
      status: 'fail',
      message: 'Host package.json missing or invalid.',
      fix: 'Ensure package.json exists and rerun installer to wire Sherlog scripts.',
      evidence: { package_json: hostPkgPath },
    });
  } else {
    checks.push({
      id: 'host_package_json',
      status: 'pass',
      message: 'Host package.json found.',
      evidence: { package_json: hostPkgPath },
    });

    const requiredScripts = ['sherlog:verify', 'sherlog:doctor', 'sherlog:gaps', 'sherlog:bounds', 'sherlog:frontier', 'sherlog:prompt', 'sherlog:dependency-graph', 'sherlog:hygiene', 'velocity:estimate'];
    const missingScripts = requiredScripts.filter(name => !hostPkg.scripts || !hostPkg.scripts[name]);
    checks.push({
      id: 'required_scripts',
      status: missingScripts.length ? 'fail' : 'pass',
      message: missingScripts.length
        ? `Missing required scripts: ${missingScripts.join(', ')}`
        : 'Required Sherlog scripts are wired.',
      fix: missingScripts.length ? 'Rerun `node sherlog-velocity/install.js` to wire scripts.' : null,
      evidence: { missing_scripts: missingScripts },
    });

    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    const agentsText = safeReadText(agentsPath);
    if (agentsText.includes('sherlog:doctor') && (!hostPkg.scripts || !hostPkg.scripts['sherlog:doctor'])) {
      checks.push({
        id: 'agents_script_alignment',
        status: 'fail',
        message: 'AGENTS preflight references sherlog:doctor but script is missing.',
        fix: 'Wire sherlog:doctor script or update AGENTS instructions.',
        evidence: { agents_path: agentsPath },
      });
    } else {
      checks.push({
        id: 'agents_script_alignment',
        status: 'pass',
        message: 'AGENTS preflight is aligned with installed scripts.',
        evidence: { agents_path: agentsPath },
      });
    }
  }

  const sourceRoots = Array.isArray(config?.paths?.source_roots) ? config.paths.source_roots : [];
  if (sourceRoots.length === 0) {
    checks.push({
      id: 'source_roots_present',
      status: 'fail',
      message: 'paths.source_roots is empty; gap detection will produce false missing_implementation.',
      fix: 'Set paths.source_roots to real code roots.',
      evidence: { source_roots: sourceRoots },
    });
  } else {
    const missingRoots = sourceRoots.filter(rel => !fs.existsSync(path.join(repoRoot, rel)));
    checks.push({
      id: 'source_roots_present',
      status: missingRoots.length ? 'warn' : 'pass',
      message: missingRoots.length
        ? `Some source roots do not exist: ${missingRoots.join(', ')}`
        : 'Source roots are configured and present.',
      fix: missingRoots.length ? 'Update paths.source_roots to existing code directories.' : null,
      evidence: { source_roots: sourceRoots, missing_roots: missingRoots },
    });

    if (sourceRoots.includes('.')) {
      checks.push({
        id: 'source_roots_breadth',
        status: 'warn',
        message: 'Source root includes "." which can over-broaden gap matching.',
        fix: 'Prefer explicit roots like src/, app/, or server/ for precision.',
        evidence: { source_roots: sourceRoots },
      });
    }
  }

  const contextMode = config?.context?.mode || 'none';
  if (contextMode !== 'none' && contextMode !== 'sherlog-map') {
    checks.push({
      id: 'context_mode_supported',
      status: 'warn',
      message: `Unsupported context mode "${contextMode}" found in config.`,
      fix: 'Switch context.mode to "sherlog-map" or "none".',
      evidence: { context_mode: contextMode },
    });
  }

  const mapFile = config?.context?.map_file || config?.paths?.context_map || null;
  const mapPath = mapFile
    ? (path.isAbsolute(mapFile) ? mapFile : path.join(repoRoot, mapFile))
    : (contextMode === 'sherlog-map' ? path.join(repoRoot, 'sherlog.context.json') : null);

  if (contextMode === 'sherlog-map') {
    if (!mapPath || !fs.existsSync(mapPath)) {
      checks.push({
        id: 'context_map_available',
        status: 'warn',
        message: 'Sherlog map mode is enabled but sherlog.context.json is missing.',
        fix: 'Run `npm run sherlog:init-context -- --force`.',
        evidence: { map_path: mapPath },
      });
    } else {
      const map = readJson(mapPath, null);
      const zones = Array.isArray(map?.zones) ? map.zones : [];
      checks.push({
        id: 'context_map_available',
        status: zones.length > 0 ? 'pass' : 'warn',
        message: zones.length > 0
          ? 'Context map is present with zones.'
          : 'Context map exists but has no zones.',
        fix: zones.length > 0 ? null : 'Populate sherlog.context.json zones.',
        evidence: { map_path: mapPath, zones: zones.length },
      });
    }
  }

  const ignored = Array.isArray(config?.settings?.gap_scan_ignore_dirs)
    ? config.settings.gap_scan_ignore_dirs.map(normalizePath).filter(Boolean)
    : [];
  const archiveDirs = discoverArchiveLikeDirs(repoRoot);
  if (archiveDirs.length > 0) {
    const uncovered = archiveDirs.filter((dir) => {
      if (ignored.includes(dir)) return false;
      const base = path.basename(dir).toLowerCase();
      return !DEFAULT_GAP_SCAN_IGNORES.has(base);
    });
    checks.push({
      id: 'archive_scan_scope',
      status: uncovered.length ? 'warn' : 'pass',
      message: uncovered.length
        ? 'Archive-like directories found but not ignored for gap scanning.'
        : 'Archive-like directories are accounted for in gap scan ignores.',
      fix: uncovered.length
        ? 'Add these dirs to settings.gap_scan_ignore_dirs to reduce false context_drift.'
        : null,
      evidence: { archive_dirs: archiveDirs, ignored_dirs: ignored, uncovered_dirs: uncovered },
    });
  }

  checks.push(checkVelocityPanelMount(repoRoot));
  return checks;
}

function summarize(checks) {
  return {
    pass: checks.filter(item => item.status === 'pass').length,
    warn: checks.filter(item => item.status === 'warn').length,
    fail: checks.filter(item => item.status === 'fail').length,
  };
}

function printHuman(checks, counts) {
  console.log('SHERLOG VERIFY');
  checks.forEach(check => {
    const tag = check.status.toUpperCase().padEnd(4, ' ');
    console.log(`[${tag}] ${check.id}: ${check.message}`);
    if (check.fix) console.log(`       fix: ${check.fix}`);
  });
  console.log('');
  console.log(`Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);
}

function main() {
  const args = parseArgs(process.argv);
  const context = loadConfig();
  const checks = checkOperationalWiring(context);
  const counts = summarize(checks);
  const output = {
    version: 1,
    timestamp: new Date().toISOString(),
    repo_root: context.repoRoot,
    summary: counts,
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHuman(checks, counts);
  }

  if (args.strict && (counts.fail > 0 || counts.warn > 0)) {
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  checkOperationalWiring,
};
