#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  loadRuntimeConfig,
  readJsonLines,
  rolling,
  confidenceFromSample,
} = require('../core/shared');
const { detectGaps } = require('../core/gap-detector');
const { scanCodeGaps } = require('../core/code-gaps');
const { scanHygiene } = require('../core/hygiene');
const { analyzeBlastRadius } = require('./blast-radius');
const { buildDiagnostics, recommend, contextHealth } = require('./doctor');
const { renderAuditReport, selectHotFiles } = require('../core/audit-report');

function parseArgs(argv) {
  const out = {
    feature: '',
    tier: 'full',
    out: '',
    customer: '',
    auditor: '',
    commit: '',
    branch: '',
    repoName: '',
    json: false,
    help: false,
    blastTop: 3,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--tier' && argv[i + 1]) out.tier = String(argv[++i]).toLowerCase();
    else if ((arg === '--out' || arg === '-o') && argv[i + 1]) out.out = argv[++i];
    else if (arg === '--customer' && argv[i + 1]) out.customer = argv[++i];
    else if (arg === '--auditor' && argv[i + 1]) out.auditor = argv[++i];
    else if (arg === '--commit' && argv[i + 1]) out.commit = argv[++i];
    else if (arg === '--branch' && argv[i + 1]) out.branch = argv[++i];
    else if (arg === '--repo-name' && argv[i + 1]) out.repoName = argv[++i];
    else if (arg === '--blast-top' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.blastTop = n;
    }
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-') && !out.feature) out.feature = arg;
  }
  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:report -- --feature "<name>" [options]');
  console.log('');
  console.log('Generates a customer-ready Markdown audit report from doctor/gaps/blast-radius output.');
  console.log('');
  console.log('Required:');
  console.log('  --feature <name>     feature scope to audit (matches doctor/gaps semantics)');
  console.log('');
  console.log('Common options:');
  console.log('  --tier <intro|full|setup>   report variant (default: full)');
  console.log('  -o, --out <path>            output file (default: sherlog-reports/<slug>.md)');
  console.log('  --customer <name>           customer name for the report header');
  console.log('  --auditor <name>            auditor name for the report header');
  console.log('  --commit <sha>              commit SHA being audited (auto-detected from git if omitted)');
  console.log('  --branch <name>             branch name (auto-detected from git if omitted)');
  console.log('  --repo-name <name>          repo display name (defaults to current directory name)');
  console.log('  --blast-top <n>             how many hot files to analyze for blast radius (default: 3)');
  console.log('  --json                      emit structured JSON to stdout in addition to writing the file');
  console.log('  --help, -h                  show this message');
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function safeGit(args, opts = {}) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'], ...opts }).toString().trim();
  } catch {
    return '';
  }
}

function shellQuote(value) {
  const str = String(value || '');
  if (str.length === 0) return '""';
  if (/^[A-Za-z0-9_./@:-]+$/.test(str)) return str;
  return `"${str.replace(/(["\\$`])/g, '\\$1')}"`;
}

function detectRepoMeta(args) {
  const cwd = process.cwd();
  const repoName = args.repoName || path.basename(cwd);
  const branch = args.branch || safeGit('rev-parse --abbrev-ref HEAD', { cwd }) || 'main';
  const commit = args.commit || safeGit('rev-parse --short HEAD', { cwd }) || '';
  const sherlogRoot = path.resolve(__dirname, '..', '..');
  const sherlogVersion = safeGit('rev-parse --short HEAD', { cwd: sherlogRoot }) || '';
  return { repoName, branch, commit, sherlogVersion };
}

function slugify(value) {
  return String(value || 'audit')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'audit';
}

function gatherDoctorPayload(config, feature) {
  const entries = readJsonLines(config.paths.velocity_log);
  const roll = rolling(entries, 10);
  const commitsPerDay = (roll && roll.commits_per_day_window) || 0;
  const detection = detectGaps(feature, config, {
    record: false,
    persistSelfModel: false,
    zones: [],
    aliases: [],
  });

  const gaps = Array.isArray(detection?.gaps) ? detection.gaps : [];
  const ctxHealth = contextHealth(detection?.evidence || {});
  const sourceRoots = Array.isArray(detection?.evidence?.source_roots) ? detection.evidence.source_roots : [];

  let hygieneResult = null;
  try {
    hygieneResult = scanHygiene(config, { record: false });
  } catch {
    hygieneResult = null;
  }

  const recommendation = recommend({
    feature,
    entries,
    gaps,
    ctxHealth,
    hygieneTrend: hygieneResult?.trends?.overall || null,
  });

  const diagnostics = buildDiagnostics(ctxHealth, sourceRoots);

  const ctxMap = detection?.evidence?.context_map || null;

  return {
    gaps,
    feature_match_files: Array.isArray(detection?.evidence?.matched_feature_files)
      ? detection.evidence.matched_feature_files
      : [],
    source_roots: sourceRoots,
    docs_root: detection?.evidence?.docs_root || null,
    context_health: {
      ...ctxHealth,
      stale_zones: ctxMap && Array.isArray(ctxMap.stale_areas) ? ctxMap.stale_areas : [],
      drift_zones: ctxMap && Array.isArray(ctxMap.drift_areas) ? ctxMap.drift_areas : [],
      uncovered_zones: ctxMap && Array.isArray(ctxMap.uncovered_feature_files) ? ctxMap.uncovered_feature_files : [],
    },
    diagnostics,
    velocity: {
      runs: entries.length,
      commits_per_day: Number(commitsPerDay.toFixed ? commitsPerDay.toFixed(2) : commitsPerDay),
      confidence: confidenceFromSample(entries.length),
    },
    salience: detection?.salience || null,
    recommendation,
    hygiene: hygieneResult ? {
      total_findings: hygieneResult.summary?.total_findings || 0,
      trend: hygieneResult.trends?.overall || 'insufficient_data',
    } : null,
  };
}

function gatherGapsPayload(config, feature) {
  const detection = detectGaps(feature, config, {
    record: false,
    persistSelfModel: false,
    zones: [],
    aliases: [],
  });
  let codeGaps;
  try {
    codeGaps = scanCodeGaps(config, { include_suppressed: false });
  } catch {
    codeGaps = { mode: 'absolute', files: [], totals: {} };
  }
  return {
    salience: detection?.salience || null,
    evidence: detection?.evidence || {},
    code_gaps: codeGaps,
  };
}

function gatherBlastRadius(config, gapsPayload, limit) {
  const hotFiles = selectHotFiles(gapsPayload, limit);
  const results = [];
  for (const file of hotFiles) {
    try {
      const r = analyzeBlastRadius(config, file, 5);
      results.push(r);
    } catch (err) {
      results.push({ target_file: file, found: false, error: err.message });
    }
  }
  return results;
}

function buildCommandsRun(feature, hotFiles) {
  return [
    `npm run sherlog:doctor -- --feature ${shellQuote(feature)} --json`,
    `npm run sherlog:gaps -- --feature ${shellQuote(feature)} --json`,
    ...hotFiles.map((f) => `npm run sherlog:blast-radius -- --file ${shellQuote(f)} --json`),
  ];
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.feature) {
    console.error('Error: --feature <name> is required.');
    console.error('');
    printHelp();
    process.exit(1);
  }
  if (!['intro', 'full', 'setup'].includes(args.tier)) {
    console.error(`Error: --tier must be one of intro, full, setup (got "${args.tier}").`);
    process.exit(1);
  }

  const config = loadConfig();
  const repoMeta = detectRepoMeta(args);
  const featureSlug = slugify(args.feature);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.resolve(process.cwd(), args.out))
    : path.resolve(process.cwd(), `sherlog-reports/${featureSlug}.md`);

  process.stderr.write(`[sherlog:report] feature="${args.feature}" tier=${args.tier}\n`);
  process.stderr.write(`[sherlog:report] running doctor...\n`);
  const doctor = gatherDoctorPayload(config, args.feature);
  process.stderr.write(`[sherlog:report] running gaps + code-gaps...\n`);
  const gaps = gatherGapsPayload(config, args.feature);
  process.stderr.write(`[sherlog:report] running blast-radius on top ${args.blastTop} hot file(s)...\n`);
  const blast = gatherBlastRadius(config, gaps, args.blastTop);

  const hotFiles = selectHotFiles(gaps, args.blastTop);
  const commandsRun = buildCommandsRun(args.feature, hotFiles);

  const input = {
    meta: {
      feature: args.feature,
      customer: args.customer || null,
      auditor: args.auditor || null,
      repo_name: repoMeta.repoName,
      branch: repoMeta.branch,
      commit: repoMeta.commit,
      sherlog_version: repoMeta.sherlogVersion,
      node_version: process.version,
      date: new Date().toISOString().slice(0, 10),
      commands_run: commandsRun,
    },
    doctor,
    gaps,
    blast_radius: blast,
  };

  const result = renderAuditReport(input, { tier: args.tier });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${result.markdown}\n`, 'utf8');

  process.stderr.write(`[sherlog:report] wrote ${outPath}\n`);
  process.stderr.write(`[sherlog:report] tier=${result.tier}, sections=${result.sections.length}, HUMAN_REVIEW markers=${result.human_review_count}\n`);

  if (args.json) {
    console.log(JSON.stringify({
      output_path: outPath,
      tier: result.tier,
      sections: result.sections,
      human_review_count: result.human_review_count,
      hot_files: hotFiles,
      summary: {
        gap_count: doctor.gaps.length,
        feature_match_count: doctor.feature_match_files.length,
        diagnostics: doctor.diagnostics
          ? { pass: doctor.diagnostics.pass, warn: doctor.diagnostics.warn, fail: doctor.diagnostics.fail }
          : null,
        recommendation: doctor.recommendation
          ? { action: doctor.recommendation.action, priority: doctor.recommendation.priority }
          : null,
      },
    }, null, 2));
  } else {
    console.log(outPath);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, shellQuote, buildCommandsRun, slugify, gatherDoctorPayload, gatherGapsPayload };
