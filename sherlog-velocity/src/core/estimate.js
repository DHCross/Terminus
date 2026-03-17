#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  confidenceFromSample,
  readJson,
  readJsonLines,
  resolveConfigPath: resolveSharedConfigPath,
  resolveRepoRoot: resolveSharedRepoRoot,
  resolveRuntimeConfig,
  rolling,
} = require('./shared');
const { detectGaps } = require('./gap-detector');
const { getSelfModel } = require('./self-model');
const { SessionTracker } = require('./session-tracker');

function parseArgs(argv) {
  const out = {
    feature: '',
    profile: '',
    gaps: [],
    gapsFile: null,
    prompt: false,
    json: false,
    bundle: null,
    autoGaps: true,
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
    else if (arg === '--gap' && argv[i + 1]) out.gaps.push(argv[++i]);
    else if (arg === '--gaps-file' && argv[i + 1]) out.gapsFile = argv[++i];
    else if (arg === '--bundle' && argv[i + 1]) out.bundle = argv[++i];
    else if (arg === '--alias' && argv[i + 1]) out.aliases.push(argv[++i]);
    else if (arg === '--token' && argv[i + 1]) out.metadata.tokens.push(argv[++i]);
    else if ((arg === '--implementation-token' || arg === '--impl-token') && argv[i + 1]) out.metadata.implementation_tokens.push(argv[++i]);
    else if (arg === '--test-token' && argv[i + 1]) out.metadata.test_tokens.push(argv[++i]);
    else if ((arg === '--doc-token' || arg === '--docs-token') && argv[i + 1]) out.metadata.doc_tokens.push(argv[++i]);
    else if (arg === '--repomix-token' && argv[i + 1]) out.metadata.repomix_tokens.push(argv[++i]);
    else if ((arg === '--zone' || arg === '--area' || arg === '--vector' || arg === '--bucket') && argv[i + 1]) {
      const val = argv[++i].trim();
      if (val) out.zones.push(val);
    }
    else if (arg === '--prompt') out.prompt = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--no-auto-gaps') out.autoGaps = false;
    else if (!arg.startsWith('-')) out.feature = out.feature ? `${out.feature} ${arg}` : arg;
  }

  return out;
}

function loadConfig() {
  const configPath = path.resolve(__dirname, '../../config/sherlog.config.json');
  return resolveRuntimeConfig(readJson(configPath, null));
}

function normalizeGap(gap) {
  return String(gap || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function loadGapsFromFile(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = readJson(resolved, null);
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return raw.map(item => (typeof item === 'string' ? item : item?.type)).filter(Boolean);
  }

  if (Array.isArray(raw.gaps)) {
    return raw.gaps.map(item => (typeof item === 'string' ? item : item?.type)).filter(Boolean);
  }

  return [];
}

function inferGapsFromFeature(feature) {
  if (!feature) {
    return ['missing_implementation', 'test_coverage', 'documentation'];
  }

  const f = feature.toLowerCase();
  const inferred = ['missing_implementation', 'test_coverage'];
  if (f.includes('protocol')) inferred.push('protocol_handler');
  if (f.includes('integrat')) inferred.push('integration');
  if (f.includes('docs') || f.includes('documentation')) inferred.push('documentation');
  if (f.includes('refactor')) inferred.push('refactor');
  if (f.includes('type')) inferred.push('type_orphan');
  if (!inferred.includes('documentation')) inferred.push('documentation');
  return inferred;
}

function rankConfidence(runCount, gapSource) {
  const base = confidenceFromSample(runCount);
  if (gapSource === 'explicit' || gapSource === 'auto_detected') return base;
  if (base === 'high') return 'medium';
  if (base === 'medium') return 'low';
  return 'low';
}

function estimateGapComplexity(gaps, weights) {
  const breakdown = gaps.map(type => {
    const key = normalizeGap(type);
    const commits = Number(weights[key] ?? weights.unknown ?? 10);
    return { type: key, estimated_commits: commits };
  });
  const totalCommits = breakdown.reduce((sum, gap) => sum + gap.estimated_commits, 0);
  return { breakdown, totalCommits };
}

function chooseVelocity(entries) {
  const roll = rolling(entries, 10);
  if (roll && roll.commits_per_day_window > 0) return roll.commits_per_day_window;

  const latest = entries[entries.length - 1];
  if (!latest) return 0;
  if ((latest.commits_per_day_window || 0) > 0) return latest.commits_per_day_window;
  return (latest.commits_per_hour_active || 0) * 24;
}

function bundleHint(config, override) {
  if (override) return override;
  if (!config.bundler || !config.bundler.type) return 'none';
  const first = Array.isArray(config.bundler.bundles) ? config.bundler.bundles[0] : null;
  if (config.bundler.type === 'repomix' && first) return `@repomix:${first}`;
  if (config.bundler.type === 'repomix') return '@repomix:core';
  return config.bundler.type;
}

function resolveConfigPath(repoRoot, value) {
  return resolveSharedConfigPath(repoRoot, value);
}

function resolveRepoRoot(config) {
  return resolveSharedRepoRoot(config?.repo_root, process.cwd());
}

function resolveContextMapPath(repoRoot, config) {
  const candidates = [
    config?.paths?.generated_context_map,
    config?.context?.map_file,
    config?.paths?.context_map,
    'sherlog.context.json',
  ];

  for (const candidate of candidates) {
    const resolved = resolveConfigPath(repoRoot, candidate);
    if (resolved && fs.existsSync(resolved)) return resolved;
  }

  return path.join(repoRoot, 'sherlog.context.json');
}

function readArchitecturalRules(repoRoot, config) {
  const contextMapPath = resolveConfigPath(repoRoot, config?.context?.map_file || config?.paths?.context_map);
  const contextPath = path.join(repoRoot, 'sherlog.context.json');
  const candidates = [contextPath, contextMapPath].filter(Boolean);
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const parsed = readJson(candidate, null);
    if (!parsed || typeof parsed !== 'object') continue;
    const zones = Array.isArray(parsed.zones) ? parsed.zones : [];
    if (!zones.length) continue;

    const rules = zones.map(zone => ({
      name: String(zone?.name || 'unnamed-zone'),
      belief: String(zone?.belief || '').trim(),
      paths: Array.isArray(zone?.paths) ? zone.paths.map(item => String(item || '').trim()).filter(Boolean) : [],
    }));

    return {
      path: candidate,
      rules,
    };
  }

  return {
    path: null,
    rules: [],
  };
}

function readRecentCommits(repoRoot, limit = 20) {
  if (!repoRoot) return [];
  const sampleSize = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  const separator = '\u001f';

  let raw = '';
  try {
    raw = execSync(`git log -n ${sampleSize} --date=short --pretty=format:%h%x1f%ad%x1f%s`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return [];
  }

  if (!raw) return [];
  return raw.split(/\r?\n/).map(line => {
    const [sha, date, subject] = line.split(separator);
    return {
      sha: String(sha || '').trim(),
      date: String(date || '').trim(),
      subject: String(subject || '').trim(),
    };
  }).filter(row => row.sha && row.date && row.subject);
}

function buildInitialScanSummary(config, detection, normalizedGaps) {
  const repoRoot = resolveRepoRoot(config);
  const architecture = readArchitecturalRules(repoRoot, config);
  const recentCommits = readRecentCommits(repoRoot, 20);

  return {
    label: 'initial scan — no velocity baseline yet',
    source: {
      gaps: Array.isArray(detection?.gaps) ? detection.gaps.map(normalizeGap) : normalizedGaps,
      architectural_rules: architecture.rules,
      architectural_rules_path: architecture.path,
      recent_commits: recentCommits,
    },
  };
}

function createEstimatePayload(input = {}) {
  const args = {
    feature: input.feature || '',
    gaps: Array.isArray(input.gaps) ? input.gaps : [],
    gapsFile: input.gapsFile || null,
    bundle: input.bundle || null,
    autoGaps: input.autoGaps !== false,
    zones: Array.isArray(input.zones) ? input.zones : [],
    aliases: Array.isArray(input.aliases) ? input.aliases : [],
    profile: input.profile || '',
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
  };

  const config = resolveRuntimeConfig(input.config || loadConfig());
  if (!config) throw new Error('Config not found. Run `node sherlog-velocity/install.js` first.');

  const entries = Array.isArray(input.entries) ? input.entries : readJsonLines(config.paths.velocity_log);

  const explicitFileGaps = args.gapsFile ? loadGapsFromFile(args.gapsFile) : [];
  const explicitGaps = args.gaps.concat(explicitFileGaps).map(normalizeGap).filter(Boolean);
  const featureName = args.feature || 'unnamed feature';

  let gapSource = 'inferred';
  let gaps = [];
  let detection = null;

  if (explicitGaps.length > 0) {
    gapSource = 'explicit';
    gaps = explicitGaps;
  } else if (args.autoGaps) {
    detection = detectGaps(featureName, config, {
      record: false,
      zones: args.zones,
      aliases: args.aliases,
      profile: args.profile || undefined,
      metadata: args.metadata,
    });
    if (Array.isArray(detection?.gaps) && detection.gaps.length > 0) {
      gapSource = 'auto_detected';
      gaps = detection.gaps.map(normalizeGap);
    }
  }

  if (!gaps.length) {
    gapSource = 'inferred';
    gaps = inferGapsFromFeature(featureName);
  }
  const normalizedGaps = gaps.map(normalizeGap).filter(Boolean);

  const weights = readJson(config.paths.gap_weights, { unknown: 10 });
  const { breakdown, totalCommits } = estimateGapComplexity(normalizedGaps, weights);
  const velocityPerDay = chooseVelocity(entries);
  const estimatedDays = velocityPerDay > 0 ? Math.max(1, Math.ceil(totalCommits / velocityPerDay)) : null;
  const confidence = rankConfidence(entries.length, gapSource);
  const bundle = bundleHint(config, args.bundle);
  const baseline = entries.length > 0 ? 'velocity_history' : 'initial_scan';
  const initialScan = baseline === 'initial_scan'
    ? buildInitialScanSummary(config, detection, normalizedGaps)
    : null;

  let sessionOutputFeatures = null;
  try {
    const tracker = new SessionTracker(config);
    sessionOutputFeatures = tracker.generatePromptOutputFeatures();
  } catch {
    sessionOutputFeatures = null;
  }

  let selfModel = null;
  let selfModelSource = null;
  try {
    const repoRoot = resolveRepoRoot(config);
    const sourceRoots = Array.isArray(config?.paths?.source_roots) && config.paths.source_roots.length > 0
      ? config.paths.source_roots
      : ['src'];
    const selfModelResult = getSelfModel(repoRoot, {
      config,
      sourceRoots,
      contextMapPath: resolveContextMapPath(repoRoot, config),
      persist: true,
    });
    selfModel = selfModelResult.model;
    selfModelSource = selfModelResult.source;
  } catch {
    selfModel = null;
    selfModelSource = null;
  }

  return {
    feature: featureName,
    historical: {
      runs: entries.length,
      commits_per_day: Number(velocityPerDay.toFixed(2)),
      baseline,
    },
    estimate: {
      commits: totalCommits,
      days: estimatedDays,
      confidence,
      breakdown,
      gap_source: gapSource,
    },
    context: {
      mode: config.context?.mode || (config.bundler?.type === 'repomix' ? 'repomix-compat' : 'none'),
      map_file: config.context?.map_file || config.paths?.context_map || null,
      bundler: config.bundler?.type || 'none',
      bundle_hint: bundle,
    },
    initial_scan: initialScan,
    detection: detection?.evidence || null,
    salience: detection?.salience || null,
    session_output_features: sessionOutputFeatures,
    self_model: selfModel,
    self_model_source: selfModelSource,
  };
}

function renderPrompt(payload) {
  const feature = payload.feature || 'Current Task';
  const bundle = payload.context?.bundle_hint || 'none';
  const lines = [];
  const selfModel = payload.self_model || null;
  const codeIndex = payload?.detection?.code_index || null;

  if (selfModel) {
    lines.push('CODEBASE SELF-MODEL (evidence - reason from this, not from assumptions):');
    lines.push(`- ${selfModel.summary.total_modules} indexed modules, ${selfModel.summary.total_edges} dependency edges`);
    lines.push(`- Zone coverage: ${selfModel.summary.zone_coverage_pct}%`);
    if (selfModel.summary.fragile_file_count > 0) {
      lines.push(`- ${selfModel.summary.fragile_file_count} fragile files (elevated churn, size, or coupling):`);
      for (const file of (selfModel.fragile_files || []).slice(0, 5)) {
        lines.push(`    ${file.path} [${file.label}] ${file.lines} lines, ${file.churn} recent commits`);
      }
    }
    if (codeIndex?.available) {
      lines.push(`- Code-index confidence: ${(codeIndex.confidence || 'low').toUpperCase()} (${codeIndex.indexed_feature_files?.length || 0} matched modules)`);
      lines.push(`- Code-index source: ${codeIndex.source || payload.self_model_source || 'unknown'} | path: ${codeIndex.path || 'n/a'}`);
      (codeIndex.indexed_feature_matches || []).slice(0, 4).forEach(match => {
        lines.push(`    ${match.path} [score ${match.score}] ${Array.isArray(match.reasons) ? match.reasons.join(', ') : ''}`);
      });
    }
    lines.push('');
  }

  if (bundle !== 'none') lines.push(bundle);
  lines.push(`I need to build: "${feature}".`);
  lines.push('');
  if (payload.initial_scan) {
    lines.push(`STATUS: ${payload.initial_scan.label}`);
    lines.push('');
  }
  lines.push('CONTEXT & VELOCITY:');
  lines.push(`- My velocity: ${payload.historical?.commits_per_day ?? 0} commits/day.`);
  lines.push(`- Estimated cost: ~${payload.estimate?.commits ?? 0} commits.`);
  lines.push(`- Target duration: ${payload.estimate?.days ?? 'unknown'} day(s).`);
  lines.push(`- Confidence: ${(payload.estimate?.confidence || 'low').toUpperCase()}.`);
  lines.push('');
  lines.push('DETECTED GAPS:');

  const breakdown = Array.isArray(payload.estimate?.breakdown) ? payload.estimate.breakdown : [];
  if (breakdown.length) {
    for (const item of breakdown) {
      lines.push(`- [ ] ${item.type} (${item.estimated_commits} commits)`);
    }
  } else {
    lines.push('- [ ] none');
  }

  lines.push('');
  const contextMap = payload?.detection?.context_map || null;
  const salience = payload?.salience || null;
  if (contextMap && contextMap.enabled) {
    lines.push('CONTEXT MAP CHECK:');
    lines.push(`- Mode: ${contextMap.map_mode || payload.context?.mode || 'none'}`);
    lines.push(`- Map: ${contextMap.map_exists ? 'present' : 'missing'}${contextMap.map_valid === false ? ' (invalid)' : ''}`);
    lines.push(`- Stale areas: ${(contextMap.stale_areas || []).length}`);
    lines.push(`- Drift areas: ${(contextMap.drift_areas || []).length}`);
    lines.push(`- Uncovered feature files: ${(contextMap.uncovered_feature_files || []).length}`);
    lines.push('');
  }

  if (salience && Array.isArray(salience.ranked) && salience.ranked.length > 0) {
    const summary = salience.summary || {};
    lines.push('SALIENCE SIGNAL:');
    lines.push(`- Total contradiction score: ${Number(summary.total_score || 0).toFixed(2)} (${String(summary.trend || 'new')}, Δ ${Number.isFinite(summary.delta_score) ? `${summary.delta_score > 0 ? '+' : ''}${summary.delta_score.toFixed(2)}` : 'n/a'})`);
    salience.ranked.slice(0, 3).forEach(item => {
      lines.push(`- ${item.gap}: score ${Number(item.score || 0).toFixed(2)}, blast L${Number(item?.blast_radius?.level || 0)}, persistence ${Number(item?.persistence?.consecutive_runs || 1)} run(s)`);
    });
    lines.push('');
  }

  if (payload.initial_scan) {
    const scan = payload.initial_scan.source || {};
    const sourceGaps = Array.isArray(scan.gaps) ? scan.gaps : [];
    const rules = Array.isArray(scan.architectural_rules) ? scan.architectural_rules : [];
    const commits = Array.isArray(scan.recent_commits) ? scan.recent_commits : [];

    lines.push('INITIAL SCAN SOURCES:');
    if (sourceGaps.length > 0) {
      lines.push(`- Current gap snapshot: ${sourceGaps.join(', ')}`);
    } else {
      lines.push('- Current gap snapshot: none detected');
    }

    if (rules.length > 0) {
      lines.push(`- Architectural rules file: ${scan.architectural_rules_path || 'sherlog.context.json'}`);
      rules.slice(0, 8).forEach(rule => {
        const belief = rule.belief ? ` — ${rule.belief}` : '';
        lines.push(`  - ${rule.name}${belief}`);
      });
    } else {
      lines.push('- Architectural rules: unavailable');
    }

    if (commits.length > 0) {
      lines.push(`- Recent git log sample (${commits.length} commit${commits.length === 1 ? '' : 's'}):`);
      commits.forEach(commit => {
        lines.push(`  - ${commit.sha} ${commit.date} ${commit.subject}`);
      });
    } else {
      lines.push('- Recent git log sample: unavailable');
    }
    lines.push('');
  }

  const sessionOutput = payload?.session_output_features;
  if (sessionOutput && typeof sessionOutput === 'object') {
    lines.push('SESSION TRACKING OUTPUT FEATURES:');
    lines.push(`- Sample size: ${Number(sessionOutput.sample_size || 0)} session(s) (lookback ${Number(sessionOutput.lookback_sessions || 0)}).`);

    const multiplier = sessionOutput.multiplier || {};
    if (multiplier.available && Number.isFinite(multiplier.value)) {
      lines.push(`- Invisible work multiplier: ${Number(multiplier.value).toFixed(2)}x (implementation ${Number(multiplier.implementation_hours || 0).toFixed(2)}h vs discovery/debugging ${Number(multiplier.invisible_hours || 0).toFixed(2)}h).`);
    } else {
      lines.push('- Invisible work multiplier: n/a (need implementation and discovery/debugging history).');
    }

    const ledger = sessionOutput.wasted_time_ledger || {};
    lines.push(`- Wasted time ledger: ${Number(ledger.wasted_hours || 0).toFixed(2)}h of ${Number(ledger.total_hours || 0).toFixed(2)}h (${Number(ledger.wasted_ratio || 0).toFixed(1)}%).`);
    const ledgerTop = Array.isArray(ledger.top_features) ? ledger.top_features : [];
    if (ledgerTop.length > 0) {
      ledgerTop.slice(0, 3).forEach((item) => {
        lines.push(`  - ${item.feature}: ${Number(item.wasted_hours || 0).toFixed(2)}h wasted (${Number(item.wasted_ratio || 0).toFixed(1)}%), ${Number(item.sessions || 0)} session(s)`);
      });
    }

    const velocityTracker = sessionOutput.velocity_tracker || {};
    lines.push(`- Velocity tracker reality check: apparent ${Number(velocityTracker.apparent_hours || 0).toFixed(2)}h vs actual ${Number(velocityTracker.actual_hours || 0).toFixed(2)}h (drift ${Number(velocityTracker.timeline_drift_hours || 0).toFixed(2)}h, ${Number(velocityTracker.timeline_drift_pct || 0).toFixed(1)}%).`);
    if (Number.isFinite(velocityTracker.estimate_bias_multiplier)) {
      lines.push(`- AI timeline bias: ${Number(velocityTracker.estimate_bias_multiplier).toFixed(2)}x.`);
    } else {
      lines.push('- AI timeline bias: n/a (need implementation and discovery/debugging history).');
    }

    const bossReport = sessionOutput.boss_ready_report || {};
    lines.push(`- Boss-ready report headline: ${bossReport.headline || 'n/a'}`);
    if (Array.isArray(bossReport.bullets) && bossReport.bullets.length > 0) {
      bossReport.bullets.slice(0, 3).forEach((bullet) => lines.push(`  - ${bullet}`));
    }
    lines.push('');
  }

  lines.push('INSTRUCTIONS:');
  lines.push('1. Break this into atomic implementation steps.');
  lines.push('2. Prioritize the detected gaps first.');
  lines.push('3. Start with core implementation and tests, then integration/docs.');

  return lines.join('\n');
}

function renderEstimate(payload) {
  const output = [];
  output.push('SHERLOG VELOCITY ANALYSIS');
  output.push(`Feature: ${payload.feature}`);
  output.push(`Velocity baseline: ${payload.historical.commits_per_day} commits/day (${payload.historical.runs} run(s))`);
  output.push(`Estimated work: ${payload.estimate.commits} commits`);
  output.push(`Estimated time: ${payload.estimate.days === null ? 'unknown' : `${payload.estimate.days} day(s)`}`);
  output.push(`Confidence: ${payload.estimate.confidence.toUpperCase()} (${payload.estimate.gap_source.replace(/_/g, ' ')})`);
  output.push('');
  output.push('Breakdown:');
  payload.estimate.breakdown.forEach(item => {
    output.push(`- ${item.type}: ${item.estimated_commits} commits`);
  });
  output.push('');
  output.push(`Context bundle: ${payload.context.bundle_hint}`);
  output.push(`Context mode: ${payload.context.mode || 'none'}`);
  if (payload.context.map_file) {
    output.push(`Context map file: ${payload.context.map_file}`);
  }
  if (payload.self_model) {
    output.push(`Code index: ${payload.self_model.summary.total_modules} modules, ${payload.self_model.summary.total_edges} dependency edges (${payload.self_model_source || 'unknown'})`);
  }

  if (payload.detection) {
    output.push(`Auto-detected implementation: ${payload.detection.has_implementation ? 'yes' : 'no'}`);
    output.push(`Auto-detected tests: ${payload.detection.has_tests ? 'yes' : 'no'}`);
    if (payload.detection.docs_root) {
      output.push(`Auto-detected docs: ${payload.detection.has_docs ? 'yes' : 'no'} (${payload.detection.docs_root})`);
    }
    const codeIndex = payload.detection.code_index || null;
    if (codeIndex?.available) {
      output.push(`Code-index confidence: ${String(codeIndex.confidence || 'low').toUpperCase()} | matched modules: ${Number(codeIndex?.indexed_feature_files?.length || 0)}`);
      (codeIndex.indexed_feature_matches || []).slice(0, 3).forEach((item, index) => {
        output.push(`Code-index #${index + 1}: ${item.path} | score ${Number(item.score || 0)} | reasons ${(item.reasons || []).join(', ')}`);
      });
    }
    const contextMap = payload.detection.context_map || null;
    if (contextMap && contextMap.enabled) {
      output.push(`Context map mode: ${contextMap.map_mode || payload.context.mode || 'none'}`);
      output.push(`Context map: ${contextMap.map_exists ? 'present' : 'missing'}${contextMap.map_valid === false ? ' (invalid)' : ''}`);
      output.push(`Context stale areas: ${(contextMap.stale_areas || []).length}`);
      output.push(`Context drift areas: ${(contextMap.drift_areas || []).length}`);
      output.push(`Context uncovered feature files: ${(contextMap.uncovered_feature_files || []).length}`);
    }
    if (payload.context.bundler === 'repomix' || payload.context.mode === 'repomix-compat') {
      output.push(`Auto-detected repomix mention: ${payload.detection.has_repomix_mention ? 'yes' : 'no'}`);
    }
  }

  if (payload.salience && Array.isArray(payload.salience.ranked)) {
    const summary = payload.salience.summary || {};
    output.push(`Salience total score: ${Number(summary.total_score || 0).toFixed(2)} (${String(summary.trend || 'new')}, Δ ${Number.isFinite(summary.delta_score) ? `${summary.delta_score > 0 ? '+' : ''}${summary.delta_score.toFixed(2)}` : 'n/a'})`);
    output.push(`Salience active gaps: ${Number(summary.active_gaps || 0)} | resolved since last run: ${Number(summary.resolved_gaps || 0)}`);
    payload.salience.ranked.slice(0, 3).forEach((item, idx) => {
      output.push(`Salience #${idx + 1}: ${item.gap} | score ${Number(item.score || 0).toFixed(2)} | blast L${Number(item?.blast_radius?.level || 0)} | trend ${item.trend || 'new'}`);
    });
  }

  return output.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  let payload;
  try {
    payload = createEstimatePayload(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderEstimate(payload));
  }

  if (args.prompt) {
    console.log('');
    console.log('COPY/PASTE PROMPT');
    console.log('----------------');
    console.log(renderPrompt(payload));
  }
}

if (require.main === module) main();

module.exports = {
  createEstimatePayload,
  inferGapsFromFeature,
  normalizeGap,
  parseArgs,
  renderPrompt,
};
