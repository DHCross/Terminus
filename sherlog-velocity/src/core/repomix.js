'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readJson } = require('./shared');

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

const REPOMIX_XML_RE = /^repomix-(.+)\.xml$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
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

function walkFiles(root, visit, maxFiles = 140000) {
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

function collectManifestBundles(manifestPath) {
  const exists = fs.existsSync(manifestPath);
  if (!exists) {
    return {
      path: manifestPath,
      exists,
      valid: false,
      ids: [],
      entries: [],
      bundles_by_id: {},
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
      entries: [],
      bundles_by_id: {},
      missing_id_entries: [],
      last_updated_by_id: {},
      invalid_reason: 'missing_bundles_array',
    };
  }

  const ids = [];
  const missingIdEntries = [];
  const bundlesById = {};
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
    if (normalizedId in bundlesById) return;

    const entry = {
      index,
      id: normalizedId,
      name: bundle?.name || null,
      paths: Array.isArray(bundle?.paths)
        ? bundle.paths.map(normalizePath).filter(Boolean)
        : [],
      last_updated: bundle?.last_updated ?? null,
    };
    bundlesById[normalizedId] = entry;
    lastUpdatedById[normalizedId] = entry.last_updated;
  });

  return {
    path: manifestPath,
    exists,
    valid: true,
    ids: uniqueSorted(ids),
    entries: bundles,
    bundles_by_id: bundlesById,
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
  });

  Object.values(filesById).forEach(files => {
    files.sort((a, b) => a.path.localeCompare(b.path));
  });

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

function formatLastUpdated(epochMs, granularity = 'datetime') {
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return null;
  if (granularity === 'date') return date.toISOString().slice(0, 10);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function latestCommitEpochMsForPaths(repoRoot, relPaths) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) return null;
  const sample = relPaths
    .map(item => normalizePath(item))
    .filter(Boolean)
    .slice(0, 200);
  if (!sample.length) return null;

  const cmd = `git log -1 --format=%ct -- ${sample.map(shellQuote).join(' ')}`;
  try {
    const out = execSync(cmd, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed * 1000 : null;
  } catch {
    return null;
  }
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

function isXmlFresh(xmlMtimeMs, latestSourceCommitMs, granularity = 'datetime') {
  if (!Number.isFinite(xmlMtimeMs) || !Number.isFinite(latestSourceCommitMs)) return false;

  if (granularity === 'date') {
    const xmlDay = new Date(xmlMtimeMs).toISOString().slice(0, 10);
    const sourceDay = new Date(latestSourceCommitMs).toISOString().slice(0, 10);
    return xmlDay >= sourceDay;
  }

  return xmlMtimeMs + 1000 >= latestSourceCommitMs;
}

function isoFromMs(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function newestXmlFile(files) {
  return (Array.isArray(files) ? files : []).reduce((latest, file) => {
    if (!latest) return file;
    if (!Number.isFinite(file?.mtime_ms)) return latest;
    if (!Number.isFinite(latest?.mtime_ms) || file.mtime_ms > latest.mtime_ms) return file;
    return latest;
  }, null);
}

function analyzeRepomixBundles({ repoRoot, config, contextMode }) {
  const bundlesPath = path.join(repoRoot, '.repomix', 'bundles.json');
  const manifestPath = resolveRepomixManifestPath(repoRoot, config);
  const repomixSignals = [
    fs.existsSync(bundlesPath),
    manifestPath.candidates.some(candidate => candidate.exists),
    contextMode === 'repomix-compat',
  ];
  if (!repomixSignals.some(Boolean)) return null;

  const bundleIndex = collectBundleIdsFromBundleIndex(repoRoot);
  const manifest = collectManifestBundles(manifestPath.selected_path);
  const xmlArtifacts = scanRepomixXmlArtifacts(repoRoot);

  const bundleIdSet = new Set(bundleIndex.ids);
  const manifestIdSet = new Set(manifest.ids);
  const xmlIdSet = new Set(xmlArtifacts.ids);

  const missingInManifest = bundleIndex.ids.filter(id => !manifestIdSet.has(id));
  const missingInBundleIndex = manifest.ids.filter(id => !bundleIdSet.has(id));
  const missingXmlForManifest = manifest.ids.filter(id => !xmlIdSet.has(id));
  const orphanXmlArtifacts = xmlArtifacts.ids.filter(id => !manifestIdSet.has(id));

  const manifestAlignmentMismatches = [];
  const sourceFreshnessMismatches = [];
  const bundleEvaluations = manifest.ids.map(id => {
    const bundle = manifest.bundles_by_id[id] || {
      index: -1,
      id,
      name: id,
      paths: [],
      last_updated: null,
    };
    const xmlFiles = Array.isArray(xmlArtifacts.files_by_id[id]) ? xmlArtifacts.files_by_id[id] : [];
    const newestXml = newestXmlFile(xmlFiles);
    const parsedLastUpdated = parseLastUpdated(bundle.last_updated);
    const latestSourceCommitMs = latestCommitEpochMsForPaths(repoRoot, bundle.paths);
    const nextGranularity = parsedLastUpdated.granularity || 'datetime';

    const manifestMismatchesForBundle = [];
    xmlFiles.forEach(file => {
      if (!parsedLastUpdated.valid) {
        manifestMismatchesForBundle.push({
          id,
          xml_path: file.path,
          xml_mtime: file.mtime,
          manifest_last_updated: parsedLastUpdated.raw,
          reason: 'manifest_last_updated_invalid_or_missing',
        });
        return;
      }

      if (!isMtimeAligned(file.mtime_ms, parsedLastUpdated)) {
        manifestMismatchesForBundle.push({
          id,
          xml_path: file.path,
          xml_mtime: file.mtime,
          manifest_last_updated: parsedLastUpdated.raw,
          reason: 'mtime_mismatch',
        });
      }
    });

    const sourceMismatchesForBundle = [];
    xmlFiles.forEach(file => {
      if (!Number.isFinite(latestSourceCommitMs)) return;
      if (isXmlFresh(file.mtime_ms, latestSourceCommitMs, nextGranularity)) return;
      sourceMismatchesForBundle.push({
        id,
        xml_path: file.path,
        xml_mtime: file.mtime,
        latest_source_commit: isoFromMs(latestSourceCommitMs),
        reason: 'xml_stale_vs_source',
      });
    });

    manifestAlignmentMismatches.push(...manifestMismatchesForBundle);
    sourceFreshnessMismatches.push(...sourceMismatchesForBundle);

    return {
      id,
      index: bundle.index,
      name: bundle.name || id,
      paths: bundle.paths,
      manifest_last_updated: parsedLastUpdated.raw,
      manifest_last_updated_granularity: parsedLastUpdated.granularity,
      latest_source_commit_ms: latestSourceCommitMs,
      latest_source_commit: isoFromMs(latestSourceCommitMs),
      xml_files: xmlFiles,
      freshest_xml_path: newestXml?.path || null,
      freshest_xml_mtime_ms: Number.isFinite(newestXml?.mtime_ms) ? newestXml.mtime_ms : null,
      freshest_xml_mtime: newestXml?.mtime || null,
      next_last_updated: newestXml ? formatLastUpdated(newestXml.mtime_ms, nextGranularity) : null,
      changed: Boolean(newestXml && formatLastUpdated(newestXml.mtime_ms, nextGranularity) !== parsedLastUpdated.raw),
      missing_xml: xmlFiles.length === 0,
      stale: xmlFiles.length === 0 || sourceMismatchesForBundle.length > 0,
      manifest_alignment_mismatches: manifestMismatchesForBundle,
      source_freshness_mismatches: sourceMismatchesForBundle,
    };
  });

  return {
    bundle_index: bundleIndex,
    manifest_resolution: manifestPath,
    manifest,
    xml_artifacts: xmlArtifacts,
    bundle_evaluations: bundleEvaluations,
    mismatches: {
      missing_in_manifest: missingInManifest,
      missing_in_bundle_index: missingInBundleIndex,
      missing_xml_for_manifest: missingXmlForManifest,
      orphan_xml_artifacts: orphanXmlArtifacts,
      mtime_mismatches: manifestAlignmentMismatches,
      source_freshness_mismatches: sourceFreshnessMismatches,
    },
  };
}

module.exports = {
  analyzeRepomixBundles,
  collectBundleIdsFromBundleIndex,
  collectManifestBundles,
  formatLastUpdated,
  latestCommitEpochMsForPaths,
  normalizePath,
  parseLastUpdated,
  resolveRepomixManifestPath,
};
