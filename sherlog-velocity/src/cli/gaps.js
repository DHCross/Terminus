#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { detectGaps } = require('../core/gap-detector');
const { scanCodeGaps, scanCodeGapDiff } = require('../core/code-gaps');
const { buildConsumerGraph, summarizeConsumersForFile } = require('../core/consumers');

function parseArgs(argv) {
  const out = {
    feature: '',
    profile: '',
    since: '',
    includeSuppressed: false,
    json: false,
    summaryOnly: false,
    record: false,
    persistSelfModel: false,
    zones: [],
    aliases: [],
    metadata: {
      tokens: [],
      implementation_tokens: [],
      test_tokens: [],
      doc_tokens: [],
    },
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feature' && argv[i + 1]) out.feature = argv[++i];
    else if (arg === '--profile' && argv[i + 1]) out.profile = argv[++i];
    else if (arg === '--since' && argv[i + 1]) out.since = argv[++i];
    else if (arg === '--include-suppressed') out.includeSuppressed = true;
    else if ((arg === '--zone' || arg === '--area' || arg === '--vector' || arg === '--bucket') && argv[i + 1]) {
      const val = argv[++i].trim();
      if (val) out.zones.push(val);
    }
    else if (arg === '--alias' && argv[i + 1]) out.aliases.push(argv[++i]);
    else if (arg === '--token' && argv[i + 1]) out.metadata.tokens.push(argv[++i]);
    else if ((arg === '--implementation-token' || arg === '--impl-token') && argv[i + 1]) out.metadata.implementation_tokens.push(argv[++i]);
    else if (arg === '--test-token' && argv[i + 1]) out.metadata.test_tokens.push(argv[++i]);
    else if ((arg === '--doc-token' || arg === '--docs-token') && argv[i + 1]) out.metadata.doc_tokens.push(argv[++i]);
    else if (arg === '--json') out.json = true;
    else if (arg === '--summary-only') out.summaryOnly = true;
    else if (arg === '--no-record') out.record = false;
    else if (arg === '--record') out.record = true;
    else if (arg === '--no-persist-self-model') out.persistSelfModel = false;
    else if (arg === '--persist-self-model') out.persistSelfModel = true;
    else if (!arg.startsWith('-')) out.feature = out.feature ? `${out.feature} ${arg}` : arg;
  }

  return out;
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function formatDelta(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function summarizeTrends(ranked = []) {
  return ranked.reduce((acc, item) => {
    const trend = String(item?.trend || 'new');
    if (!Object.prototype.hasOwnProperty.call(acc, trend)) acc[trend] = 0;
    acc[trend] += 1;
    return acc;
  }, { new: 0, worsening: 0, steady: 0, improving: 0 });
}

function formatSignedDelta(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function metricLabel(metric) {
  if (metric === 'missing_tests') return 'missing tests';
  return metric;
}

function formatAnyHint(hint) {
  const symbol = String(hint?.symbol || 'value');
  const fn = String(hint?.function_name || 'unknown');
  const expected = String(hint?.expected_type || '').trim();
  const source = String(hint?.source || 'local');
  const sourceNote = source && source !== 'local' ? ` [from ${source}]` : '';

  if (hint?.relation === 'return') {
    return `${symbol}: any -> returned from ${fn}() as ${expected}${sourceNote}`;
  }
  return `${symbol}: any -> passed to ${fn}() which expects ${expected}${sourceNote}`;
}

function isHighDensityGapFile(entry, complexityThreshold) {
  const anyTotal = Number(entry?.any?.unsuppressed || 0);
  const missingTests = Number(entry?.missing_tests || 0);
  const complexityDepth = Number(entry?.complexity?.unsuppressed || 0);

  if (anyTotal >= 5) return true;
  if (complexityDepth > complexityThreshold + 1) return true;
  if (missingTests > 0 && anyTotal > 0) return true;
  return false;
}

function annotateConsumerRisk(codeGaps, config) {
  if (!codeGaps || codeGaps.mode !== 'absolute') return codeGaps;
  const entries = Array.isArray(codeGaps.files) ? codeGaps.files : [];
  if (!entries.length) return codeGaps;

  const complexityThreshold = Number(codeGaps?.thresholds?.complexity_depth || 5);
  const graph = buildConsumerGraph(config);
  const enriched = entries.map(entry => {
    if (!isHighDensityGapFile(entry, complexityThreshold)) return entry;

    const consumerSummary = summarizeConsumersForFile(graph, entry.file);
    if (!consumerSummary?.downstream_count) return entry;

    return {
      ...entry,
      risk: {
        level: 'elevated',
        downstream_consumers: Number(consumerSummary.downstream_count || 0),
        exports_with_consumers: consumerSummary.by_export
          .filter(item => Array.isArray(item.chains) && item.chains.length > 0)
          .map(item => item.export),
        sample_chains: consumerSummary.by_export
          .flatMap(item => (item.chains || []).map(chain => ({ export: item.export, chain })))
          .slice(0, 6),
      },
    };
  });

  return {
    ...codeGaps,
    files: enriched,
  };
}

function printCodeGapSection(codeGaps, args) {
  if (!codeGaps) return;

  if (args.since) {
    console.log('');
    console.log(`Code gap diff since ${args.since}:`);
    const changes = Array.isArray(codeGaps.changes) ? codeGaps.changes : [];
    if (changes.length === 0) {
      console.log('- no code-gap deltas detected');
      return;
    }
    changes.forEach(change => {
      console.log(`[${formatSignedDelta(change.delta)} ${metricLabel(change.metric)}] ${change.file} (was ${change.before}, now ${change.after})`);
    });
    return;
  }

  console.log('');
  console.log('Code gaps (absolute):');
  const entries = Array.isArray(codeGaps.files) ? codeGaps.files : [];
  if (entries.length === 0) {
    console.log('- no code-gap hotspots detected');
    return;
  }

  const complexityThreshold = Number(codeGaps?.thresholds?.complexity_depth || 5);
  entries.forEach(entry => {
    const anyTotal = Number(entry?.any?.total || 0);
    const anyUnsuppressed = Number(entry?.any?.unsuppressed || 0);
    const anySuppressed = Number(entry?.any?.suppressed || 0);
    const primaryAny = args.includeSuppressed ? anyTotal : anyUnsuppressed;
    if (primaryAny > 0) {
      if (anySuppressed > 0) {
        if (args.includeSuppressed) {
          console.log(`[${anyTotal} any] ${entry.file} (${anyUnsuppressed} unsuppressed, ${anySuppressed} intentionally suppressed)`);
        } else {
          console.log(`[${anyUnsuppressed} any] ${entry.file} (${anyTotal} total: ${anyUnsuppressed} unsuppressed, ${anySuppressed} intentionally suppressed)`);
        }
      } else {
        console.log(`[${primaryAny} any] ${entry.file}`);
      }

      const hints = Array.isArray(entry?.hints) ? entry.hints : [];
      hints.forEach(hint => {
        if (!hint?.expected_type) return;
        console.log(`  - ${formatAnyHint(hint)}`);
      });
    }
    if (Number(entry?.missing_tests || 0) > 0) {
      console.log(`[${entry.missing_tests} missing tests] ${entry.file}`);
    }
    const depthTotal = Number(entry?.complexity?.total || 0);
    const depthUnsuppressed = Number(entry?.complexity?.unsuppressed || 0);
    const depthSuppressed = Number(entry?.complexity?.suppressed || 0);
    const primaryDepth = args.includeSuppressed ? depthTotal : depthUnsuppressed;
    if (primaryDepth > complexityThreshold) {
      if (depthSuppressed > 0) {
        console.log(`[depth ${primaryDepth} complexity] ${entry.file} (${depthUnsuppressed} unsuppressed, ${depthSuppressed} suppressed-block depth)`);
      } else {
        console.log(`[depth ${primaryDepth} complexity] ${entry.file}`);
      }
    }
    if (entry?.risk?.level === 'elevated') {
      console.log(`! elevated risk: ${entry.risk.downstream_consumers} downstream consumer(s)`);
    }
  });
}

function main() {
  const args = parseArgs(process.argv);
  const feature = args.feature || 'Current Task';
  const config = loadConfig();
  const result = detectGaps(feature, config, {
    record: args.record,
    persistSelfModel: args.persistSelfModel,
    zones: args.zones,
    aliases: args.aliases,
    profile: args.profile || undefined,
    metadata: args.metadata,
  });
  let codeGaps;
  try {
    codeGaps = args.since
      ? scanCodeGapDiff(config, args.since, { include_suppressed: args.includeSuppressed })
      : scanCodeGaps(config, { include_suppressed: args.includeSuppressed });
  } catch (err) {
    if (args.since) {
      console.error(`Unable to compute code-gap diff from ref "${args.since}": ${err.message}`);
      process.exit(1);
    }
    codeGaps = { mode: 'absolute', files: [], totals: {} };
  }
  codeGaps = annotateConsumerRisk(codeGaps, config);

  const salience = result.salience || null;
  const summary = salience?.summary || {};
  const ranked = Array.isArray(salience?.ranked) ? salience.ranked : [];
  const trendCounts = summarizeTrends(ranked);

  if (args.json && args.summaryOnly) {
    console.log(JSON.stringify({
      feature,
      detected_gaps: Array.isArray(result.gaps) ? result.gaps.length : 0,
      salience: {
        total_score: Number(summary.total_score || 0),
        delta_score: Number.isFinite(summary.delta_score) ? Number(summary.delta_score) : null,
        trend: String(summary.trend || 'new'),
        active_gaps: Number(summary.active_gaps || 0),
        resolved_gaps: Number(summary.resolved_gaps || 0),
        ship_blocked: Boolean(summary.ship_blocked),
      },
      temporal_delta: trendCounts,
      context: {
        max_lag_days: Number(summary.context_max_lag_days || 0),
      },
      code_gaps: args.since
        ? {
          mode: 'diff',
          since: args.since,
          deltas: Array.isArray(codeGaps?.changes) ? codeGaps.changes.length : 0,
          changed_files: Array.isArray(codeGaps?.changed_files) ? codeGaps.changed_files.length : 0,
        }
        : {
          mode: 'absolute',
          files: Array.isArray(codeGaps?.files) ? codeGaps.files.length : 0,
          total_any: args.includeSuppressed
            ? Number(codeGaps?.totals?.total_any || 0)
            : Number(codeGaps?.totals?.total_any_unsuppressed || 0),
          total_missing_tests: Number(codeGaps?.totals?.total_missing_tests || 0),
        },
    }, null, 2));
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({
      ...result,
      code_gaps: codeGaps,
    }, null, 2));
    return;
  }

  const gaps = Array.isArray(result.gaps) ? result.gaps : [];
  const evidence = result.evidence || {};
  const contextMap = evidence.context_map || null;

  if (args.summaryOnly) {
    console.log('SHERLOG GAP SUMMARY');
    console.log(`Feature: ${feature}`);
    console.log(`Detected gaps: ${gaps.length}`);
    console.log(`Salience total: ${Number(summary.total_score || 0).toFixed(2)} (${String(summary.trend || 'new')}, Δ ${formatDelta(summary.delta_score)})`);
    console.log(`Ship blocked: ${summary.ship_blocked ? 'yes' : 'no'}`);
    console.log(`Temporal delta: new ${trendCounts.new}, worsening ${trendCounts.worsening}, steady ${trendCounts.steady}, improving ${trendCounts.improving}`);
    if (Number(summary.context_max_lag_days || 0) > 0) {
      console.log(`Context lag max: ${Number(summary.context_max_lag_days).toFixed(1)} day(s)`);
    }
    if (args.since) {
      const deltas = Array.isArray(codeGaps?.changes) ? codeGaps.changes.length : 0;
      console.log(`Code-gap deltas: ${deltas} change(s) since ${args.since}`);
    } else {
      console.log(`Code-gap files: ${Array.isArray(codeGaps?.files) ? codeGaps.files.length : 0}`);
      const primaryAnyTotal = args.includeSuppressed
        ? Number(codeGaps?.totals?.total_any || 0)
        : Number(codeGaps?.totals?.total_any_unsuppressed || 0);
      console.log(`Code-gap total any: ${primaryAnyTotal}`);
    }
    return;
  }

  console.log('SHERLOG GAP ANALYSIS');
  console.log(`Feature: ${feature}`);
  console.log(`Detected gaps: ${gaps.length}`);
  if (gaps.length === 0) {
    console.log('- none');
  } else {
    gaps.forEach(gap => console.log(`- ${gap}`));
  }

  console.log('');
  console.log(`Implementation present: ${evidence.has_implementation ? 'yes' : 'no'}`);
  console.log(`Tests present: ${evidence.has_tests ? 'yes' : 'no'}`);
  if (evidence.docs_root) {
    console.log(`Docs present: ${evidence.has_docs ? 'yes' : 'no'} (${evidence.docs_root})`);
  }

  const matchedFeatureFiles = Array.isArray(evidence.matched_feature_files) ? evidence.matched_feature_files : [];
  console.log('');
  console.log('Matched feature files:');
  if (matchedFeatureFiles.length === 0) {
    console.log('- none');
  } else {
    matchedFeatureFiles.slice(0, 20).forEach(item => {
      const lane = item?.lane ? ` [${item.lane}]` : '';
      const source = item?.match_source ? ` via ${item.match_source}` : '';
      const triggers = Array.isArray(item?.triggers) && item.triggers.length > 0
        ? ` (${item.triggers.join(', ')})`
        : '';
      console.log(`- ${item.path}${lane}${source}${triggers}`);
    });
  }

  if (contextMap && contextMap.enabled) {
    console.log('');
    console.log('Context map checks:');
    console.log(`- Mode: ${contextMap.map_mode || 'none'}`);
    console.log(`- Map: ${contextMap.map_exists ? 'present' : 'missing'}${contextMap.map_valid === false ? ' (invalid)' : ''}`);
    console.log(`- Stale areas: ${(contextMap.stale_areas || []).length}`);
    console.log(`- Drift areas: ${(contextMap.drift_areas || []).length}`);
    console.log(`- Uncovered feature files: ${(contextMap.uncovered_feature_files || []).length}`);
    if (Array.isArray(contextMap.warnings) && contextMap.warnings.length > 0) {
      console.log(`- Context warnings: ${contextMap.warnings.length}`);
    }
  }

  if (salience) {
    const summary = salience.summary || {};
    const ranked = Array.isArray(salience.ranked) ? salience.ranked : [];
    const resolved = Array.isArray(salience.resolved) ? salience.resolved : [];

    console.log('');
    console.log('Salience:');
    console.log(`- Total score: ${Number(summary.total_score || 0).toFixed(2)} (${String(summary.trend || 'new')}, Δ ${formatDelta(summary.delta_score)})`);
    console.log(`- Active gaps: ${Number(summary.active_gaps || 0)} | Resolved since last run: ${Number(summary.resolved_gaps || 0)}`);
    console.log(`- Peak blast radius: L${Number(summary.blast_peak_level || 0)}`);
    const trendCounts = summarizeTrends(ranked);
    console.log(`- Temporal delta: new ${trendCounts.new}, worsening ${trendCounts.worsening}, steady ${trendCounts.steady}, improving ${trendCounts.improving}`);
    if (Number(summary.context_max_lag_days || 0) > 0) {
      console.log(`- Max temporal drift: ${Number(summary.context_max_lag_days).toFixed(1)} day(s)`);
    }
    if (Number(summary.code_rot_max_days || 0) >= 30) {
      console.log(`- Code rot: ${Number(summary.code_rot_max_days).toFixed(1)} untouched day(s) on live risk surfaces, peak multiplier ${Number(summary.code_rot_peak_multiplier || 1).toFixed(2)}x`);
    }
    if (Number(summary.dead_scaffold_feature_files || 0) > 0 || Number(summary.misleading_feature_files || 0) > 0) {
      console.log(`- Noise filter: ${summary.dead_scaffold_feature_files || 0} dead/scaffold, ${summary.misleading_feature_files || 0} misleading`);
    }
    if (Number(summary.expired_acknowledgements || 0) > 0 || Number(summary.audit_overdue_exemptions || 0) > 0) {
      console.log(`- Acknowledgement pressure: expired ${summary.expired_acknowledgements || 0}, audits overdue ${summary.audit_overdue_exemptions || 0}`);
    }

    if (ranked.length > 0) {
      console.log('');
      console.log('Ranked gaps:');
      ranked.forEach((item, index) => {
        const blastLevel = Number(item?.blast_radius?.level || 0);
        const blastScope = item?.blast_radius?.scope || 'local';
        const persistenceRuns = Number(item?.persistence?.consecutive_runs || 1);
        const codeRot = Number(item?.code_rot_multiplier || 1);
        console.log(
          `${index + 1}. ${item.gap} | score ${Number(item.score || 0).toFixed(2)} | Δ ${formatDelta(item.delta_score)} | blast L${blastLevel} (${blastScope}) | persistence ${persistenceRuns} run(s)${codeRot > 1 ? ` | code rot ${codeRot.toFixed(2)}x` : ''}`
        );
      });
    }

    if (resolved.length > 0) {
      console.log('');
      console.log('Resolved since previous comparison:');
      resolved.forEach(item => {
        console.log(`- ${item.gap} (prior score ${Number(item.previous_score || 0).toFixed(2)})`);
      });
    }

    if (salience.history) {
      console.log('');
      console.log(`History log: ${salience.history.path}`);
      console.log(`Recorded this run: ${salience.history.recorded ? 'yes' : 'no'}`);
    }
  }

  printCodeGapSection(codeGaps, args);
}

if (require.main === module) main();
