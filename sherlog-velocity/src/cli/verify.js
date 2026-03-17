#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { readJson, resolveRuntimeConfig } = require('../core/shared');
const { analyzeRepomixBundles } = require('../core/repomix');

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
const REPOMIX_XML_RE = /^repomix-(.+)\.xml$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function parseArgs(argv) {
  const out = {
    json: false,
    strict: false,
  };

  for (let i = 2; i < argv.length; i++) {
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
      if (seen++ > maxFiles) return;
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
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (ARCHIVE_HINT_DIRS.has(seg.toLowerCase())) {
        found.push(segments.slice(0, i + 1).join('/'));
        break;
      }
    }
  }, 60000);
  return Array.from(new Set(found));
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const rawConfig = readJson(configPath, null);
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

function normalizeBundleId(value) {
  const id = String(value || '').trim();
  if (!id) return null;
  return id.toLowerCase();
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function resolveRepoPath(repoRoot, candidatePath) {
  if (!candidatePath) return null;
  return path.isAbsolute(candidatePath) ? candidatePath : path.join(repoRoot, candidatePath);
}

function collectBundleIdsFromBundleIndex(repoRoot) {
  const indexPath = path.join(repoRoot, '.repomix', 'bundles.json');
  const exists = fs.existsSync(indexPath);
  if (!exists) {
    return {
      path: indexPath,
      exists,
      valid: false,
      ids: [],
      invalid_reason: 'missing_file',
    };
  }

  const payload = readJson(indexPath, null);
  const bundles = payload && typeof payload === 'object' && payload.bundles && typeof payload.bundles === 'object'
    ? payload.bundles
    : null;
  if (!bundles) {
    return {
      path: indexPath,
      exists,
      valid: false,
      ids: [],
      invalid_reason: 'missing_bundles_object',
    };
  }

  const ids = Object.keys(bundles)
    .map(id => normalizeBundleId(id))
    .filter(Boolean);

  return {
    path: indexPath,
    exists,
    valid: true,
    ids: uniqueSorted(ids),
    invalid_reason: null,
  };
}

function resolveRepomixManifestPath(repoRoot, config) {
  const configuredPath = config?.paths?.repomix_manifest || config?.context?.map_file || config?.paths?.context_map || null;
  const candidates = [
    { source: configuredPath ? 'config' : 'root_default', path: resolveRepoPath(repoRoot, configuredPath) || path.join(repoRoot, 'repomix-manifest.json') },
    { source: 'root_default', path: path.join(repoRoot, 'repomix-manifest.json') },
    { source: 'vessel_legacy', path: path.join(repoRoot, 'vessel', 'repomix-manifest.json') },
  ];

  const dedupedCandidates = [];
  const seen = new Set();
  candidates.forEach(candidate => {
    const normalized = normalizePath(candidate.path);
    if (!candidate.path || seen.has(normalized)) return;
    seen.add(normalized);
    dedupedCandidates.push(candidate);
  });

  const expected = dedupedCandidates[0];
  const selected = dedupedCandidates.find(candidate => fs.existsSync(candidate.path)) || expected;

  return {
    expected_path: expected.path,
    expected_source: expected.source,
    selected_path: selected.path,
    selected_source: selected.source,
    used_fallback: normalizePath(selected.path) !== normalizePath(expected.path),
    candidates: dedupedCandidates.map(candidate => ({
      source: candidate.source,
      path: candidate.path,
      exists: fs.existsSync(candidate.path),
    })),
  };
}

function collectBundleIdsFromManifest(manifestPath) {
  const exists = fs.existsSync(manifestPath);
  if (!exists) {
    return {
      path: manifestPath,
      exists,
      valid: false,
      ids: [],
      missing_id_entries: [],
      last_updated_by_id: {},
      invalid_reason: 'missing_file',
    };
  }

  const payload = readJson(manifestPath, null);
  const bundles = Array.isArray(payload?.bundles) ? payload.bundles : null;
  if (!bundles) {
    return {
      path: manifestPath,
      exists,
      valid: false,
      ids: [],
      missing_id_entries: [],
      last_updated_by_id: {},
      invalid_reason: 'missing_bundles_array',
    };
  }

  const ids = [];
  const missingIdEntries = [];
  const lastUpdatedById = {};

  bundles.forEach((bundle, index) => {
    const rawId = bundle?.id ?? bundle?.bundle_id ?? bundle?.bundleId ?? null;
    const normalizedId = normalizeBundleId(rawId);
    if (!normalizedId) {
      missingIdEntries.push({
        index,
        name: bundle?.name || null,
      });
      return;
    }

    ids.push(normalizedId);
    if (!(normalizedId in lastUpdatedById)) {
      lastUpdatedById[normalizedId] = bundle?.last_updated ?? null;
    }
  });

  return {
    path: manifestPath,
    exists,
    valid: true,
    ids: uniqueSorted(ids),
    missing_id_entries: missingIdEntries,
    last_updated_by_id: lastUpdatedById,
    invalid_reason: null,
  };
}

function scanRepomixXmlArtifacts(repoRoot) {
  const ids = [];
  const filesById = {};

  walkFiles(repoRoot, fullPath => {
    const baseName = path.basename(fullPath);
    const match = baseName.match(REPOMIX_XML_RE);
    if (!match) return;

    const normalizedId = normalizeBundleId(match[1]);
    if (!normalizedId) return;

    let stats = null;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      stats = null;
    }

    const relPath = normalizePath(path.relative(repoRoot, fullPath));
    ids.push(normalizedId);
    if (!filesById[normalizedId]) filesById[normalizedId] = [];
    filesById[normalizedId].push({
      path: relPath,
      mtime_ms: Number.isFinite(stats?.mtimeMs) ? stats.mtimeMs : null,
      mtime: Number.isFinite(stats?.mtimeMs) ? new Date(stats.mtimeMs).toISOString() : null,
    });
  }, 140000);

  return {
    ids: uniqueSorted(ids),
    files_by_id: filesById,
  };
}

function parseLastUpdated(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return {
      raw: null,
      epoch_ms: null,
      granularity: null,
      valid: false,
    };
  }

  const normalized = DATE_ONLY_RE.test(raw) ? `${raw}T00:00:00Z` : raw;
  const epochMs = new Date(normalized).getTime();
  return {
    raw,
    epoch_ms: Number.isFinite(epochMs) ? epochMs : null,
    granularity: DATE_ONLY_RE.test(raw) ? 'date' : 'datetime',
    valid: Number.isFinite(epochMs),
  };
}

function isMtimeAligned(xmlMtimeMs, lastUpdated) {
  if (!Number.isFinite(xmlMtimeMs) || !lastUpdated?.valid || !Number.isFinite(lastUpdated?.epoch_ms)) return false;

  if (lastUpdated.granularity === 'date') {
    const xmlDay = new Date(xmlMtimeMs).toISOString().slice(0, 10);
    const updatedDay = new Date(lastUpdated.epoch_ms).toISOString().slice(0, 10);
    return xmlDay === updatedDay;
  }

  return Math.abs(xmlMtimeMs - lastUpdated.epoch_ms) <= 1000;
}

function checkRepomixBundleConsistency({ repoRoot, config, contextMode }) {
  const analysis = analyzeRepomixBundles({ repoRoot, config, contextMode });
  if (!analysis) return null;

  const bundleIndex = analysis.bundle_index;
  const manifestPath = analysis.manifest_resolution;
  const manifest = analysis.manifest;
  const xmlArtifacts = analysis.xml_artifacts;
  const missingInManifest = analysis.mismatches.missing_in_manifest;
  const missingInBundleIndex = analysis.mismatches.missing_in_bundle_index;
  const missingXmlForManifest = analysis.mismatches.missing_xml_for_manifest;
  const orphanXmlArtifacts = analysis.mismatches.orphan_xml_artifacts;
  const mtimeMismatches = analysis.mismatches.mtime_mismatches;
  const sourceFreshnessMismatches = analysis.mismatches.source_freshness_mismatches;

  const issues = [];
  if (!bundleIndex.exists) issues.push('.repomix/bundles.json is missing');
  else if (!bundleIndex.valid) issues.push('.repomix/bundles.json is invalid');

  const expectedManifestRel = normalizePath(path.relative(repoRoot, manifestPath.expected_path));
  const selectedManifestRel = normalizePath(path.relative(repoRoot, manifest.path));
  if (!manifest.exists) issues.push(`manifest file missing at ${expectedManifestRel}`);
  else if (manifestPath.expected_source === 'config' && manifestPath.used_fallback) {
    issues.push(`configured manifest missing at ${expectedManifestRel}; using fallback ${selectedManifestRel}`);
  }
  else if (!manifest.valid) issues.push('manifest is invalid or missing bundles[]');

  if (manifest.valid && manifest.missing_id_entries.length > 0) {
    issues.push('manifest bundles are missing required id fields');
  }

  if (missingInManifest.length > 0) issues.push(`bundle IDs missing in manifest: ${missingInManifest.join(', ')}`);
  if (missingInBundleIndex.length > 0) issues.push(`manifest IDs missing in .repomix index: ${missingInBundleIndex.join(', ')}`);
  if (missingXmlForManifest.length > 0) issues.push(`manifest IDs missing XML artifacts: ${missingXmlForManifest.join(', ')}`);
  if (orphanXmlArtifacts.length > 0) issues.push(`orphan XML artifacts not declared in manifest: ${orphanXmlArtifacts.join(', ')}`);
  if (mtimeMismatches.length > 0) issues.push(`manifest/XML timestamp mismatches: ${mtimeMismatches.length}`);
  if (sourceFreshnessMismatches.length > 0) issues.push(`XML freshness mismatches vs source: ${sourceFreshnessMismatches.length}`);

  const checkStatus = issues.length > 0 ? 'fail' : 'pass';

  return {
    id: 'repomix_bundle_consistency',
    status: checkStatus,
    message: checkStatus === 'pass'
      ? 'Repomix bundle IDs, manifest timestamps, and XML freshness are consistent across bundle index, source, manifest, and artifacts.'
      : `Repomix consistency issues detected (${issues.length}).`,
    fix: checkStatus === 'fail'
      ? `Synchronize .repomix/bundles.json with ${selectedManifestRel} IDs, regenerate repomix-*.xml artifacts so each XML mtime is at least as new as its latest source commit, then run \`task repomix-sync -- --write\` to stamp manifest last_updated from the XML artifacts.`
      : null,
    evidence: {
      bundle_index: {
        path: normalizePath(path.relative(repoRoot, bundleIndex.path)),
        exists: bundleIndex.exists,
        valid: bundleIndex.valid,
        ids: bundleIndex.ids,
      },
      manifest: {
        expected_path: expectedManifestRel,
        expected_source: manifestPath.expected_source,
        selected_path: selectedManifestRel,
        selected_source: manifestPath.selected_source,
        used_fallback: manifestPath.used_fallback,
        candidates: manifestPath.candidates.map(candidate => ({
          source: candidate.source,
          path: normalizePath(path.relative(repoRoot, candidate.path)),
          exists: candidate.exists,
        })),
        exists: manifest.exists,
        valid: manifest.valid,
        ids: manifest.ids,
        missing_id_entries: manifest.missing_id_entries,
      },
      xml_artifacts: {
        ids: xmlArtifacts.ids,
        files_by_id: xmlArtifacts.files_by_id,
      },
      mismatches: {
        missing_in_manifest: missingInManifest,
        missing_in_bundle_index: missingInBundleIndex,
        missing_xml_for_manifest: missingXmlForManifest,
        orphan_xml_artifacts: orphanXmlArtifacts,
        mtime_mismatches: mtimeMismatches,
        source_freshness_mismatches: sourceFreshnessMismatches,
      },
      bundle_freshness: analysis.bundle_evaluations,
      issues,
    },
  };
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

    const requiredScripts = ['sherlog:verify', 'sherlog:doctor', 'sherlog:gaps', 'sherlog:bounds', 'sherlog:prompt', 'velocity:estimate'];
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
      fix: 'Set paths.source_roots to real code roots (for example: ["vessel/src"]).',
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
        fix: 'Prefer explicit roots like src/, app/, or vessel/src for precision.',
        evidence: { source_roots: sourceRoots },
      });
    }
  }

  const contextMode = config?.context?.mode || 'none';
  const mapFile = config?.context?.map_file || config?.paths?.context_map || null;
  const mapPath = mapFile
    ? (path.isAbsolute(mapFile) ? mapFile : path.join(repoRoot, mapFile))
    : (contextMode === 'sherlog-map' ? path.join(repoRoot, 'sherlog.context.json') : null);

  if (contextMode === 'repomix-compat') {
    const manifestPath = mapPath || path.join(repoRoot, 'repomix-manifest.json');
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      checks.push({
        id: 'repomix_manifest_available',
        status: 'warn',
        message: 'Context mode is repomix-compat but repomix manifest is missing.',
        fix: 'Provide repomix-manifest.json or switch to sherlog-map mode.',
        evidence: { context_mode: contextMode, manifest_path: manifestPath },
      });
    } else {
      const manifest = readJson(manifestPath, null);
      checks.push({
        id: 'repomix_manifest_available',
        status: manifest ? 'pass' : 'warn',
        message: manifest ? 'Repomix manifest found and parseable.' : 'Repomix manifest exists but could not be parsed.',
        fix: manifest ? null : 'Fix JSON formatting in repomix manifest.',
        evidence: { manifest_path: manifestPath },
      });
    }
  }

  const repomixConsistencyCheck = checkRepomixBundleConsistency({
    repoRoot,
    config,
    contextMode,
  });
  if (repomixConsistencyCheck) checks.push(repomixConsistencyCheck);

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
    const uncovered = archiveDirs.filter(dir => !ignored.includes(dir));
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
  const counts = {
    pass: checks.filter(item => item.status === 'pass').length,
    warn: checks.filter(item => item.status === 'warn').length,
    fail: checks.filter(item => item.status === 'fail').length,
  };
  return counts;
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
  checkRepomixBundleConsistency,
};
