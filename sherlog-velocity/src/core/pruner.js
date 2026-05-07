/**
 * Sherlog data pruner — rolls up JSONL artifact entries older than a
 * configurable threshold into compact monthly summaries, then rewrites
 * the source file with only recent rows.
 *
 * Archive location: sherlog-velocity/data/archive/<source>-archive.jsonl
 * Each archive line is a { type: "monthly_rollup", month, source, ... } record.
 */

const fs = require('fs');
const path = require('path');
const { readJsonLines, resolveConfigPath } = require('./shared');

const DEFAULT_RAW_DAYS = 30;

// ─── helpers ───────────────────────────────────────────────────────────────

function toMonth(isoTimestamp) {
  return String(isoTimestamp || '').slice(0, 7); // "YYYY-MM"
}

function parseTimestamp(row, field) {
  const raw = row?.[field];
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function groupByMonth(rows, timestampField) {
  const map = new Map();
  for (const row of rows) {
    const ts = row?.[timestampField] || row?.startTime || row?.timestamp;
    const month = toMonth(ts);
    if (!month) continue;
    if (!map.has(month)) map.set(month, []);
    map.get(month).push(row);
  }
  return map;
}

function sumCounts(maps) {
  const result = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [key, value] of Object.entries(m)) {
      result[key] = (result[key] || 0) + (Number(value) || 0);
    }
  }
  return result;
}

function avg(values) {
  const nums = values.filter(v => Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

// ─── per-source rollup builders ────────────────────────────────────────────

function rollupGapHistory(month, rows) {
  const featureSeen = new Set();
  const gapTypeCounts = {};
  const totalScores = [];
  let latestByFeature = new Map();

  for (const row of rows) {
    const fk = String(row?.feature_key || row?.feature || '');
    if (fk) {
      featureSeen.add(fk);
      latestByFeature.set(fk, row);
    }
    for (const gap of Array.isArray(row?.gaps) ? row.gaps : []) {
      gapTypeCounts[gap] = (gapTypeCounts[gap] || 0) + 1;
    }
    const score = Number(row?.salience?.summary?.total_score);
    if (Number.isFinite(score)) totalScores.push(score);
  }

  return {
    type: 'monthly_rollup',
    source: 'gap-history',
    month,
    rolled_up_count: rows.length,
    features: uniqueSorted([...featureSeen]),
    gap_types_seen: gapTypeCounts,
    avg_total_score: avg(totalScores) !== null ? Number(avg(totalScores).toFixed(2)) : null,
    peak_total_score: totalScores.length ? Math.max(...totalScores) : null,
    feature_last_gaps: Object.fromEntries(
      [...latestByFeature.entries()].map(([fk, row]) => [fk, Array.isArray(row.gaps) ? row.gaps : []])
    ),
  };
}

function rollupSessionLog(month, rows) {
  const features = new Set();
  const types = {};
  let totalDuration = 0;
  const durations = [];

  for (const row of rows) {
    if (row?.feature) features.add(String(row.feature));
    const t = String(row?.type || 'implementation');
    types[t] = (types[t] || 0) + 1;
    const d = Number(row?.durationSeconds || 0);
    if (d > 0) { totalDuration += d; durations.push(d); }
  }

  return {
    type: 'monthly_rollup',
    source: 'session-log',
    month,
    rolled_up_count: rows.length,
    features: uniqueSorted([...features]),
    session_types: types,
    total_duration_seconds: Math.round(totalDuration),
    avg_duration_seconds: avg(durations) !== null ? Math.round(avg(durations)) : null,
  };
}

function rollupVelocityLog(month, rows) {
  const cpd = rows.map(r => Number(r?.commits_per_day_window)).filter(Number.isFinite);
  const cph = rows.map(r => Number(r?.commits_per_hour_active)).filter(Number.isFinite);
  const totalCommits = rows.map(r => Number(r?.total_commits)).filter(Number.isFinite);

  return {
    type: 'monthly_rollup',
    source: 'velocity-log',
    month,
    rolled_up_count: rows.length,
    avg_commits_per_day: avg(cpd) !== null ? Number(avg(cpd).toFixed(2)) : null,
    max_commits_per_day: cpd.length ? Math.max(...cpd) : null,
    avg_commits_per_hour_active: avg(cph) !== null ? Number(avg(cph).toFixed(2)) : null,
    peak_total_commits: totalCommits.length ? Math.max(...totalCommits) : null,
  };
}

function rollupHygieneHistory(month, rows) {
  const allByType = rows.map(r => r?.summary?.by_type || {});
  const combinedTypes = sumCounts(allByType);
  const totalFindings = rows.map(r => Number(r?.summary?.total_findings)).filter(Number.isFinite);
  const allGapTypes = new Set();
  for (const row of rows) {
    for (const g of Array.isArray(row?.gaps) ? row.gaps : []) allGapTypes.add(g);
  }

  return {
    type: 'monthly_rollup',
    source: 'hygiene-history',
    month,
    rolled_up_count: rows.length,
    gap_types_seen: uniqueSorted([...allGapTypes]),
    finding_types_aggregated: combinedTypes,
    avg_total_findings: avg(totalFindings) !== null ? Number(avg(totalFindings).toFixed(1)) : null,
    max_total_findings: totalFindings.length ? Math.max(...totalFindings) : null,
  };
}

function rollupRetrospectiveLog(month, rows) {
  const features = new Set();
  const interpretations = {};
  for (const row of rows) {
    if (row?.feature) features.add(String(row.feature));
    const interp = String(row?.comparison?.interpretation || '');
    if (interp) interpretations[interp] = (interpretations[interp] || 0) + 1;
  }

  return {
    type: 'monthly_rollup',
    source: 'retrospective-log',
    month,
    rolled_up_count: rows.length,
    features: uniqueSorted([...features]),
    interpretation_counts: interpretations,
  };
}

// ─── source definitions ────────────────────────────────────────────────────

const SOURCES = [
  {
    name: 'gap-history',
    configKey: 'gap_history_log',
    timestampField: 'timestamp',
    rollupFn: rollupGapHistory,
  },
  {
    name: 'session-log',
    // session-log lives in same data dir as velocity_log; resolved by deriving from that path
    configKey: null,
    deriveFrom: 'velocity_log',
    deriveName: 'session-log.jsonl',
    timestampField: 'startTime',
    rollupFn: rollupSessionLog,
  },
  {
    name: 'velocity-log',
    configKey: 'velocity_log',
    timestampField: 'timestamp',
    rollupFn: rollupVelocityLog,
  },
  {
    name: 'hygiene-history',
    configKey: 'hygiene_history_log',
    timestampField: 'timestamp',
    rollupFn: rollupHygieneHistory,
  },
  {
    name: 'retrospective-log',
    configKey: 'retrospective_log',
    timestampField: 'timestamp',
    rollupFn: rollupRetrospectiveLog,
  },
];

// ─── path resolution ───────────────────────────────────────────────────────

function resolveSourcePath(repoRoot, source, config) {
  if (source.configKey) {
    const p = resolveConfigPath(repoRoot, config?.paths?.[source.configKey]);
    if (p) return p;
  }
  if (source.deriveFrom) {
    const basePath = resolveConfigPath(repoRoot, config?.paths?.[source.deriveFrom]);
    if (basePath) return path.join(path.dirname(basePath), source.deriveName);
  }
  // Fallback: next to the data dir
  return path.resolve(repoRoot, 'sherlog-velocity', 'data', `${source.name}.jsonl`);
}

function resolveArchivePath(repoRoot, sourceName) {
  return path.resolve(repoRoot, 'sherlog-velocity', 'data', 'archive', `${sourceName}-archive.jsonl`);
}

// ─── single-source prune ───────────────────────────────────────────────────

function pruneSource(repoRoot, source, config, opts = {}) {
  const { rawDays = DEFAULT_RAW_DAYS, dryRun = false, rollup = true } = opts;
  const sourcePath = resolveSourcePath(repoRoot, source, config);

  if (!fs.existsSync(sourcePath)) {
    return { source: source.name, skipped: true, reason: 'file_not_found' };
  }

  const rows = readJsonLines(sourcePath);
  if (rows.length === 0) {
    return { source: source.name, skipped: true, reason: 'empty' };
  }

  const cutoffMs = Date.now() - rawDays * 86400000;
  const recent = [];
  const old = [];

  for (const row of rows) {
    const ts = parseTimestamp(row, source.timestampField);
    if (ts !== null && ts < cutoffMs) {
      old.push(row);
    } else {
      recent.push(row);
    }
  }

  if (old.length === 0) {
    return { source: source.name, skipped: true, reason: 'nothing_eligible', total: rows.length };
  }

  const byMonth = groupByMonth(old, source.timestampField);
  const rollupRecords = [];
  for (const [month, monthRows] of [...byMonth.entries()].sort()) {
    const record = {
      ...source.rollupFn(month, monthRows),
      rolled_up_at: new Date().toISOString(),
    };
    rollupRecords.push(record);
  }

  if (!dryRun) {
    if (rollup && rollupRecords.length > 0) {
      const archivePath = resolveArchivePath(repoRoot, source.name);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      const lines = rollupRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
      fs.appendFileSync(archivePath, lines, 'utf8');
    }
    // Rewrite source with recent rows only
    const newContent = recent.map(r => JSON.stringify(r)).join('\n') + (recent.length ? '\n' : '');
    fs.writeFileSync(sourcePath, newContent, 'utf8');
  }

  return {
    source: source.name,
    skipped: false,
    total_rows: rows.length,
    pruned_count: old.length,
    kept_count: recent.length,
    months_rolled_up: rollupRecords.length,
    rollup_records: rollupRecords,
    dry_run: dryRun,
  };
}

// ─── public API ────────────────────────────────────────────────────────────

/**
 * Prune all Sherlog JSONL data files.
 *
 * @param {object} config - resolved sherlog config
 * @param {object} opts
 * @param {number}  opts.rawDays   - entries older than this are rolled up (default 30)
 * @param {boolean} opts.dryRun   - report without writing (default false)
 * @param {boolean} opts.rollup   - build archive summaries (default true); if false, just drops old rows
 * @param {string}  opts.repoRoot - override repo root
 * @returns {{ results: Array, summary: object }}
 */
function pruneAll(config, opts = {}) {
  const repoRoot = opts.repoRoot || config?.repo_root || process.cwd();
  const rawDays = opts.rawDays ?? config?.settings?.retention?.raw_days ?? DEFAULT_RAW_DAYS;
  const rollup = opts.rollup ?? config?.settings?.retention?.rollup ?? true;
  const dryRun = opts.dryRun ?? false;

  const results = [];
  for (const source of SOURCES) {
    const result = pruneSource(repoRoot, source, config, { rawDays, dryRun, rollup });
    results.push(result);
  }

  const pruned = results.filter(r => !r.skipped);
  const summary = {
    total_sources: SOURCES.length,
    pruned_sources: pruned.length,
    skipped_sources: results.filter(r => r.skipped).length,
    total_rows_pruned: pruned.reduce((sum, r) => sum + (r.pruned_count || 0), 0),
    total_rows_kept: pruned.reduce((sum, r) => sum + (r.kept_count || 0), 0),
    months_rolled_up: pruned.reduce((sum, r) => sum + (r.months_rolled_up || 0), 0),
    raw_days_threshold: rawDays,
    rollup_enabled: rollup,
    dry_run: dryRun,
  };

  return { results, summary };
}

module.exports = { pruneAll, SOURCES, DEFAULT_RAW_DAYS };
