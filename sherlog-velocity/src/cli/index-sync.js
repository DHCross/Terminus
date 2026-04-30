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
const { loadRuntimeConfig, toPortableConfig } = require('../core/shared');
const { getSelfModel, resolveSelfModelPath } = require('../core/self-model');

function parseArgs(argv) {
  const out = {
    json: false,
    output: null,
    sourceRoots: [],
    help: false,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if ((arg === '--output' || arg === '-o') && argv[index + 1]) out.output = argv[++index];
    else if (arg === '--source-root' && argv[index + 1]) out.sourceRoots.push(argv[++index]);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:index-sync -- [options]');
  console.log('');
  console.log('Options:');
  console.log('  -o, --output <path>    output file path (default: sherlog.generated.context.json)');
  console.log('  --source-root <path>   include a custom source root (repeatable)');
  console.log('  --json                 output a machine-readable summary');
  console.log('  --help, -h             show this message');
}

function normalizeSourceRoot(repoRoot, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const absolute = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const relative = path.relative(repoRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const normalized = normalizePath(relative);
  return normalized || '.';
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  return {
    configPath: runtime.configPath,
    config: runtime.config,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = detectRepoRoot();
  const { configPath, config } = loadConfig();
  const docsDir = config?.paths?.docs_dir || detectDocsDir(repoRoot);

  const explicitSourceRoots = args.sourceRoots
    .map(value => normalizeSourceRoot(repoRoot, value))
    .filter(Boolean);
  const sourceRoots = explicitSourceRoots.length > 0
    ? explicitSourceRoots
    : Array.isArray(config?.paths?.source_roots) && config.paths.source_roots.length > 0
      ? config.paths.source_roots
      : detectSourceRoots(repoRoot);
  const testRoots = Array.isArray(config?.paths?.test_roots) && config.paths.test_roots.length > 0
    ? config.paths.test_roots
    : detectTestRoots(repoRoot, sourceRoots);

  const rawOutput = args.output || config?.paths?.generated_context_map || 'sherlog.generated.context.json';
  const outputPath = path.isAbsolute(rawOutput) ? rawOutput : path.join(repoRoot, rawOutput);
  const result = ensureContextMap(repoRoot, outputPath, {
    sourceRoots,
    testRoots,
    docsDir,
    force: true,
  });

  const selfModelPath = resolveSelfModelPath(repoRoot, { config });
  const selfModelResult = getSelfModel(repoRoot, {
    config,
    sourceRoots,
    contextMapPath: outputPath,
    selfModelPath,
    persist: true,
    force: true,
  });

  if (config) {
    const relOutput = normalizePath(path.relative(repoRoot, outputPath));
    const relSelfModel = normalizePath(path.relative(repoRoot, selfModelPath));
    config.paths = {
      ...(config.paths || {}),
      generated_context_map: relOutput,
      self_model_index: relSelfModel,
      source_roots: sourceRoots,
      test_roots: testRoots,
    };
    fs.writeFileSync(configPath, JSON.stringify(toPortableConfig(config, repoRoot), null, 2) + '\n', 'utf8');
  }

  const summary = {
    repo_root: repoRoot,
    output_file: outputPath,
    self_model_file: selfModelPath,
    created: result.created,
    updated: result.updated,
    zones: result.zones,
    generated_at: result.generated_at,
    source_branch: result.source_branch,
    source_commit: result.source_commit,
    self_model_source: selfModelResult.source,
    indexed_modules: selfModelResult.model.summary.total_modules,
    dependency_edges: selfModelResult.model.summary.total_edges,
    source_roots: sourceRoots,
    test_roots: testRoots,
    docs_dir: docsDir,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Sherlog index sync complete.');
  console.log(`Output file: ${outputPath}`);
  console.log(`Self-model index: ${selfModelPath}`);
  console.log(`Zones: ${result.zones}`);
  console.log(`Indexed modules: ${selfModelResult.model.summary.total_modules}`);
  console.log(`Generated at: ${result.generated_at}`);
  console.log(`Source: ${result.source_branch} @ ${result.source_commit}`);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
};
