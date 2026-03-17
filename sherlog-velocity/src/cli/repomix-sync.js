#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readJson, resolveRuntimeConfig } = require('../core/shared');
const {
  analyzeRepomixBundles,
  resolveRepomixManifestPath,
} = require('../core/repomix');

function parseArgs(argv) {
  const out = {
    manifest: null,
    write: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manifest' && argv[i + 1]) out.manifest = argv[++i];
    else if (arg === '--write') out.write = true;
    else if (arg === '--dry-run') out.write = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/repomix-sync.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --manifest <path>      repomix manifest path (default: config path or ./repomix-manifest.json)');
  console.log('  --write                persist manifest last_updated from XML artifact mtimes');
  console.log('  --dry-run              do not write changes (default)');
  console.log('  --json                 emit machine-readable JSON');
  console.log('  --help, -h             show this message');
}

function detectRepoRoot(startDir, fallback) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  return resolveRuntimeConfig(readJson(configPath, null) || null);
}

function resolveManifestPath(args, config, repoRoot) {
  if (args.manifest) {
    return path.isAbsolute(args.manifest) ? args.manifest : path.join(process.cwd(), args.manifest);
  }

  return resolveRepomixManifestPath(repoRoot, config).selected_path;
}

function summarizeManifest(manifestPath, analysis) {
  const updates = analysis.bundle_evaluations.map(item => {
    const reasons = [];
    if (item.missing_xml) reasons.push('missing_xml');
    if (item.source_freshness_mismatches.length > 0) reasons.push('xml_stale_vs_source');

    return {
      index: item.index,
      id: item.id,
      bundle: item.name,
      last_updated: item.manifest_last_updated,
      last_updated_granularity: item.manifest_last_updated_granularity || null,
      latest_source_commit: item.latest_source_commit,
      freshest_xml_path: item.freshest_xml_path,
      freshest_xml_mtime: item.freshest_xml_mtime,
      stale: item.stale,
      missing_xml: item.missing_xml,
      next_last_updated: item.next_last_updated,
      changed: Boolean(!item.stale && item.changed && item.next_last_updated),
      reasons,
      source_freshness_mismatches: item.source_freshness_mismatches,
      manifest_alignment_mismatches: item.manifest_alignment_mismatches,
    };
  });

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    manifest_path: manifestPath,
    bundles: updates.length,
    stale_bundles: updates.filter(item => item.stale).length,
    changed_bundles: updates.filter(item => item.changed).length,
    updates,
    mismatches: analysis.mismatches,
    written: false,
  };
}

function printHuman(summary, writeMode) {
  console.log(`Repomix manifest: ${summary.manifest_path}`);
  console.log(`Bundles: ${summary.bundles}`);
  console.log(`Stale bundles: ${summary.stale_bundles}`);
  console.log(`Bundles with new last_updated values: ${summary.changed_bundles}`);
  console.log(`Write mode: ${writeMode ? 'enabled' : 'dry-run'}`);

  if (summary.updates.length > 0) {
    console.log('');
    summary.updates.forEach(item => {
      const status = item.stale ? 'stale' : (item.changed ? 'update' : 'keep');
      const detail = item.reasons.length > 0 ? ` (${item.reasons.join(', ')})` : '';
      console.log(`- ${item.bundle}: ${status}${detail}`);
    });
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const configuredRoot = config?.repo_root || process.cwd();
  const manifestPath = resolveManifestPath(args, config, configuredRoot);
  const repoRoot = args.manifest
    ? detectRepoRoot(path.dirname(manifestPath), path.dirname(manifestPath))
    : detectRepoRoot(configuredRoot, configuredRoot);
  const manifest = readJson(manifestPath, null);

  if (!manifest || !Array.isArray(manifest.bundles)) {
    console.error(`Invalid or missing repomix manifest: ${manifestPath}`);
    process.exit(1);
  }

  const analysisConfig = args.manifest
    ? {
      ...(config || {}),
      paths: {
        ...(config?.paths || {}),
        repomix_manifest: manifestPath,
      },
    }
    : (config || {});

  const analysis = analyzeRepomixBundles({
    repoRoot,
    config: analysisConfig,
    contextMode: analysisConfig?.context?.mode || 'none',
  });

  if (!analysis || !analysis.manifest.valid) {
    console.error(`Invalid or missing repomix manifest: ${manifestPath}`);
    process.exit(1);
  }

  const summary = summarizeManifest(manifestPath, analysis);
  const nextManifest = JSON.parse(JSON.stringify(manifest));

  if (args.write && summary.changed_bundles > 0) {
    summary.updates.forEach(item => {
      if (!item.changed) return;
      nextManifest.bundles[item.index].last_updated = item.next_last_updated;
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
    summary.written = true;
  }

  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else printHuman(summary, args.write);

  if (summary.stale_bundles > 0) process.exit(1);
}

if (require.main === module) main();
