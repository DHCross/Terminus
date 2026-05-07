#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig, readJson } = require('../core/shared');
const { buildConsumerGraph, summarizeConsumersForFile } = require('../core/consumers');
const { generateStaticBounds } = require('../core/boundary-mapper');

function parseArgs(argv) {
  const out = {
    file: '',
    blastThreshold: 5,
    help: false,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--file' || arg === '-f') && argv[i + 1]) out.file = argv[++i];
    else if (arg === '--threshold' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.blastThreshold = n;
    }
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-') && !out.file) out.file = arg;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/blast-radius.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file, -f <path>      target file to analyse (required)');
  console.log('  --threshold <n>        downstream consumer count above which the blast is flagged as high (default: 5)');
  console.log('  --json                 emit JSON output');
  console.log('  --help, -h             show this message');
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function loadContextZones(config) {
  const { resolveRuntimeConfig } = require('../core/shared');
  const path = require('path');
  const fs = require('fs');

  const resolved = resolveRuntimeConfig(config || {});
  const repoRoot = resolved?.repo_root || process.cwd();

  const candidates = [
    config?.paths?.generated_context_map,
    config?.context?.map_file,
    config?.paths?.context_map,
    path.join(repoRoot, 'sherlog.context.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const contextMap = readJson(candidate, null);
      if (contextMap && Array.isArray(contextMap.zones)) return contextMap.zones;
    } catch {
      // continue
    }
  }

  return [];
}

function pathMatchesGlob(relPath, pattern) {
  const file = normalizePath(relPath).toLowerCase();
  const glob = normalizePath(pattern).toLowerCase();
  if (!file || !glob) return false;

  const fileSegments = file.split('/').filter(Boolean);
  const globSegments = glob.split('/').filter(Boolean);
  if (!fileSegments.length || !globSegments.length) return false;

  function match(fi, gi) {
    if (gi >= globSegments.length) return fi >= fileSegments.length;
    const gs = globSegments[gi];
    if (gs === '**') {
      if (gi === globSegments.length - 1) return true;
      for (let index = fi; index <= fileSegments.length; index++) {
        if (match(index, gi + 1)) return true;
      }
      return false;
    }
    if (fi >= fileSegments.length) return false;
    const segPattern = `^${gs.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\\\*/g, '[^/]*')}$`;
    if (!new RegExp(segPattern).test(fileSegments[fi])) return false;
    return match(fi + 1, gi + 1);
  }

  return match(0, 0);
}

function classifyFile(filePath, zones) {
  let bestMatch = null;
  let bestSpecificity = -1;

  for (const zone of zones) {
    const paths = Array.isArray(zone.paths) ? zone.paths : [];
    for (const pattern of paths) {
      if (pathMatchesGlob(filePath, pattern)) {
        const specificity = normalizePath(pattern).length;
        if (specificity > bestSpecificity) {
          bestSpecificity = specificity;
          bestMatch = zone;
        }
      }
    }
  }

  if (!bestMatch) return { tier: 'unmapped', zone: null };

  const policy = String(bestMatch.touch_policy || '').trim().toLowerCase();
  if (policy === 'do_not_touch') return { tier: 'do_not_touch', zone: bestMatch };
  if (policy === 'reference_only') return { tier: 'reference', zone: bestMatch };

  const name = String(bestMatch.name || '').toLowerCase();
  if (name.includes('test') || name.includes('spec')) return { tier: 'test', zone: bestMatch };

  const matchedPaths = (Array.isArray(bestMatch.paths) ? bestMatch.paths : []).join(' ').toLowerCase();
  if (matchedPaths.includes('test') || matchedPaths.includes('spec') || matchedPaths.includes('__tests__')) {
    return { tier: 'test', zone: bestMatch };
  }

  if (policy === 'risky_touch') return { tier: 'production', zone: bestMatch };
  return { tier: 'production', zone: bestMatch };
}

function classifyByFilePath(filePath) {
  const lower = normalizePath(filePath).toLowerCase();
  if (
    lower.includes('/__tests__/') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('.test.') ||
    lower.includes('.spec.')
  ) return 'test';
  return 'production';
}

function analyzeBlastRadius(config, filePath, blastThreshold) {
  const graph = buildConsumerGraph(config);
  const summary = summarizeConsumersForFile(graph, filePath);

  if (!summary.target_file) {
    return {
      target_file: normalizePath(filePath),
      found: false,
      error: `File not found in scan set: ${filePath}`,
      direct_consumers: [],
      transitive_consumers: [],
      test_files: [],
      do_not_touch: [],
      obligations: [],
      downstream_count: 0,
      blast_level: 'none',
    };
  }

  const zones = loadContextZones(config);

  // Collect direct consumers (files one hop away from the target, both imports and re-exports)
  const directConsumers = new Set();
  const outgoing = graph.outgoing_by_source.get(summary.target_file) || [];
  outgoing.forEach(edge => directConsumers.add(edge.to));

  // summary.consumers contains the final import consumers traced through re-export chains.
  // Merge with directConsumers to get the full set of all affected files.
  const allAffected = new Set([...directConsumers, ...summary.consumers]);

  const testFiles = [];
  const doNotTouch = [];
  const transitiveConsumers = [];

  for (const consumer of allAffected) {
    const classified = zones.length > 0
      ? classifyFile(consumer, zones)
      : { tier: classifyByFilePath(consumer), zone: null };

    if (classified.tier === 'test') {
      testFiles.push(consumer);
    } else if (classified.tier === 'do_not_touch') {
      doNotTouch.push(consumer);
    }

    if (!directConsumers.has(consumer)) {
      transitiveConsumers.push(consumer);
    }
  }

  // Collect obligations from context zones matched by the target file
  const obligations = [];
  if (zones.length > 0) {
    const { zone } = classifyFile(summary.target_file, zones);
    if (zone?.belief) {
      obligations.push(`Zone "${zone.name}" belief: ${zone.belief}`);
    }
    // Add do-not-touch obligations
    if (doNotTouch.length > 0) {
      obligations.push(`Do-not-touch consumers found (${doNotTouch.length}): validate before editing target.`);
    }
  }

  const count = allAffected.size;
  let blastLevel;
  if (count === 0) blastLevel = 'none';
  else if (count < Math.floor(blastThreshold / 2)) blastLevel = 'low';
  else if (count < blastThreshold) blastLevel = 'medium';
  else blastLevel = 'high';

  return {
    target_file: summary.target_file,
    found: true,
    direct_consumers: Array.from(directConsumers).sort((a, b) => a.localeCompare(b)),
    transitive_consumers: transitiveConsumers.sort((a, b) => a.localeCompare(b)),
    test_files: testFiles.sort((a, b) => a.localeCompare(b)),
    do_not_touch: doNotTouch.sort((a, b) => a.localeCompare(b)),
    obligations,
    downstream_count: count,
    blast_level: blastLevel,
    exports: summary.exports,
  };
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.file) {
    console.error('Error: --file <path> is required.');
    console.error('');
    printHelp();
    process.exit(1);
  }

  const config = loadConfig();
  const result = analyzeBlastRadius(config, args.file, args.blastThreshold);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  console.log('SHERLOG BLAST-RADIUS ANALYSIS');
  console.log(`Target: ${result.target_file}`);

  if (!result.found) {
    console.log(`Error: ${result.error}`);
    process.exit(1);
  }

  console.log(`Blast level: ${result.blast_level.toUpperCase()} (${result.downstream_count} downstream consumer(s))`);
  console.log(`Named exports: ${(result.exports || []).length}`);
  console.log('');

  console.log(`Direct consumers (${result.direct_consumers.length}):`);
  if (result.direct_consumers.length === 0) {
    console.log('  - none');
  } else {
    result.direct_consumers.forEach(f => console.log(`  - ${f}`));
  }

  console.log('');
  console.log(`Transitive consumers (${result.transitive_consumers.length}):`);
  if (result.transitive_consumers.length === 0) {
    console.log('  - none');
  } else {
    result.transitive_consumers.forEach(f => console.log(`  - ${f}`));
  }

  console.log('');
  console.log(`Test files affected (${result.test_files.length}):`);
  if (result.test_files.length === 0) {
    console.log('  - none detected');
  } else {
    result.test_files.forEach(f => console.log(`  - ${f}`));
  }

  if (result.do_not_touch.length > 0) {
    console.log('');
    console.log(`! Do-not-touch consumers (${result.do_not_touch.length}):`);
    result.do_not_touch.forEach(f => console.log(`  - ${f}`));
  }

  if (result.obligations.length > 0) {
    console.log('');
    console.log('Obligations:');
    result.obligations.forEach(o => console.log(`  - ${o}`));
  }
}

if (require.main === module) main();

module.exports = { analyzeBlastRadius, parseArgs };
