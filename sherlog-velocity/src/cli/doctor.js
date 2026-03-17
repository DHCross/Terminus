#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const {
  readJson,
  readJsonLines,
  rolling,
  confidenceFromSample,
  resolveRuntimeConfig,
} = require('../core/shared');
const { detectGaps } = require('../core/gap-detector');
const { createEstimatePayload } = require('../core/estimate');
const { scanHygiene } = require('../core/hygiene');

function parseArgs(argv) {
  const out = {
    feature: '',
    profile: '',
    json: false,
    strict: false,
    zones: [],
    aliases: [],
    metadata: {
      tokens: [],
      implementation_tokens: [],
      test_tokens: [],
      doc_tokens: [],
      repomix_tokens: [],
    },
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--profile' && argv[i + 1]) out.profile = argv[++i];
    else if ((arg === '--zone' || arg === '--area' || arg === '--vector' || arg === '--bucket') && argv[i + 1]) {
      const val = argv[++i].trim();
      if (val) out.zones.push(val);
    }
    else if (arg === '--alias' && argv[i + 1]) out.aliases.push(argv[++i]);
    else if (arg === '--token' && argv[i + 1]) out.metadata.tokens.push(argv[++i]);
    else if ((arg === '--implementation-token' || arg === '--impl-token') && argv[i + 1]) out.metadata.implementation_tokens.push(argv[++i]);
    else if (arg === '--test-token' && argv[i + 1]) out.metadata.test_tokens.push(argv[++i]);
    else if ((arg === '--doc-token' || arg === '--docs-token') && argv[i + 1]) out.metadata.doc_tokens.push(argv[++i]);
    else if (arg === '--repomix-token' && argv[i + 1]) out.metadata.repomix_tokens.push(argv[++i]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (!arg.startsWith('-')) out.feature = out.feature ? `${out.feature} ${arg}` : arg;
  }

  return out;
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  const config = readJson(configPath, null);
  if (!config) throw new Error('Config not found. Run `node sherlog-velocity/install.js` first.');
  return resolveRuntimeConfig(config);
}

function chooseVelocity(entries) {
  const roll = rolling(entries, 10);
  if (roll && roll.commits_per_day_window > 0) return roll.commits_per_day_window;
  const latest = entries[entries.length - 1];
  if (!latest) return 0;
  if ((latest.commits_per_day_window || 0) > 0) return latest.commits_per_day_window;
  return (latest.commits_per_hour_active || 0) * 24;
}

function contextHealth(detection) {
  const ctx = detection?.context_map || null;
  if (!ctx) {
    return {
      enabled: false,
      mode: 'none',
      map_exists: false,
      map_valid: false,
      stale_areas: 0,
      drift_areas: 0,
      uncovered_feature_files: 0,
      warnings: 0,
      map_path: null,
    };
  }

  return {
    enabled: Boolean(ctx.enabled),
    mode: ctx.map_mode || 'none',
    map_exists: Boolean(ctx.map_exists),
    map_valid: Boolean(ctx.map_valid),
    stale_areas: Array.isArray(ctx.stale_areas) ? ctx.stale_areas.length : 0,
    drift_areas: Array.isArray(ctx.drift_areas) ? ctx.drift_areas.length : 0,
    uncovered_feature_files: Array.isArray(ctx.uncovered_feature_files) ? ctx.uncovered_feature_files.length : 0,
    warnings: Array.isArray(ctx.warnings) ? ctx.warnings.length : 0,
    map_path: ctx.map_path || null,
  };
}

function recommend({ feature, entries, gaps, ctxHealth, hygieneTrend }) {
  const featureArg = feature || 'Feature Name';
  if (!entries.length) {
    return {
      action: 'seed_velocity_history',
      rationale: 'No velocity snapshots found yet, so estimates cannot be grounded.',
      commands: [
        'npm run velocity:run',
        'npm run velocity:report',
      ],
      priority: 'high',
    };
  }

  if (ctxHealth.enabled && (!ctxHealth.map_exists || !ctxHealth.map_valid)) {
    return {
      action: 'initialize_context_map',
      rationale: 'Context mode is enabled but the map is missing or invalid.',
      commands: [
        'npm run sherlog:init-context -- --force',
        `npm run sherlog:gaps -- --feature "${featureArg}" --json`,
      ],
      priority: 'high',
    };
  }

  if (gaps.includes('missing_bundle') || gaps.includes('context_drift') || gaps.includes('stale_context')) {
    return {
      action: 'repair_context_map',
      rationale: 'Context coverage or freshness issues detected in mapped zones.',
      commands: [
        `npm run sherlog:gaps -- --feature "${featureArg}" --json`,
        'npm run sherlog:init-context -- --force',
      ],
      priority: 'high',
    };
  }

  if (gaps.includes('missing_implementation')) {
    return {
      action: 'start_implementation',
      rationale: 'Implementation is missing for the requested feature scope.',
      commands: [
        `npm run sherlog:prompt -- "${featureArg}"`,
      ],
      priority: 'high',
    };
  }

  if (gaps.includes('test_coverage')) {
    return {
      action: 'add_tests',
      rationale: 'Feature-related implementation exists but test coverage is missing.',
      commands: [
        `npm run sherlog:prompt -- "${featureArg}"`,
      ],
      priority: 'medium',
    };
  }

  if (hygieneTrend === 'worsening') {
    return {
      action: 'run_hygiene_scan',
      rationale: 'Code hygiene is degrading. Review and address hygiene findings before continuing.',
      commands: [
        'npm run sherlog:hygiene -- --json',
      ],
      priority: 'medium',
    };
  }

  return {
    action: 'proceed_execution',
    rationale: 'No blocking contradictions detected. Continue with execution plan.',
    commands: [
      `npm run sherlog:prompt -- "${featureArg}"`,
    ],
    priority: 'medium',
  };
}

function buildDiagnostics(ctxHealth, sourceRoots = []) {
  const checks = [];

  checks.push({
    id: 'source_roots_available',
    status: sourceRoots.length > 0 ? 'pass' : 'warn',
    message: sourceRoots.length > 0
      ? 'At least one configured or discovered source root is available.'
      : 'No valid paths.source_roots are available after runtime resolution.',
    evidence: { source_roots: sourceRoots },
  });

  if (ctxHealth.enabled) {
    checks.push({
      id: 'context_map_state',
      status: ctxHealth.map_exists && ctxHealth.map_valid ? 'pass' : 'fail',
      message: ctxHealth.map_exists && ctxHealth.map_valid
        ? 'Context map is present and valid.'
        : 'Context map is missing or invalid for the active context mode.',
      evidence: {
        mode: ctxHealth.mode,
        map_exists: ctxHealth.map_exists,
        map_valid: ctxHealth.map_valid,
        map_path: ctxHealth.map_path,
      },
    });
  }

  if (ctxHealth.warnings > 0) {
    checks.push({
      id: 'context_map_warnings',
      status: 'warn',
      message: `Context map emitted ${ctxHealth.warnings} warning(s).`,
      evidence: {
        warnings: ctxHealth.warnings,
        uncovered_feature_files: ctxHealth.uncovered_feature_files,
      },
    });
  }

  return {
    pass: checks.filter(check => check.status === 'pass').length,
    warn: checks.filter(check => check.status === 'warn').length,
    fail: checks.filter(check => check.status === 'fail').length,
    checks,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const feature = args.feature || 'Current Task';
  let config;

  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const entries = readJsonLines(config.paths.velocity_log);
  const commitsPerDay = chooseVelocity(entries);
  const velocity = {
    runs: entries.length,
    commits_per_day: Number(commitsPerDay.toFixed(2)),
    confidence: confidenceFromSample(entries.length),
  };

  const detection = detectGaps(feature, config, {
    record: false,
    zones: args.zones,
    aliases: args.aliases,
    profile: args.profile || undefined,
    metadata: args.metadata,
  });
  const gaps = Array.isArray(detection?.gaps) ? detection.gaps : [];
  const ctxHealth = contextHealth(detection?.evidence || {});

  let estimate = null;
  let salience = detection?.salience || null;
  if (entries.length > 0) {
    try {
      const payload = createEstimatePayload({
        feature,
        autoGaps: true,
        config,
        entries,
        zones: args.zones,
        aliases: args.aliases,
        profile: args.profile || undefined,
        metadata: args.metadata,
      });
      estimate = payload.estimate;
      salience = payload.salience || salience;
    } catch {
      estimate = null;
    }
  }

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
  const diagnostics = buildDiagnostics(ctxHealth, detection?.evidence?.source_roots || []);

  const output = {
    version: 1,
    timestamp: new Date().toISOString(),
    feature,
    context: {
      mode: config.context?.mode || 'none',
      map_file: config.context?.map_file || config.paths?.context_map || null,
    },
    velocity,
    gaps: {
      total: gaps.length,
      list: gaps,
      source_roots: detection?.evidence?.source_roots || [],
      docs_root: detection?.evidence?.docs_root || null,
    },
    diagnostics,
    context_health: ctxHealth,
    estimate,
    salience: salience || null,
    hygiene: hygieneResult ? {
      total_findings: hygieneResult.summary.total_findings,
      trend: hygieneResult.trends?.overall || 'insufficient_data',
      gaps: hygieneResult.gaps,
      tuning: hygieneResult.tuning,
    } : null,
    recommendation,
    commands: {
      doctor: `npm run sherlog:doctor -- --feature "${feature}" --json`,
      gaps: `npm run sherlog:gaps -- --feature "${feature}" --json`,
      prompt: `npm run sherlog:prompt -- "${feature}"`,
      estimate: `npm run velocity:estimate -- --feature "${feature}"`,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('SHERLOG DOCTOR');
    console.log(`Feature: ${feature}`);
    console.log(`Velocity: ${velocity.commits_per_day} commits/day (${velocity.runs} run(s), ${velocity.confidence})`);
    console.log(`Gaps: ${gaps.length}`);
    console.log(`Context mode: ${output.context.mode}`);
    console.log(`Diagnostics: ${diagnostics.pass} pass, ${diagnostics.warn} warn, ${diagnostics.fail} fail`);
    console.log(`Recommended action: ${recommendation.action} (${recommendation.priority})`);
    console.log(`Reason: ${recommendation.rationale}`);
    console.log('');
    console.log(JSON.stringify(output, null, 2));
  }

  if (args.strict && (diagnostics.warn > 0 || diagnostics.fail > 0)) {
    process.exit(1);
  }
}

if (require.main === module) main();
