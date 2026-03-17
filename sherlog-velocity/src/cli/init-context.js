#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const {
  detectDocsDir,
  detectRepoRoot,
  detectSourceRoots,
  detectTestRoots,
  ensureContextMap,
  normalizePath,
} = require('../../install');
const { readJson, toPortableConfig } = require('../core/shared');

function parseArgs(argv) {
  const out = {
    force: false,
    json: false,
    sourceRoots: [],
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--source-root' && argv[i + 1]) out.sourceRoots.push(argv[++i]);
  }

  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:init-context -- [options]');
  console.log('');
  console.log('Options:');
  console.log('  --force                overwrite an existing sherlog.context.json');
  console.log('  --source-root <path>   include a custom source root (repeatable)');
  console.log('  --json                 output a machine-readable summary');
  console.log('  --help, -h             show this message');
}

function normalizeSourceRoot(repoRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const relative = path.relative(repoRoot, absolute);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  const normalized = normalizePath(relative);
  return normalized || '.';
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = detectRepoRoot();
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  const docsDir = config?.paths?.docs_dir || detectDocsDir(repoRoot);

  const explicitSourceRoots = args.sourceRoots
    .map(value => normalizeSourceRoot(repoRoot, value))
    .filter(Boolean);

  const detectedSourceRoots = detectSourceRoots(repoRoot);
  const sourceRoots = explicitSourceRoots.length > 0
    ? explicitSourceRoots
    : detectedSourceRoots.length > 0
      ? detectedSourceRoots
      : Array.isArray(config?.paths?.source_roots) && config.paths.source_roots.length > 0
        ? config.paths.source_roots
        : [];

  const testRoots = detectTestRoots(repoRoot, sourceRoots);
  const mapFile = config?.context?.map_file || config?.paths?.context_map || path.join(repoRoot, 'sherlog.context.json');

  const result = ensureContextMap(repoRoot, mapFile, {
    sourceRoots,
    testRoots,
    docsDir,
    force: args.force,
  });

  if (config) {
    config.context = {
      ...(config.context || {}),
      mode: 'sherlog-map',
      map_file: result.mapPath,
    };

    config.paths = {
      ...(config.paths || {}),
      context_map: result.mapPath,
      source_roots: sourceRoots,
      test_roots: testRoots,
    };

    fs.writeFileSync(configPath, JSON.stringify(toPortableConfig(config, repoRoot), null, 2) + '\n', 'utf8');
  }

  const summary = {
    repo_root: repoRoot,
    map_file: result.mapPath,
    created: result.created,
    updated: result.updated,
    source_roots: sourceRoots,
    test_roots: testRoots,
    docs_dir: docsDir,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Sherlog context initialization complete.');
  console.log(`Map file: ${result.mapPath}`);
  if (result.created) {
    console.log('Status: created new context map.');
  } else if (result.updated) {
    console.log('Status: refreshed existing context map.');
  } else {
    console.log('Status: context map already exists (use --force to rebuild).');
  }
  console.log(`Source roots: ${sourceRoots.length ? sourceRoots.join(', ') : 'none'}`);
  if (testRoots.length > 0) {
    console.log(`Test roots: ${testRoots.join(', ')}`);
  }
}

if (require.main === module) main();
