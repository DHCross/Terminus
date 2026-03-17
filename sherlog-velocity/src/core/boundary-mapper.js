const fs = require('fs');
const path = require('path');
const {
  readJson,
  repoRelativePathVariants,
  resolveConfigPath,
  resolveRepoRoot,
  resolveRuntimeConfig,
} = require('./shared');

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function normalizeTargetFile(repoRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (path.isAbsolute(raw)) {
    const relative = normalizePath(path.relative(repoRoot, raw));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative;
    }
  }

  return normalizePath(raw);
}

function dedupePreserveOrder(values = []) {
  const out = [];
  const seen = new Set();
  values.forEach(value => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

function resolveContextMapPath(repoRoot, config) {
  const candidates = [
    config?.context?.map_file,
    config?.paths?.context_map,
    path.join(repoRoot, 'sherlog.context.json'),
  ];

  for (const candidate of candidates) {
    const resolved = typeof candidate === 'string'
      ? (path.isAbsolute(candidate) ? candidate : resolveConfigPath(repoRoot, candidate))
      : candidate;
    if (!resolved) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Ignore broken candidates and continue to the next default.
    }
  }

  return path.join(repoRoot, 'sherlog.context.json');
}

function matchGlobSegments(fileSegments, globSegments, fi = 0, gi = 0) {
  if (gi >= globSegments.length) return fi >= fileSegments.length;

  const globSegment = globSegments[gi];

  if (globSegment === '**') {
    if (gi === globSegments.length - 1) return true;
    for (let index = fi; index <= fileSegments.length; index++) {
      if (matchGlobSegments(fileSegments, globSegments, index, gi + 1)) return true;
    }
    return false;
  }

  if (fi >= fileSegments.length) return false;
  if (!segmentMatches(fileSegments[fi], globSegment)) return false;
  return matchGlobSegments(fileSegments, globSegments, fi + 1, gi + 1);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function segmentMatches(fileSegment, globSegment) {
  if (globSegment === '*') return true;
  if (!globSegment.includes('*')) return fileSegment === globSegment;
  const pattern = `^${escapeRegExp(globSegment).replace(/\\\*/g, '[^/]*')}$`;
  return new RegExp(pattern).test(fileSegment);
}

function pathMatchesGlob(relPath, pattern) {
  const file = normalizePath(relPath).toLowerCase();
  const glob = normalizePath(pattern).toLowerCase();
  if (!file || !glob) return false;

  const fileSegments = file.split('/').filter(Boolean);
  const globSegments = glob.split('/').filter(Boolean);
  if (fileSegments.length === 0 || globSegments.length === 0) return false;
  return matchGlobSegments(fileSegments, globSegments);
}

function pathMatchesPattern(relPath, pattern) {
  const pathVariants = repoRelativePathVariants(normalizePath(relPath))
    .map(item => normalizePath(item).toLowerCase())
    .filter(Boolean);
  const patternVariants = repoRelativePathVariants(normalizePath(pattern))
    .map(item => normalizePath(item).toLowerCase())
    .filter(Boolean);

  return patternVariants.some(candidatePattern => (
    pathVariants.some(candidatePath => pathMatchesGlob(candidatePath, candidatePattern))
  ));
}

function normalizeZones(contextMap) {
  const zones = Array.isArray(contextMap?.zones) ? contextMap.zones : [];
  return zones.map((zone, index) => ({
    index,
    name: String(zone?.name || `zone_${index + 1}`).trim() || `zone_${index + 1}`,
    belief: String(zone?.belief || '').trim() || null,
    touch_policy: String(zone?.touch_policy || '').trim().toLowerCase() || null,
    risk_level: String(zone?.risk_level || '').trim().toLowerCase() || null,
    paths: (Array.isArray(zone?.paths) ? zone.paths : [])
      .map(pattern => normalizePath(pattern))
      .filter(Boolean),
  }));
}

function bestZoneMatch(relPath, zones = []) {
  let selected = null;

  zones.forEach(zone => {
    zone.paths.forEach(pattern => {
      if (!pathMatchesPattern(relPath, pattern)) return;
      const specificity = normalizePath(pattern).length;
      if (!selected || specificity > selected.specificity) {
        selected = { zone, pattern, specificity };
      }
    });
  });

  return selected;
}

function buildDefaultBounds(featureTarget) {
  return {
    feature_target: featureTarget,
    confidence_score: 80,
    topology: {
      recommended_entrypoints: [],
      safe_touch: [],
      risky_touch: [],
      do_not_touch: [],
      reference_only: [],
    },
    obligations: {
      contracts_relevant: [],
      verifications_required: [],
      evidence_required: [],
    },
    strategy: {
      repair_strategy: [
        'Start at the recommended entrypoint before widening scope.',
        'Prefer safe_touch files before risky_touch files.',
        'Do not widen into unmapped territory without evidence.',
      ],
    },
  };
}

function generateStaticBounds(featureTarget, targetFiles, configInput = null) {
  const config = resolveRuntimeConfig(configInput || {}, { cwd: process.cwd() });
  const repoRoot = resolveRepoRoot(config?.repo_root, process.cwd());
  const feature = String(featureTarget || 'Current Task').trim() || 'Current Task';
  const normalizedFiles = dedupePreserveOrder((Array.isArray(targetFiles) ? targetFiles : [])
    .map(file => normalizeTargetFile(repoRoot, file))
    .filter(Boolean));

  const bounds = buildDefaultBounds(feature);
  const contextMapPath = resolveContextMapPath(repoRoot, config);
  const contextMap = readJson(contextMapPath, null);
  const zones = normalizeZones(contextMap);

  const contractKeys = new Set();
  const verificationKeys = new Set();

  normalizedFiles.forEach((file) => {
    const match = bestZoneMatch(file, zones);
    const zone = match?.zone || null;
    const touchPolicy = zone?.touch_policy || null;

    if (!match) {
      bounds.topology.risky_touch.push({
        file,
        blast_radius: 'medium',
        constraints: 'Unmapped territory: validate ownership and tests before editing.',
      });
      bounds.obligations.evidence_required.push(`Context confirmation for unmapped file: ${file}`);
      return;
    }

    if (zone.belief) {
      const contractKey = zone.belief.toLowerCase();
      if (!contractKeys.has(contractKey)) {
        contractKeys.add(contractKey);
        bounds.obligations.contracts_relevant.push({
          description: zone.belief,
          strictness: 'absolute',
        });
      }

      const verificationKey = zone.name.toLowerCase();
      if (!verificationKeys.has(verificationKey)) {
        verificationKeys.add(verificationKey);
        bounds.obligations.verifications_required.push({
          type: 'context_check',
          description: `Validate edits against zone belief: ${zone.name}`,
          mandatory: true,
        });
      }
    }

    if (touchPolicy === 'do_not_touch') {
      bounds.topology.do_not_touch.push({
        file,
        reason: zone.belief || 'Context-marked do-not-touch zone',
      });
      return;
    }

    if (touchPolicy === 'reference_only') {
      bounds.topology.reference_only.push({
        file,
        context_value: zone.belief || zone.name,
      });
      return;
    }

    if (touchPolicy === 'risky_touch') {
      bounds.topology.risky_touch.push({
        file,
        blast_radius: zone.risk_level || 'medium',
        constraints: zone.belief || 'Context-marked risky zone: validate ownership and tests before editing.',
      });
      return;
    }

    bounds.topology.safe_touch.push({
      file,
      confidence: 90,
      reason: `Matched context zone: ${zone.name}`,
    });
  });

  if (bounds.topology.risky_touch.length > 0) {
    bounds.obligations.verifications_required.push({
      type: 'ownership_check',
      description: 'Confirm ownership for unmapped files before editing',
      mandatory: true,
    });
  }

  if (normalizedFiles.length > 0) {
    const firstFile = normalizedFiles[0];
    const firstMatch = bestZoneMatch(firstFile, zones);
    bounds.topology.recommended_entrypoints.push({
      file: firstFile,
      priority: 1,
      reason: firstMatch?.zone
        ? `Matched context zone: ${firstMatch.zone.name}`
        : 'first requested target file',
    });
  }

  return bounds;
}

module.exports = {
  generateStaticBounds,
};
