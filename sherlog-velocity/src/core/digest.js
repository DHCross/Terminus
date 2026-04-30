const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  readJsonLines,
  resolveConfigPath,
  resolveRepoRoot,
} = require('./shared');
const { getSelfModel, resolveSelfModelPath } = require('./self-model');

function normalizeFeatureKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function repoName(repoRoot) {
  return path.parse(repoRoot || process.cwd()).base || 'repository';
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function resolveGapHistoryPath(repoRoot, config = {}) {
  const configured = resolveConfigPath(repoRoot, config?.paths?.gap_history_log);
  if (configured) return configured;
  return path.resolve(__dirname, '../../data/gap-history.jsonl');
}

function loadGapHistory(repoRoot, config = {}) {
  const historyPath = resolveGapHistoryPath(repoRoot, config);
  return {
    path: historyPath,
    rows: readJsonLines(historyPath).filter(Boolean),
  };
}

function parseRowTime(row) {
  const value = row?.timestamp || row?.recorded_at;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function rowsSorted(rows = []) {
  return [...rows].sort((left, right) => (parseRowTime(left) || 0) - (parseRowTime(right) || 0));
}

function rowsForFeature(rows = [], featureKey) {
  if (!featureKey) return rowsSorted(rows);
  return rowsSorted(rows).filter(row => normalizeFeatureKey(row?.feature_key || row?.feature) === featureKey);
}

function selectDigestRuns(rows = [], feature, windowDays = 7) {
  const sorted = rowsSorted(rows);
  if (sorted.length === 0) return { current: null, baseline: null, feature_key: null };

  const requestedFeatureKey = normalizeFeatureKey(feature);
  const current = requestedFeatureKey
    ? rowsForFeature(sorted, requestedFeatureKey).at(-1) || null
    : sorted[sorted.length - 1] || null;
  if (!current) return { current: null, baseline: null, feature_key: requestedFeatureKey || null };

  const featureKey = normalizeFeatureKey(current?.feature_key || current?.feature);
  const baselineTarget = (parseRowTime(current) || Date.now()) - (windowDays * 86400000);
  const baseline = rowsForFeature(sorted, featureKey)
    .filter(row => (parseRowTime(row) || 0) <= baselineTarget)
    .at(-1) || null;

  return { current, baseline, feature_key: featureKey };
}

function rankedMap(row) {
  const ranked = Array.isArray(row?.salience?.ranked) ? row.salience.ranked : [];
  return new Map(
    ranked
      .map(item => [String(item?.gap || '').trim(), item])
      .filter(([gap]) => Boolean(gap))
  );
}

function coerceFeatureRiskSummary(row) {
  const codeIndex = row?.evidence?.code_index;
  if (!codeIndex || typeof codeIndex !== 'object') return null;
  if (codeIndex?.feature_risk?.summary) return codeIndex.feature_risk.summary;
  if (codeIndex?.summary && codeIndex?.matched_modules) return codeIndex.summary;
  return codeIndex;
}

function findTopGapDelta(current, baseline) {
  const currentRanked = rankedMap(current);
  const baselineRanked = rankedMap(baseline);
  const candidates = [];

  currentRanked.forEach((item, gap) => {
    const currentScore = Number(item?.score || 0);
    const previousScore = Number(baselineRanked.get(gap)?.score || 0);
    const delta = round(currentScore - previousScore);
    candidates.push({
      gap,
      current_score: currentScore,
      previous_score: previousScore,
      delta_score: delta,
      trend: item?.trend || (delta > 0 ? 'worsening' : delta < 0 ? 'improving' : 'steady'),
    });
  });

  return candidates
    .sort((left, right) => right.delta_score - left.delta_score || right.current_score - left.current_score)
    .find(item => item.delta_score > 0) || null;
}

function findPersistentRisk(current) {
  const ranked = Array.isArray(current?.salience?.ranked) ? current.salience.ranked : [];
  return ranked
    .filter(item => Number(item?.persistence?.age_days || 0) >= 7 || Number(item?.persistence?.consecutive_runs || 0) >= 2)
    .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))[0] || null;
}

function findCodeRotRisk(current) {
  const ranked = Array.isArray(current?.salience?.ranked) ? current.salience.ranked : [];
  return ranked
    .filter(item => Number(item?.code_rot_multiplier || 1) > 1)
    .sort((left, right) => Number(right?.code_rot_multiplier || 1) - Number(left?.code_rot_multiplier || 1))[0] || null;
}

function computeTotalScoreDelta(current, baseline) {
  const currentTotal = Number(current?.salience?.summary?.total_score || 0);
  const baselineTotal = Number(baseline?.salience?.summary?.total_score || 0);
  if (!(baselineTotal > 0)) {
    return {
      current_total: currentTotal,
      baseline_total: baselineTotal || null,
      delta_score: null,
      delta_pct: null,
    };
  }

  const deltaScore = round(currentTotal - baselineTotal);
  return {
    current_total: currentTotal,
    baseline_total: baselineTotal,
    delta_score: deltaScore,
    delta_pct: round((deltaScore / baselineTotal) * 100, 1),
  };
}

function summarizeSelfModel(model) {
  if (!model || typeof model !== 'object') return null;
  const counts = model?.summary?.liveness_counts || {};
  return {
    total_modules: Number(model?.summary?.total_modules || 0),
    total_edges: Number(model?.summary?.total_edges || 0),
    fragile_file_count: Number(model?.summary?.fragile_file_count || 0),
    dead_or_scaffold_files: Number(model?.summary?.dead_or_scaffold_files || 0),
    stale_live_file_count: Number(model?.summary?.stale_live_file_count || 0),
    liveness_counts: counts,
    stale_live_files: Array.isArray(model?.stale_live_files) ? model.stale_live_files.slice(0, 5) : [],
  };
}

function buildDigestFacts(config, options = {}) {
  const repoRoot = resolveRepoRoot(config?.repo_root, process.cwd());
  const history = loadGapHistory(repoRoot, config);
  const runSelection = selectDigestRuns(history.rows, options.feature, options.window_days || 7);
  const selfModelResult = getSelfModel(repoRoot, {
    config,
    selfModelPath: resolveSelfModelPath(repoRoot, { config }),
    sourceRoots: Array.isArray(config?.paths?.source_roots) ? config.paths.source_roots : undefined,
    persist: true,
  });
  const current = runSelection.current;
  const baseline = runSelection.baseline;
  const currentFeature = current?.feature || options.feature || 'Repository Health';
  const currentFeatureRisk = coerceFeatureRiskSummary(current);
  const totalDelta = computeTotalScoreDelta(current, baseline);

  return {
    repo_name: repoName(repoRoot),
    repo_root: repoRoot,
    generated_at: new Date().toISOString(),
    comparison_window_days: options.window_days || 7,
    feature: currentFeature,
    current_timestamp: current?.timestamp || null,
    baseline_timestamp: baseline?.timestamp || null,
    comparison_available: Boolean(current && baseline),
    current_summary: current?.salience?.summary || null,
    baseline_summary: baseline?.salience?.summary || null,
    total_delta: totalDelta,
    top_gap_delta: current ? findTopGapDelta(current, baseline) : null,
    persistent_risk: current ? findPersistentRisk(current) : null,
    code_rot_risk: current ? findCodeRotRisk(current) : null,
    feature_risk: currentFeatureRisk,
    self_model: summarizeSelfModel(selfModelResult.model),
    history_rows: history.rows.length,
  };
}

function gapLabel(gap) {
  return String(gap || '').replace(/_/g, ' ');
}

function renderDeterministicDigest(facts) {
  const lines = [];
  const heading = facts?.feature ? `${facts.repo_name}: ${facts.feature}` : facts.repo_name;
  lines.push(`# 🩺 Sherlog Health Digest`);
  lines.push(`**Subject:** \`${heading}\``);
  lines.push(`**Generated:** ${facts.generated_at}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push(`### 📊 Risk Overview`);
  const totalDelta = facts?.total_delta || {};
  if (facts?.comparison_available && Number.isFinite(totalDelta?.delta_pct)) {
    const icon = totalDelta.delta_score > 0 ? '📈' : totalDelta.delta_score < 0 ? '📉' : '➡️';
    const directionStr = totalDelta.delta_score > 0 ? 'Worsened by' : totalDelta.delta_score < 0 ? 'Improved by' : 'Held flat at';
    lines.push(
      `- **Overall Liability:** ${icon} ${directionStr} ${Math.abs(totalDelta.delta_pct)}% WoW (${totalDelta.baseline_total} -> ${totalDelta.current_total})`
    );
  } else if (facts?.current_summary?.total_score) {
    lines.push(
      `- **Overall Liability:** ${facts.current_summary.total_score} points in the latest scan`
    );
  } else {
    lines.push(`- **Overall Liability:** No comparable ${facts.comparison_window_days}-day baseline exists yet`);
  }
  if (facts?.current_summary?.active_gaps !== undefined) {
    lines.push(`- **Active Gaps:** ${facts.current_summary.active_gaps}`);
  }
  lines.push('');

  lines.push(`### 🚨 Critical Vulnerabilities`);
  let hasVulns = false;
  if (facts?.top_gap_delta) {
    lines.push(
      `- **Fastest Worsening:** 📉 \`${gapLabel(facts.top_gap_delta.gap)}\` (+${facts.top_gap_delta.delta_score} points WoW)`
    );
    hasVulns = true;
  }
  if (facts?.persistent_risk) {
    const ageDays = Number(facts.persistent_risk?.persistence?.age_days || 0);
    const timeFrame = ageDays ? `${ageDays} days` : `${facts.persistent_risk.persistence.consecutive_runs} runs`;
    lines.push(
      `- **Persistent Noise:** 🟡 \`${gapLabel(facts.persistent_risk.gap)}\` (Ignored for ${timeFrame}, still scoring ${facts.persistent_risk.score})`
    );
    hasVulns = true;
  }
  if (facts?.code_rot_risk) {
    lines.push(
      `- **Code Rot:** 🔴 \`${gapLabel(facts.code_rot_risk.gap)}\` (Untouched active surfaces amplifying salience ${facts.code_rot_risk.code_rot_multiplier}x)`
    );
    hasVulns = true;
  }
  if (!hasVulns) lines.push(`- 🟢 None detected in this window.`);
  lines.push('');

  lines.push(`### 🧹 Structural Bloat`);
  let hasBloat = false;
  const featureRisk = facts?.feature_risk;
  
  const deadCount = featureRisk && Number(featureRisk.dead_or_scaffold_files || 0) > 0 
    ? featureRisk.dead_or_scaffold_files 
    : (facts?.self_model ? Number(facts.self_model.dead_or_scaffold_files || 0) : 0);

  if (deadCount > 0) {
    lines.push(
      `- **Dead/Scaffold:** 🟢 ${deadCount} file${deadCount === 1 ? '' : 's'} (Context bloat rather than live risk)`
    );
    hasBloat = true;
  }
  
  const misleadingCount = featureRisk && Number(featureRisk.misleading_files || 0) > 0
    ? featureRisk.misleading_files
    : 0;
  if (misleadingCount > 0) {
    lines.push(
      `- **Misleading:** 🔴 ${misleadingCount} file${misleadingCount === 1 ? '' : 's'} (Wired but carries placeholder signals)`
    );
    hasBloat = true;
  }
  
  if (facts?.self_model?.fragile_file_count > 0) {
    lines.push(
      `- **Fragile Files:** 🟡 ${facts.self_model.fragile_file_count} file${facts.self_model.fragile_file_count === 1 ? '' : 's'} (Elevated churn, size, or coupling)`
    );
    hasBloat = true;
  }
  if (!hasBloat) lines.push(`- 🟢 Codebase structure looks clean.`);

  return lines.join('\n');
}

function buildDigestPrompt(facts) {
  return [
    'Write a concise founder-facing weekly engineering digest in markdown.',
    'Focus on visual hierarchy. Use structural headers: `### 📊 Risk Overview`, `### 🚨 Critical Vulnerabilities`, and `### 🧹 Structural Bloat`.',
    'Use emojis for trend indicators (e.g., 📈, 📉, 🔴, 🟡, 🟢) and clear risk framing.',
    'Translate raw code risk into business narrative.',
    'Prefer urgency, persistence, and noise reduction over implementation trivia.',
    '',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const pieces = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  output.forEach(item => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach(part => {
      const text = part?.text || part?.output_text || null;
      if (typeof text === 'string' && text.trim()) pieces.push(text.trim());
    });
  });
  return pieces.join('\n\n').trim() || null;
}

async function renderDigestWithOpenAI(facts, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model || process.env.SHERLOG_DIGEST_MODEL || 'gpt-4.1-mini',
      input: buildDigestPrompt(facts),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI digest request failed: ${response.status}`);
  }

  const payload = await response.json();
  return extractResponseText(payload);
}

function renderDigestWithCommand(facts, command) {
  if (!command) return null;
  const output = execSync(command, {
    input: `${buildDigestPrompt(facts)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return output || null;
}

async function draftWeeklyDigest(config, options = {}) {
  const facts = buildDigestFacts(config, options);
  let markdown = renderDeterministicDigest(facts);
  let mode = 'deterministic';

  if (options.no_llm !== true) {
    try {
      const commandDigest = renderDigestWithCommand(facts, options.llm_command || process.env.SHERLOG_DIGEST_LLM_COMMAND);
      if (commandDigest) {
        markdown = commandDigest;
        mode = 'llm-command';
      } else {
        const llmDigest = await renderDigestWithOpenAI(facts, options);
        if (llmDigest) {
          markdown = llmDigest;
          mode = 'openai';
        }
      }
    } catch {
      mode = 'deterministic';
    }
  }

  return {
    markdown,
    mode,
    facts,
  };
}

module.exports = {
  buildDigestFacts,
  draftWeeklyDigest,
  renderDeterministicDigest,
  selectDigestRuns,
};
