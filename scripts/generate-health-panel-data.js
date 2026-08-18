#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanCodeGaps, scanCodeGapDiff } = require('../sherlog-velocity/src/core/code-gaps');
const { scanHygiene } = require('../sherlog-velocity/src/core/hygiene');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTEXT_PATH = path.join(REPO_ROOT, 'sherlog.context.json');
const CONFIG_PATH = path.join(REPO_ROOT, 'sherlog-velocity', 'config', 'sherlog.config.json');
const GAP_HISTORY_PATH = path.join(REPO_ROOT, 'sherlog-velocity', 'data', 'gap-history.jsonl');
const VELOCITY_LOG_PATH = path.join(REPO_ROOT, 'sherlog-velocity', 'data', 'velocity-log.jsonl');
const HYGIENE_LOG_PATH = path.join(REPO_ROOT, 'sherlog-velocity', 'data', 'hygiene-history.jsonl');
const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'health-panel', 'health-panel-data.json');
const MODEL_VERSION = 2;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function validCommitish(value) {
  const text = String(value || '').trim();
  if (!text || text === 'unknown') return null;
  return text;
}

function resolveCommitBeforeTimestamp(timestamp) {
  if (!timestamp) return null;
  const result = spawnSync('git', ['rev-list', '-n', '1', `--before=${timestamp}`, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return validCommitish(String(result.stdout || '').trim());
}

function resolveCommitBeforeDateExpression(expr) {
  const result = spawnSync('git', ['rev-list', '-n', '1', `--before=${expr}`, 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return validCommitish(String(result.stdout || '').trim());
}

function resolveBaselineRef(gapHistory, velocityHistory) {
  const previousGap = gapHistory.length >= 2 ? gapHistory[gapHistory.length - 2] : null;
  const byGapTime = resolveCommitBeforeTimestamp(previousGap?.timestamp);
  if (byGapTime) return byGapTime;

  const previousGapEpoch = previousGap?.timestamp ? Date.parse(previousGap.timestamp) : null;
  const velocityCandidates = velocityHistory
    .map((entry) => ({
      epoch: Date.parse(entry.timestamp),
      head: validCommitish(entry.head),
    }))
    .filter((entry) => entry.head);

  if (Number.isFinite(previousGapEpoch)) {
    const nearest = velocityCandidates
      .filter((entry) => Number.isFinite(entry.epoch) && entry.epoch <= previousGapEpoch)
      .pop();
    if (nearest && nearest.head) return nearest.head;
  }

  if (velocityCandidates.length > 0) {
    return velocityCandidates[velocityCandidates.length - 1].head;
  }
  return null;
}

function gitIsoAtRef(repoRoot, ref) {
  if (!ref) return null;
  const result = spawnSync('git', ['show', '-s', '--format=%cI', ref], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || '').trim();
  return out || null;
}

function statusFromSalience(summary) {
  const score = toFiniteNumber(summary?.total_score, 0);
  const trend = String(summary?.trend || 'stable').toLowerCase();
  if (score >= 120 || (score >= 90 && trend === 'worsening')) {
    return {
      level: 'red',
      label: 'Needs Attention',
      reason: 'Structural pressure is high and trending in the wrong direction.',
    };
  }
  if (score >= 60 || trend === 'worsening') {
    return {
      level: 'yellow',
      label: 'Drift Building',
      reason: 'Pressure is manageable, but drift is starting to accumulate.',
    };
  }
  return {
    level: 'green',
    label: 'Stable',
    reason: 'No major stress pattern is building right now.',
  };
}

function globToRegex(glob) {
  const source = normalizePath(glob);
  const escaped = source
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compileZoneMatchers(context) {
  const zones = Array.isArray(context?.zones) ? context.zones : [];
  return zones.map((zone) => {
    const patterns = Array.isArray(zone?.paths) ? zone.paths : [];
    const matchers = patterns.map((pattern) => globToRegex(pattern));
    return {
      name: String(zone?.name || 'Unnamed Zone'),
      belief: String(zone?.belief || '').trim(),
      matchers,
    };
  });
}

function createZoneClassifier(compiledZones) {
  return (filePath) => {
    const normalized = normalizePath(filePath);
    for (const zone of compiledZones) {
      if (zone.matchers.some((regex) => regex.test(normalized))) return zone.name;
    }
    return 'Unmapped';
  };
}

function trendFromDelta(delta) {
  if (delta < 0) return 'improving';
  if (delta > 0) return 'degrading';
  return 'stable';
}

function arrowForTrend(trend) {
  if (trend === 'improving') return 'down';
  if (trend === 'degrading') return 'up';
  return 'flat';
}

function summarizeAcceleration(currentDelta, previousDelta) {
  const accel = toFiniteNumber(currentDelta, 0) - toFiniteNumber(previousDelta, 0);
  if (accel >= 2) return 'rising fast';
  if (accel > 0.4) return 'building';
  if (accel <= -2) return 'easing fast';
  if (accel < -0.4) return 'easing';
  return 'flat';
}

function percentChange(current, previous) {
  const prev = toFiniteNumber(previous, 0);
  if (Math.abs(prev) < 0.000001) return null;
  return ((toFiniteNumber(current, 0) - prev) / Math.abs(prev)) * 100;
}

function metricLine(label, delta, opts = {}) {
  const precision = Number.isFinite(opts.precision) ? opts.precision : 0;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.000001) {
    return `${label}: flat`;
  }
  const arrow = delta > 0 ? '↑' : '↓';
  const absDelta = Math.abs(delta);
  if (opts.percent) {
    return `${label}: ${arrow} ${absDelta.toFixed(precision)}% this week`;
  }
  if (opts.unitSuffix) {
    return `${label}: ${delta > 0 ? '+' : ''}${absDelta.toFixed(precision)} ${opts.unitSuffix} this week`;
  }
  return `${label}: ${arrow} ${absDelta.toFixed(precision)}`;
}

function pickPreviousFullHygieneEntry(history) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    const total = toFiniteNumber(entry?.summary?.total_findings, 0);
    const byType = entry?.summary?.by_type || {};
    if (total > 0 || Object.keys(byType).length > 0) return entry;
  }
  return null;
}

function sumDiffMetric(diffResult, metric) {
  return (diffResult?.changes || [])
    .filter((entry) => entry.metric === metric)
    .reduce((total, entry) => total + toFiniteNumber(entry.delta, 0), 0);
}

function fallbackDiffValues(codeGaps, diffResult, currentMissingDocs, previousMissingDocs) {
  const fileCount = Math.max(1, toFiniteNumber(codeGaps?.totals?.files, 1));
  const anyDeltaRaw = sumDiffMetric(diffResult, 'any');
  const complexityThreshold = toFiniteNumber(codeGaps?.thresholds?.complexity_depth, 5);
  const complexityDeltaRaw = (diffResult?.changes || [])
    .filter((entry) => entry.metric === 'complexity')
    .reduce((total, entry) => {
      const before = toFiniteNumber(entry.before, 0);
      const after = toFiniteNumber(entry.after, 0);
      if (before < complexityThreshold && after >= complexityThreshold) return total + 1;
      if (before >= complexityThreshold && after < complexityThreshold) return total - 1;
      return total;
    }, 0);
  return {
    any_density: anyDeltaRaw / fileCount,
    complexity_hotspots: complexityDeltaRaw,
    test_coverage_gaps: sumDiffMetric(diffResult, 'missing_tests'),
    undocumented_files: currentMissingDocs - previousMissingDocs,
  };
}

function currentMetricValues(codeGaps, currentMissingDocs) {
  const totals = codeGaps?.totals || {};
  const fileCount = Math.max(1, toFiniteNumber(totals.files, 1));
  return {
    any_density: toFiniteNumber(totals.total_any_unsuppressed, 0) / fileCount,
    complexity_hotspots: toFiniteNumber(totals.files_with_complexity, 0),
    test_coverage_gaps: toFiniteNumber(totals.total_missing_tests, 0),
    undocumented_files: toFiniteNumber(currentMissingDocs, 0),
  };
}

function metricMeta() {
  return {
    any_density: {
      label: 'Any density',
      unit: 'unsafe any per tracked file',
    },
    complexity_hotspots: {
      label: 'Complexity hotspots',
      unit: 'hotspot files',
    },
    test_coverage_gaps: {
      label: 'Untested files',
      unit: 'files missing direct test coverage',
    },
    undocumented_files: {
      label: 'Undocumented files',
      unit: 'files missing matching docs',
    },
  };
}

function buildMetricRows(currentValues, previousSnapshot, fallbackDeltas, options = {}) {
  const previousRows = Array.isArray(previousSnapshot?.metrics) ? previousSnapshot.metrics : [];
  const previousByKey = new Map(previousRows.map((row) => [row.key, row]));
  const meta = metricMeta();
  const useSnapshotComparison = options.use_snapshot_comparison !== false;
  return Object.keys(meta).map((key) => {
    const current = toFiniteNumber(currentValues[key], 0);
    const previousRow = previousByKey.get(key);
    const previousValue = (useSnapshotComparison && previousRow) ? toFiniteNumber(previousRow.value, 0) : null;
    const fallbackDelta = toFiniteNumber(fallbackDeltas[key], 0);
    const delta = Number((previousRow ? (current - previousValue) : fallbackDelta).toFixed(2));
    const trend = trendFromDelta(delta);
    const arrow = arrowForTrend(trend);
    const previousDelta = (useSnapshotComparison && previousRow) ? toFiniteNumber(previousRow.delta, 0) : 0;
    const acceleration = summarizeAcceleration(delta, previousDelta);
    return {
      key,
      label: meta[key].label,
      value: Number(current.toFixed(2)),
      unit: meta[key].unit,
      delta,
      trend,
      arrow,
      acceleration,
      previous_value: previousValue === null
        ? Math.max(0, Number((current - delta).toFixed(2)))
        : Math.max(0, Number(previousValue.toFixed(2))),
    };
  });
}

function createZoneState(compiledZones) {
  const state = new Map();
  compiledZones.forEach((zone) => {
    state.set(zone.name, {
      name: zone.name,
      belief: zone.belief,
      files: new Set(),
      any_total: 0,
      complexity_hotspots: 0,
      untested_files: 0,
      undocumented_files: 0,
      monolith_files: 0,
      delta_any_fallback: 0,
      delta_complexity_fallback: 0,
      delta_untested_fallback: 0,
      delta_undocumented_fallback: 0,
    });
  });
  if (!state.has('Unmapped')) {
    state.set('Unmapped', {
      name: 'Unmapped',
      belief: 'Files currently outside mapped context zones.',
      files: new Set(),
      any_total: 0,
      complexity_hotspots: 0,
      untested_files: 0,
      undocumented_files: 0,
      monolith_files: 0,
      delta_any_fallback: 0,
      delta_complexity_fallback: 0,
      delta_untested_fallback: 0,
      delta_undocumented_fallback: 0,
    });
  }
  return state;
}

function zoneStatus(pressureScore, directionScore, complexityDelta) {
  if (pressureScore >= 35 || complexityDelta >= 2) {
    return { level: 'red', label: 'Complexity rising fast' };
  }
  if (pressureScore >= 16 || directionScore > 0.2) {
    return { level: 'yellow', label: 'Drift accumulating' };
  }
  if (directionScore < -0.2) {
    return { level: 'green', label: 'Recovering' };
  }
  return { level: 'green', label: 'Stable' };
}

function buildSystemWeather(compiledZones, classifier, codeGaps, diffResult, hygieneFindings, previousSnapshot, options = {}) {
  const state = createZoneState(compiledZones);
  const complexityThreshold = toFiniteNumber(codeGaps?.thresholds?.complexity_depth, 5);

  const ensure = (name) => state.get(name) || state.get('Unmapped');

  (codeGaps?.files || []).forEach((entry) => {
    const file = normalizePath(entry.file);
    const zone = ensure(classifier(file));
    zone.files.add(file);
    zone.any_total += toFiniteNumber(entry?.any?.unsuppressed, 0);
    zone.untested_files += toFiniteNumber(entry?.missing_tests, 0);
    if (toFiniteNumber(entry?.complexity?.depth, 0) >= complexityThreshold) {
      zone.complexity_hotspots += 1;
    }
  });

  (hygieneFindings || []).forEach((finding) => {
    const file = normalizePath(finding?.file);
    const zone = ensure(classifier(file));
    zone.files.add(file);
    if (finding?.type === 'missing_docs') zone.undocumented_files += 1;
    if (finding?.type === 'monolith') zone.monolith_files += 1;
  });

  const undocumentedByFile = new Set(
    (hygieneFindings || [])
      .filter((item) => item?.type === 'missing_docs')
      .map((item) => normalizePath(item.file))
  );

  (diffResult?.changes || []).forEach((change) => {
    const file = normalizePath(change.file);
    const zone = ensure(classifier(file));
    zone.files.add(file);
    if (change.metric === 'any') zone.delta_any_fallback += toFiniteNumber(change.delta, 0);
    if (change.metric === 'missing_tests') zone.delta_untested_fallback += toFiniteNumber(change.delta, 0);
    if (change.metric === 'complexity') {
      const before = toFiniteNumber(change.before, 0);
      const after = toFiniteNumber(change.after, 0);
      if (before < complexityThreshold && after >= complexityThreshold) zone.delta_complexity_fallback += 1;
      if (before >= complexityThreshold && after < complexityThreshold) zone.delta_complexity_fallback -= 1;
    }
    if (undocumentedByFile.has(file)) zone.delta_undocumented_fallback += 1;
  });

  const previousSystems = new Map(
    (Array.isArray(previousSnapshot?.systems) ? previousSnapshot.systems : []).map((entry) => [entry.name, entry])
  );
  const useSnapshotComparison = options.use_snapshot_comparison !== false;

  const rows = Array.from(state.values())
    .filter((row) => row.name !== 'Unmapped' || row.files.size > 0)
    .map((row) => {
      const fileCount = Math.max(1, row.files.size);
      const anyDensity = row.any_total / fileCount;
      const previous = previousSystems.get(row.name);
      const previousMetrics = previous?.metrics || {};

      const prevAnyDensity = useSnapshotComparison && Number.isFinite(Number(previousMetrics.any_density))
        ? Number(previousMetrics.any_density)
        : null;
      const prevComplexity = useSnapshotComparison && Number.isFinite(Number(previousMetrics.complexity_hotspots))
        ? Number(previousMetrics.complexity_hotspots)
        : null;
      const prevUntested = useSnapshotComparison && Number.isFinite(Number(previousMetrics.untested_files))
        ? Number(previousMetrics.untested_files)
        : null;
      const prevUndocumented = useSnapshotComparison && Number.isFinite(Number(previousMetrics.undocumented_files))
        ? Number(previousMetrics.undocumented_files)
        : null;

      const deltaAnyDensity = prevAnyDensity === null
        ? row.delta_any_fallback / fileCount
        : anyDensity - prevAnyDensity;
      const deltaComplexity = prevComplexity === null
        ? row.delta_complexity_fallback
        : row.complexity_hotspots - prevComplexity;
      const deltaUntested = prevUntested === null
        ? row.delta_untested_fallback
        : row.untested_files - prevUntested;
      const deltaUndocumented = prevUndocumented === null
        ? row.delta_undocumented_fallback
        : row.undocumented_files - prevUndocumented;

      const pressureScore = Number((
        (anyDensity * 12)
        + (row.complexity_hotspots * 8)
        + (row.untested_files * 1.4)
        + (row.undocumented_files * 4)
        + (row.monolith_files * 5)
        + (Math.max(0, deltaAnyDensity) * 16)
        + (Math.max(0, deltaComplexity) * 8)
        + (Math.max(0, deltaUntested) * 3)
        + (Math.max(0, deltaUndocumented) * 4)
      ).toFixed(2));

      const directionScore = Number((
        (deltaAnyDensity * 6)
        + (deltaComplexity * 3)
        + (deltaUntested * 1.2)
        + (deltaUndocumented * 1.6)
      ).toFixed(2));

      const status = zoneStatus(pressureScore, directionScore, deltaComplexity);
      const direction = trendFromDelta(directionScore);
      const acceleration = summarizeAcceleration(directionScore, useSnapshotComparison ? toFiniteNumber(previous?.direction_score, 0) : 0);

      const anyPct = prevAnyDensity === null ? null : percentChange(anyDensity, prevAnyDensity);
      const lineAny = anyPct === null
        ? metricLine('Any density', deltaAnyDensity, { unitSuffix: 'density shift', precision: 2 })
        : metricLine('Any density', anyPct, { percent: true, precision: 1 });

      const lineComplexity = deltaComplexity === 0
        ? 'Complexity hotspots: flat'
        : `Complexity hotspots: ${deltaComplexity > 0 ? '+' : ''}${Math.abs(deltaComplexity)} ${deltaComplexity > 0 ? 'new this week' : 'fewer this week'}`;
      const lineUntested = deltaUntested === 0
        ? 'Untested files: flat'
        : `Untested files: ${deltaUntested > 0 ? '+' : ''}${Math.abs(deltaUntested)} ${deltaUntested > 0 ? 'new this week' : 'closed this week'}`;

      let focus = 'Watch recent file changes for early drift.';
      if (Math.max(row.complexity_hotspots, row.monolith_files) > 0) {
        focus = 'Focus on complexity hotspots before adding new features.';
      } else if (row.untested_files > 0) {
        focus = 'Add tests to stop silent regressions from piling up.';
      } else if (row.undocumented_files > 0) {
        focus = 'Document changed modules to reduce context drift.';
      }

      return {
        name: row.name,
        belief: row.belief,
        status: status.level,
        status_label: status.label,
        direction,
        acceleration,
        direction_score: directionScore,
        pressure_score: pressureScore,
        where_to_look: focus,
        lines: [lineAny, lineComplexity, lineUntested],
        metrics: {
          any_density: Number(anyDensity.toFixed(3)),
          complexity_hotspots: row.complexity_hotspots,
          untested_files: row.untested_files,
          undocumented_files: row.undocumented_files,
        },
      };
    })
    .sort((a, b) => b.pressure_score - a.pressure_score);

  return rows;
}

function driftScore(metrics, previousSnapshot, options = {}) {
  const useSnapshotComparison = options.use_snapshot_comparison !== false;
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const anyDensity = toFiniteNumber(byKey.get('any_density')?.value, 0);
  const complexity = toFiniteNumber(byKey.get('complexity_hotspots')?.value, 0);
  const tests = toFiniteNumber(byKey.get('test_coverage_gaps')?.value, 0);
  const docs = toFiniteNumber(byKey.get('undocumented_files')?.value, 0);

  const deltaPenalty = metrics.reduce((total, metric) => (
    total
    + Math.max(0, toFiniteNumber(metric.delta, 0))
  ), 0);

  const raw = (anyDensity * 10) + (complexity * 8) + (tests * 1.2) + (docs * 4) + deltaPenalty;
  const value = Math.max(0, Math.min(100, Math.round(raw)));

  const previous = useSnapshotComparison
    ? toFiniteNumber(previousSnapshot?.structural_drift_score?.value, NaN)
    : NaN;
  const previousValue = Number.isFinite(previous) ? previous : null;
  const previousDelta = useSnapshotComparison
    ? toFiniteNumber(previousSnapshot?.structural_drift_score?.delta, 0)
    : 0;
  const delta = previousValue === null ? null : Number((value - previousValue).toFixed(2));
  const aggregateMetricDelta = metrics.reduce((sum, item) => sum + toFiniteNumber(item.delta, 0), 0);
  const trend = previousValue === null
    ? trendFromDelta(aggregateMetricDelta)
    : trendFromDelta(delta);
  const acceleration = previousValue === null ? 'flat' : summarizeAcceleration(delta, previousDelta);

  let answer;
  if (trend === 'degrading') answer = 'You are getting sloppier right now.';
  else if (trend === 'improving') answer = 'You are getting sharper right now.';
  else answer = 'You are holding steady right now.';

  return {
    value,
    previous: previousValue,
    delta,
    trend,
    acceleration,
    answer,
  };
}

function recurringGaps(gapHistory, window = 6) {
  const recent = gapHistory.slice(-window);
  const counts = new Map();
  recent.forEach((entry) => {
    (entry?.gaps || []).forEach((gap) => {
      counts.set(gap, (counts.get(gap) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([gap, count]) => `${humanGapName(gap)} appeared in ${count} of the last ${recent.length} runs.`);
}

function humanGapName(key) {
  const labels = {
    test_coverage: 'Test coverage pressure',
    integration: 'Integration risk',
    stale_context: 'Stale context risk',
    context_drift: 'Context drift risk',
    missing_bundle: 'Missing bundle risk',
    arch_monolith: 'Monolith risk',
    arch_missing_docs: 'Documentation risk',
    documentation: 'Documentation risk',
    missing_implementation: 'Implementation gap risk',
  };
  return labels[key] || String(key).replace(/_/g, ' ');
}

function patternAnswers(latestGap, previousGap, gapHistory, systems, metrics) {
  const latestSummary = latestGap?.salience?.summary || {};
  const previousSummary = previousGap?.salience?.summary || {};
  const lagDays = toFiniteNumber(latestSummary.context_max_lag_days, 0);
  const unresolved = toFiniteNumber(latestSummary.active_gaps, 0);
  const previousUnresolved = toFiniteNumber(previousSummary.active_gaps, unresolved);

  const recurring = recurringGaps(gapHistory);
  const latestGaps = new Set(Array.isArray(latestGap?.gaps) ? latestGap.gaps : []);
  const previousGaps = new Set(Array.isArray(previousGap?.gaps) ? previousGap.gaps : []);
  const newRisks = Array.from(latestGaps).filter((gap) => !previousGaps.has(gap));
  const improvingMetrics = metrics.filter((metric) => metric.trend === 'improving');

  const weakestSystem = systems[0];

  return {
    aging: lagDays > 0
      ? `${lagDays.toFixed(1)} day(s) of context lag are aging in the map, with ${unresolved} active gaps still open.`
      : `${unresolved} active gaps remain open and need explicit closure.`,
    recurring: recurring.length > 0
      ? recurring[0]
      : 'No recurring gap pattern is visible yet.',
    new_risky: newRisks.length > 0
      ? `${humanGapName(newRisks[0])} is newly elevated in this run.`
      : (weakestSystem ? `${weakestSystem.name} is the hottest stress zone right now.` : 'No new risk spikes detected.'),
    interventions: improvingMetrics.length > 0
      ? `${improvingMetrics[0].label} is improving, so recent interventions are helping.`
      : (unresolved <= previousUnresolved
        ? 'Interventions are containing drift, but no clear improvement trend yet.'
        : 'Interventions are not yet reversing drift; prioritize the hottest zone first.'),
  };
}

function topChanges(latestGap, previousGap, metrics, systems) {
  const changes = [];
  const latestSummary = latestGap?.salience?.summary || {};
  const previousSummary = previousGap?.salience?.summary || {};

  if (previousGap) {
    const currentTotal = toFiniteNumber(latestSummary.total_score, 0);
    const previousTotal = toFiniteNumber(previousSummary.total_score, 0);
    const delta = Number((currentTotal - previousTotal).toFixed(2));
    if (delta !== 0) {
      changes.push({
        weight: Math.abs(delta),
        text: `Overall structural pressure ${delta > 0 ? 'rose' : 'fell'} by ${Math.abs(delta).toFixed(2)} points.`,
      });
    }
  }

  const sameFeature = String(latestGap?.feature_key || '') === String(previousGap?.feature_key || '');
  if (!sameFeature && previousGap) {
    changes.push({
      weight: 90,
      text: `This run targets "${latestGap?.feature || 'current feature'}", replacing "${previousGap?.feature || 'previous feature'}".`,
    });
  }

  metrics.forEach((metric) => {
    const delta = toFiniteNumber(metric.delta, 0);
    if (Math.abs(delta) < 0.000001) return;
    changes.push({
      weight: Math.abs(delta),
      text: `${metric.label} ${delta > 0 ? 'worsened' : 'improved'} by ${Math.abs(delta).toFixed(2)}.`,
    });
  });

  systems.slice(0, 2).forEach((system) => {
    changes.push({
      weight: toFiniteNumber(system.pressure_score, 0),
      text: `${system.name} is now ${system.status_label.toLowerCase()} (${system.acceleration}).`,
    });
  });

  if (changes.length === 0) {
    return ['No major movement since the last Sherlog run.'];
  }

  return changes
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5)
    .map((entry) => entry.text);
}

function trendLineSummary(metrics) {
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const anyDensity = byKey.get('any_density');
  const complexity = byKey.get('complexity_hotspots');
  const tests = byKey.get('test_coverage_gaps');
  const docs = byKey.get('undocumented_files');

  let anyLine = 'Any density: flat';
  if (anyDensity) {
    const previousValue = toFiniteNumber(anyDensity.previous_value, 0);
    const pct = percentChange(anyDensity.value, previousValue);
    anyLine = pct === null
      ? (anyDensity.delta === 0 ? 'Any density: flat' : `Any density: ${anyDensity.delta > 0 ? '↑' : '↓'} from near-zero baseline`)
      : metricLine('Any density', pct, { percent: true, precision: 1 });
  }
  const complexityLine = complexity
    ? (complexity.delta === 0
      ? 'Complexity hotspots: flat'
      : `Complexity hotspots: ${complexity.delta > 0 ? '+' : ''}${Math.abs(complexity.delta)} ${complexity.delta > 0 ? 'new this week' : 'fewer this week'}`)
    : 'Complexity hotspots: flat';
  const testLine = tests
    ? (tests.delta === 0
      ? 'Untested files: flat'
      : `Untested files: ${tests.delta > 0 ? '+' : ''}${Math.abs(tests.delta)} ${tests.delta > 0 ? 'new this week' : 'closed this week'}`)
    : 'Untested files: flat';
  const docsLine = docs
    ? (docs.delta === 0
      ? 'Undocumented files: flat'
      : `Undocumented files: ${docs.delta > 0 ? '+' : ''}${Math.abs(docs.delta)} ${docs.delta > 0 ? 'new this week' : 'closed this week'}`)
    : 'Undocumented files: flat';

  return [anyLine, complexityLine, testLine, docsLine];
}

function latestRepoName(repoRoot) {
  const parsed = path.parse(repoRoot);
  return parsed.base || repoRoot;
}

function main() {
  const context = readJson(CONTEXT_PATH, { zones: [] });
  const config = readJson(CONFIG_PATH, {});
  const repoRoot = config?.repo_root || REPO_ROOT;
  const gapHistory = readJsonLines(GAP_HISTORY_PATH);
  const velocityHistory = readJsonLines(VELOCITY_LOG_PATH);
  const hygieneHistory = readJsonLines(HYGIENE_LOG_PATH);
  const previousSnapshot = readJson(OUTPUT_PATH, null);
  const compatibleSnapshot = previousSnapshot?.model_version === MODEL_VERSION ? previousSnapshot : null;

  const latestGap = gapHistory[gapHistory.length - 1] || {};
  const previousGap = gapHistory.length >= 2 ? gapHistory[gapHistory.length - 2] : null;
  const sameGapAsPreviousSnapshot = (
    compatibleSnapshot
    && String(compatibleSnapshot.latest_gap_timestamp || '') === String(latestGap?.timestamp || '')
  );
  const useSnapshotComparison = !sameGapAsPreviousSnapshot;
  const baselineRef = resolveBaselineRef(gapHistory, velocityHistory);
  const weeklyRef = resolveCommitBeforeDateExpression('7 days ago');

  let diffResult = { changed_files: [], changes: [] };
  try {
    if (baselineRef) {
      diffResult = scanCodeGapDiff(config, baselineRef, { include_suppressed: false });
    }
  } catch {
    diffResult = { changed_files: [], changes: [] };
  }

  let weeklyDiffResult = { changed_files: [], changes: [] };
  try {
    if (weeklyRef) {
      weeklyDiffResult = scanCodeGapDiff(config, weeklyRef, { include_suppressed: false });
    }
  } catch {
    weeklyDiffResult = { changed_files: [], changes: [] };
  }

  const codeGaps = scanCodeGaps(config, { include_suppressed: false });
  const liveHygiene = scanHygiene({ ...config, repo_root: REPO_ROOT }, { record: false });
  const hygieneFindings = Array.isArray(liveHygiene?.findings) ? liveHygiene.findings : [];
  const currentMissingDocs = toFiniteNumber(liveHygiene?.summary?.by_type?.missing_docs, 0);
  const previousHygiene = pickPreviousFullHygieneEntry(hygieneHistory);
  const previousMissingDocs = toFiniteNumber(previousHygiene?.summary?.by_type?.missing_docs, currentMissingDocs);

  const currentValues = currentMetricValues(codeGaps, currentMissingDocs);
  const fallbackDeltas = fallbackDiffValues(codeGaps, weeklyDiffResult, currentMissingDocs, previousMissingDocs);
  const metrics = buildMetricRows(currentValues, compatibleSnapshot, fallbackDeltas, {
    use_snapshot_comparison: useSnapshotComparison,
  });

  const compiledZones = compileZoneMatchers(context);
  const zoneClassifier = createZoneClassifier(compiledZones);
  const systems = buildSystemWeather(
    compiledZones,
    zoneClassifier,
    codeGaps,
    weeklyDiffResult,
    hygieneFindings,
    compatibleSnapshot,
    { use_snapshot_comparison: useSnapshotComparison }
  );

  const drift = driftScore(metrics, compatibleSnapshot, {
    use_snapshot_comparison: useSnapshotComparison,
  });
  const patterns = patternAnswers(latestGap, previousGap, gapHistory, systems, metrics);
  const changelog = topChanges(latestGap, previousGap, metrics, systems);
  const trendLines = trendLineSummary(metrics);
  const summaryStatus = statusFromSalience(latestGap?.salience?.summary || {});

  const output = {
    model_version: MODEL_VERSION,
    generated_at: new Date().toISOString(),
    sources: {
      context: path.relative(REPO_ROOT, CONTEXT_PATH),
      gaps: path.relative(REPO_ROOT, GAP_HISTORY_PATH),
      velocity: path.relative(REPO_ROOT, VELOCITY_LOG_PATH),
      hygiene: path.relative(REPO_ROOT, HYGIENE_LOG_PATH),
    },
    repo: {
      name: latestRepoName(repoRoot),
      path: repoRoot,
      status: summaryStatus.level,
      status_label: summaryStatus.label,
      status_reason: summaryStatus.reason,
      salience_score: toFiniteNumber(latestGap?.salience?.summary?.total_score, 0),
      salience_trend: String(latestGap?.salience?.summary?.trend || 'stable'),
    },
    baseline: {
      label: baselineRef ? `Compared against commit ${baselineRef.slice(0, 8)}` : 'No baseline commit available',
      ref: baselineRef,
      changed_files: Array.isArray(diffResult?.changed_files) ? diffResult.changed_files.length : 0,
      commit_timestamp: gitIsoAtRef(repoRoot, baselineRef),
      trend_window: weeklyRef ? `Weekly trend baseline: ${weeklyRef.slice(0, 8)}` : 'Weekly trend baseline unavailable',
    },
    structural_drift_score: drift,
    trend_lines: trendLines,
    metrics,
    systems,
    where_to_look_first: systems.slice(0, 2).map((system) => ({
      name: system.name,
      status: system.status_label,
      reason: system.where_to_look,
    })),
    patterns,
    changelog,
    latest_feature: latestGap?.feature || null,
    latest_gap_timestamp: latestGap?.timestamp || null,
  };

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
