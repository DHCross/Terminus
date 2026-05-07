const fs = require('fs');
const path = require('path');
const { readJsonLines, resolveConfigPath } = require('./shared');

const SONAR_PLACEHOLDER_PATTERN = /^<.+>$/;
const STALE_CONTEXT_DAYS = 30;
const STALE_SELF_MODEL_HOURS = 24;
const MIN_RELIABLE_VELOCITY_RUNS = 5;
const MIN_RELIABLE_GAP_RUNS = 5;
const MIN_DEGRADED_GAP_RUNS = 2;
const MIN_RELIABLE_HYGIENE_RUNS = 3;

function ageInHours(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  return ms / (1000 * 60 * 60);
}

function humanAge(isoString) {
  const hours = ageInHours(isoString);
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function resolveDataPath(repoRoot, config, key, defaultRelative) {
  const configured = resolveConfigPath(repoRoot, config?.paths?.[key]);
  if (configured) return configured;
  return path.join(repoRoot, defaultRelative);
}

function checkEstimates(repoRoot, config) {
  const logPath = resolveDataPath(repoRoot, config, 'velocity_log', 'sherlog-velocity/data/velocity-log.jsonl');
  const rows = readJsonLines(logPath);
  const count = rows.length;

  if (count === 0) {
    return { status: 'offline', detail: 'no velocity runs recorded', note: 'run `npm run velocity:run` to seed history' };
  }
  if (count < MIN_RELIABLE_VELOCITY_RUNS) {
    return { status: 'degraded', detail: `${count} velocity run${count === 1 ? '' : 's'}`, note: `need ${MIN_RELIABLE_VELOCITY_RUNS}+ for reliable estimates` };
  }
  return { status: 'reliable', detail: `${count} velocity runs`, note: null };
}

function checkDigest(repoRoot, config) {
  const logPath = resolveDataPath(repoRoot, config, 'gap_history_log', 'sherlog-velocity/data/gap-history.jsonl');
  const rows = readJsonLines(logPath);
  const count = rows.length;

  if (count === 0) {
    return { status: 'offline', detail: 'no gap history recorded', note: 'run `npm run sherlog:gaps -- --record` to seed history' };
  }
  if (count < MIN_DEGRADED_GAP_RUNS) {
    return { status: 'degraded', detail: `${count} gap history run`, note: 'no baseline for delta comparison' };
  }
  if (count < MIN_RELIABLE_GAP_RUNS) {
    return { status: 'degraded', detail: `${count} gap history runs`, note: 'thin history — trend signals may be noisy' };
  }
  return { status: 'reliable', detail: `${count} gap history runs`, note: null };
}

function checkZones(repoRoot, config) {
  const contextMode = config?.context?.mode || 'none';

  if (contextMode === 'none') {
    return { status: 'offline', detail: 'context mode is "none"', note: 'zone-based analysis disabled — set context.mode to "sherlog-map"' };
  }

  const mapFile = config?.context?.map_file || config?.paths?.context_map;
  const operatorMapPath = mapFile
    ? (path.isAbsolute(mapFile) ? mapFile : path.join(repoRoot, mapFile))
    : path.join(repoRoot, 'sherlog.context.json');
  const generatedMapPath = resolveDataPath(repoRoot, config, 'generated_context_map', 'sherlog.generated.context.json');

  if (fs.existsSync(operatorMapPath)) {
    let mtime;
    try {
      mtime = fs.statSync(operatorMapPath).mtime.toISOString();
    } catch {
      mtime = null;
    }

    if (mtime) {
      const ageDays = ageInHours(mtime) / 24;
      if (ageDays > STALE_CONTEXT_DAYS) {
        return {
          status: 'degraded',
          detail: `operator map — last updated ${humanAge(mtime)}`,
          note: `stale after ${Math.round(ageDays)}d — consider running sherlog:init-context`,
        };
      }
      return { status: 'reliable', detail: `operator map — last updated ${humanAge(mtime)}`, note: null };
    }
    return { status: 'reliable', detail: 'operator map present', note: null };
  }

  if (fs.existsSync(generatedMapPath)) {
    return { status: 'degraded', detail: 'generated map (no operator sherlog.context.json)', note: 'heuristic-only — run sherlog:init-context then edit zones' };
  }

  return { status: 'offline', detail: 'no context map found', note: 'run `npm run sherlog:init-context`' };
}

function checkSonar(repoRoot, config) {
  const sonar = config?.settings?.sonar;
  const org = String(sonar?.org || '').trim();
  const projectKey = String(sonar?.project_key || '').trim();

  if (!org || !projectKey || SONAR_PLACEHOLDER_PATTERN.test(org) || SONAR_PLACEHOLDER_PATTERN.test(projectKey)) {
    return { status: 'offline', detail: 'placeholder config', note: 'set settings.sonar.org and project_key to enable' };
  }

  const reportPath = resolveDataPath(repoRoot, config, 'sonar_report', path.join('velocity-artifacts', 'sonar-report.json'));
  if (!fs.existsSync(reportPath)) {
    return { status: 'degraded', detail: `configured (${org})`, note: 'no sonar report found — run `npm run sherlog:sonar`' };
  }

  let reportMtime;
  try {
    reportMtime = fs.statSync(reportPath).mtime.toISOString();
  } catch {
    reportMtime = null;
  }

  const detail = reportMtime ? `configured (${org}) — report ${humanAge(reportMtime)}` : `configured (${org})`;
  return { status: 'reliable', detail, note: null };
}

function checkSelfModel(repoRoot, config) {
  const modelPath = resolveDataPath(repoRoot, config, 'self_model_index', 'sherlog-velocity/data/self-model.json');

  if (!fs.existsSync(modelPath)) {
    return { status: 'offline', detail: 'no self-model index', note: 'run `npm run sherlog:index-sync` to generate' };
  }

  let generatedAt = null;
  try {
    const data = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    generatedAt = data?.generated_at || null;
  } catch {
    // fall through
  }

  if (!generatedAt) {
    return { status: 'degraded', detail: 'self-model present but missing timestamp', note: null };
  }

  const hours = ageInHours(generatedAt);
  if (hours > STALE_SELF_MODEL_HOURS) {
    return { status: 'degraded', detail: `indexed ${humanAge(generatedAt)}`, note: 'stale — run sherlog:index-sync to refresh' };
  }

  return { status: 'reliable', detail: `indexed ${humanAge(generatedAt)}`, note: null };
}

function checkHygiene(repoRoot, config) {
  const logPath = resolveDataPath(repoRoot, config, 'hygiene_history_log', 'sherlog-velocity/data/hygiene-history.jsonl');
  const rows = readJsonLines(logPath);
  const count = rows.length;

  if (count === 0) {
    return { status: 'offline', detail: 'no hygiene history', note: 'run `npm run sherlog:hygiene` to seed' };
  }
  if (count < MIN_RELIABLE_HYGIENE_RUNS) {
    return { status: 'degraded', detail: `${count} hygiene run${count === 1 ? '' : 's'}`, note: 'trend data not yet meaningful' };
  }
  return { status: 'reliable', detail: `${count} hygiene runs`, note: null };
}

function computeReadiness(repoRoot, config) {
  return {
    estimates: checkEstimates(repoRoot, config),
    digest: checkDigest(repoRoot, config),
    zones: checkZones(repoRoot, config),
    sonar: checkSonar(repoRoot, config),
    self_model: checkSelfModel(repoRoot, config),
    hygiene: checkHygiene(repoRoot, config),
  };
}

function overallStatus(capabilities) {
  const statuses = Object.values(capabilities).map(c => c.status);
  if (statuses.every(s => s === 'reliable')) return 'ready';
  if (statuses.some(s => s === 'offline')) return 'partial';
  return 'degraded';
}

module.exports = {
  computeReadiness,
  overallStatus,
};
