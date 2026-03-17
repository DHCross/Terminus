#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {
  detectBranchHead,
  ensureDir,
  readJson,
  resolveRuntimeConfig,
} = require('../core/shared');

const REPO_ROOT = path.resolve(__dirname, '../../../');
const CONFIG_PATH = path.resolve(__dirname, '../../config/sherlog.config.json');
const DEFAULT_ACK_PATH = path.resolve(REPO_ROOT, 'sherlog.acknowledgements.json');
const DEFAULT_REPORT_PATH = path.resolve(REPO_ROOT, 'velocity-artifacts', 'sonar-report.json');
const DEFAULT_SONAR_URL = 'https://sonarcloud.io';
const RATING_LABEL = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E' };
const TYPE_LABEL = {
  BUG: 'Bug',
  VULNERABILITY: 'Vulnerability',
  CODE_SMELL: 'Code Smell',
  SECURITY_HOTSPOT: 'Security Hotspot',
};

function parseArgs(argv) {
  const out = {
    branch: null,
    pr: null,
    json: false,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--branch' && argv[i + 1]) out.branch = argv[++i];
    else if (arg === '--pr' && argv[i + 1]) out.pr = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:sonar -- [--branch <name>] [--pr <number>] [--json] [--dry-run]');
}

function loadConfig() {
  return resolveRuntimeConfig(readJson(CONFIG_PATH, {}));
}

function sanitizeSetting(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith('<') && text.endsWith('>')) return null;
  return text;
}

function loadEnv() {
  const candidates = [
    path.resolve(REPO_ROOT, '.env.local'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(REPO_ROOT, '.env'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    let loadedCount = 0;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && val && !process.env[key]) {
        process.env[key] = val;
        loadedCount += 1;
      }
    }
    if (loadedCount > 0) break;
  }
}

function resolveSonarRuntime(config = {}) {
  const sonar = config?.settings?.sonar || {};
  const repoRoot = config.repo_root || REPO_ROOT;
  const reportOutput = sanitizeSetting(process.env.SONARCLOUD_REPORT_OUTPUT) || sanitizeSetting(sonar.report_output);
  const ackPath = config?.paths?.gap_acknowledgements || DEFAULT_ACK_PATH;

  return {
    repoRoot,
    ackPath: path.isAbsolute(ackPath) ? ackPath : path.resolve(repoRoot, ackPath),
    reportPath: reportOutput ? path.resolve(repoRoot, reportOutput) : DEFAULT_REPORT_PATH,
    baseUrl: sanitizeSetting(process.env.SONARCLOUD_URL) || sanitizeSetting(sonar.sonarcloud_url) || DEFAULT_SONAR_URL,
    org: sanitizeSetting(process.env.SONARCLOUD_ORG) || sanitizeSetting(sonar.org),
    projectKey: sanitizeSetting(process.env.SONARCLOUD_PROJECT)
      || sanitizeSetting(process.env.SONARCLOUD_PROJECT_KEY)
      || sanitizeSetting(sonar.project_key),
    token: sanitizeSetting(process.env.SONARCLOUD_TOKEN),
    gapRegistration: {
      enabled: sonar?.gap_registration?.enabled !== false,
      registerOnGateFail: sonar?.gap_registration?.register_on_gate_fail !== false,
      gapExpiryDays: Number(sonar?.gap_registration?.gap_expiry_days || 14),
    },
  };
}

function buildApiPath(baseUrl, apiPath) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, '');
  return `${basePath}${apiPath}`;
}

function sonarGet(apiPath, token, baseUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const auth = Buffer.from(`${token}:`).toString('base64');
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: buildApiPath(baseUrl, apiPath),
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`SonarCloud API ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function withScope(base, branch, pr) {
  let query = base;
  if (pr) query += `&pullRequest=${encodeURIComponent(pr)}`;
  else if (branch) query += `&branch=${encodeURIComponent(branch)}`;
  return query;
}

async function fetchQualityGate(projectKey, branch, pr, token, baseUrl) {
  let query = `projectKey=${encodeURIComponent(projectKey)}`;
  if (pr) query += `&pullRequest=${encodeURIComponent(pr)}`;
  else if (branch) query += `&branch=${encodeURIComponent(branch)}`;
  return sonarGet(`/api/qualitygates/project_status?${query}`, token, baseUrl);
}

async function fetchAllPages(apiPath, collectionKey, token, baseUrl) {
  const rows = [];
  let page = 1;
  let total = Infinity;
  const pageSize = 500;

  while (((page - 1) * pageSize) < total) {
    const separator = apiPath.includes('?') ? '&' : '?';
    const payload = await sonarGet(`${apiPath}${separator}p=${page}&ps=${pageSize}`, token, baseUrl);
    const batch = Array.isArray(payload?.[collectionKey]) ? payload[collectionKey] : [];
    rows.push(...batch);
    total = Number(payload?.paging?.total || batch.length || 0);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return rows;
}

function stripProjectPrefix(projectKey, component) {
  const prefix = `${projectKey}:`;
  return String(component || 'unknown').startsWith(prefix)
    ? String(component).slice(prefix.length)
    : String(component || 'unknown');
}

async function fetchIssues(projectKey, branch, pr, token, baseUrl) {
  const query = withScope(`componentKeys=${encodeURIComponent(projectKey)}&resolved=false&additionalFields=_all`, branch, pr);
  return fetchAllPages(`/api/issues/search?${query}`, 'issues', token, baseUrl);
}

async function fetchHotspots(projectKey, branch, pr, token, baseUrl) {
  const query = withScope(`projectKey=${encodeURIComponent(projectKey)}&status=TO_REVIEW`, branch, pr);
  return fetchAllPages(`/api/hotspots/search?${query}`, 'hotspots', token, baseUrl);
}

async function fetchMeasures(projectKey, branch, pr, token, baseUrl) {
  const metrics = [
    'coverage',
    'duplicated_lines_density',
    'code_smells',
    'bugs',
    'vulnerabilities',
    'security_hotspots_reviewed',
    'sqale_rating',
    'reliability_rating',
    'security_rating',
  ].join(',');
  const query = withScope(`component=${encodeURIComponent(projectKey)}&metricKeys=${metrics}`, branch, pr);
  const payload = await sonarGet(`/api/measures/component?${query}`, token, baseUrl);
  const measures = Array.isArray(payload?.component?.measures) ? payload.component.measures : [];
  return measures.reduce((acc, measure) => {
    acc[measure.metric] = measure.value ?? measure.period?.value ?? null;
    return acc;
  }, {});
}

function countBy(rows, selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildReport({ qualityGate, issues, hotspots, measures, projectKey, org, branch, pr, head }) {
  const gateStatus = qualityGate?.projectStatus?.status ?? 'UNKNOWN';
  const conditions = (qualityGate?.projectStatus?.conditions ?? []).map((condition) => ({
    metric: condition.metricKey,
    status: condition.status,
    actual: condition.actualValue ?? null,
    threshold: condition.errorThreshold ?? null,
    comparator: condition.comparator ?? null,
  }));
  const issuesByFile = {};

  issues.forEach((issue) => {
    const file = stripProjectPrefix(projectKey, issue.component);
    if (!issuesByFile[file]) issuesByFile[file] = [];
    issuesByFile[file].push({
      key: issue.key,
      type: issue.type,
      severity: issue.severity,
      message: issue.message,
      line: issue.line ?? null,
      effort: issue.effort ?? null,
      status: issue.status ?? null,
      rule: issue.rule ?? null,
    });
  });

  const unreviewedHotspots = hotspots
    .filter(hotspot => hotspot.status === 'TO_REVIEW')
    .map((hotspot) => ({
      key: hotspot.key,
      message: hotspot.message,
      file: stripProjectPrefix(projectKey, hotspot.component),
      line: hotspot.line ?? null,
      vulnerability_probability: hotspot.vulnerabilityProbability ?? null,
    }));

  return {
    _sherlog_schema: 'sonar-report@1',
    generated_at: new Date().toISOString(),
    org: org || null,
    project_key: projectKey,
    branch: branch || null,
    pull_request: pr || null,
    head: head || null,
    quality_gate: {
      status: gateStatus,
      passed: gateStatus === 'OK',
      conditions,
    },
    measures,
    summary: {
      total_issues: issues.length,
      bugs: issues.filter(issue => issue.type === 'BUG').length,
      vulnerabilities: issues.filter(issue => issue.type === 'VULNERABILITY').length,
      code_smells: issues.filter(issue => issue.type === 'CODE_SMELL').length,
      unreviewed_hotspots: unreviewedHotspots.length,
      by_severity: {
        BLOCKER: issues.filter(issue => issue.severity === 'BLOCKER').length,
        CRITICAL: issues.filter(issue => issue.severity === 'CRITICAL').length,
        MAJOR: issues.filter(issue => issue.severity === 'MAJOR').length,
        MINOR: issues.filter(issue => issue.severity === 'MINOR').length,
        INFO: issues.filter(issue => issue.severity === 'INFO').length,
      },
      issues_by_type: countBy(issues, issue => issue.type || 'UNKNOWN'),
    },
    issues_by_file: issuesByFile,
    unreviewed_hotspots: unreviewedHotspots,
  };
}

function qualityGateToGapTypes(conditions = []) {
  const mapped = [];
  for (const condition of conditions) {
    if (condition.status !== 'ERROR') continue;
    const metric = String(condition.metric || '').toLowerCase();
    if (metric.includes('security_hotspot')) mapped.push('security_exposure');
    else if (metric.includes('coverage')) mapped.push('test_coverage');
    else if (metric.includes('duplicat')) mapped.push('context_drift');
    else if (metric.includes('sqale') || metric.includes('maintainab') || metric.includes('code_smell')) mapped.push('missing_implementation');
    else if (metric.includes('bug') || metric.includes('reliab')) mapped.push('build_break');
    else if (metric.includes('vuln') || metric.includes('security')) mapped.push('security_exposure');
  }
  return Array.from(new Set(mapped.length > 0 ? mapped : ['missing_implementation']));
}

function loadAckDocument(ackPath) {
  const parsed = readJson(ackPath, null);
  if (Array.isArray(parsed)) {
    return { shape: 'array', doc: parsed, entries: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return { shape: 'object', doc: parsed, entries };
  }
  return {
    shape: 'object',
    doc: {
      _schema_version: 1,
      updated_at: new Date().toISOString(),
      entries: [],
    },
    entries: [],
  };
}

function isActiveOpenGap(entry, gap, scopeType, scopeValue, now) {
  if (!entry || entry.status !== 'open') return false;
  if (String(entry.gap || '') !== gap) return false;
  if (String(entry.source || '') !== 'sonarcloud') return false;
  const ref = entry.source_ref || {};
  if (String(ref.scope_type || '') !== scopeType) return false;
  if (String(ref.scope_value || '') !== String(scopeValue || '')) return false;
  if (!entry.expires_at) return true;
  const expires = new Date(entry.expires_at).getTime();
  return Number.isFinite(expires) && expires >= now.getTime();
}

function addDays(isoDate, days) {
  const date = new Date(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function registerGaps(report, options = {}) {
  if (report.quality_gate.passed) return { created: 0, skipped: 0, gaps: [] };

  const now = new Date();
  const gapTypes = qualityGateToGapTypes(report.quality_gate.conditions);
  const scopeType = report.pull_request ? 'pull_request' : 'branch';
  const scopeValue = report.pull_request || report.branch || 'default';
  const docState = loadAckDocument(options.ackPath || DEFAULT_ACK_PATH);
  const existing = Array.isArray(docState.entries) ? docState.entries : [];
  const created = [];
  let skipped = 0;

  gapTypes.forEach((gap) => {
    const duplicate = existing.some(entry => isActiveOpenGap(entry, gap, scopeType, scopeValue, now));
    if (duplicate) {
      skipped += 1;
      return;
    }

    const failingConditions = report.quality_gate.conditions
      .filter(condition => condition.status === 'ERROR')
      .map(condition => `${condition.metric}: ${condition.actual} (threshold ${condition.threshold})`)
      .join('; ');

    const newEntry = {
      id: `sonar_${gap}_${Date.now().toString(36)}`,
      feature: '*',
      gap,
      status: 'open',
      reason: `SonarCloud Quality Gate failed for ${scopeType === 'pull_request' ? `PR #${scopeValue}` : `branch ${scopeValue}`}${failingConditions ? ` — ${failingConditions}` : ''}`,
      recorded_at: now.toISOString(),
      expires_at: addDays(now.toISOString(), Number(options.gapExpiryDays || 14)),
      audit_every_days: Number(options.gapExpiryDays || 14),
      source: 'sonarcloud',
      source_ref: {
        project_key: report.project_key,
        scope_type: scopeType,
        scope_value: String(scopeValue),
        branch: report.branch,
        pull_request: report.pull_request,
        head: report.head,
        conditions: report.quality_gate.conditions.filter(condition => condition.status === 'ERROR').map(condition => condition.metric),
      },
    };

    existing.push(newEntry);
    created.push(gap);
  });

  if (created.length > 0 && options.dryRun !== true) {
    ensureDir(path.dirname(options.ackPath || DEFAULT_ACK_PATH));
    if (docState.shape === 'array') {
      fs.writeFileSync(options.ackPath || DEFAULT_ACK_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    } else {
      const nextDoc = {
        ...docState.doc,
        updated_at: now.toISOString(),
        entries: existing,
      };
      fs.writeFileSync(options.ackPath || DEFAULT_ACK_PATH, JSON.stringify(nextDoc, null, 2) + '\n', 'utf8');
    }
  }

  return {
    created: created.length,
    skipped,
    gaps: created,
  };
}

function printReport(report, verbose, reportPath) {
  const failing = report.quality_gate.conditions.filter(condition => condition.status === 'ERROR');
  const passing = report.quality_gate.conditions.filter(condition => condition.status === 'OK');
  const scope = report.pull_request ? `PR #${report.pull_request}` : (report.branch || 'default branch');
  const fileEntries = Object.entries(report.issues_by_file || {});

  console.log(`SHERLOG SONAR REPORT — ${report.project_key}`);
  console.log(`Scope: ${scope}`);
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Quality Gate: ${report.quality_gate.passed ? 'PASS' : 'FAIL'} ${report.quality_gate.status}`);

  if (failing.length > 0) {
    console.log('Failing conditions:');
    failing.forEach(condition => console.log(`  - ${condition.metric}: ${condition.actual} (threshold ${condition.threshold})`));
  }
  if (verbose && passing.length > 0) {
    console.log('Passing conditions:');
    passing.forEach(condition => console.log(`  - ${condition.metric}: ${condition.actual}`));
  }

  console.log('Metrics:');
  if (report.measures.coverage != null) console.log(`  Coverage: ${report.measures.coverage}%`);
  if (report.measures.duplicated_lines_density != null) console.log(`  Duplication: ${report.measures.duplicated_lines_density}%`);
  if (report.measures.code_smells != null) console.log(`  Code smells: ${report.measures.code_smells}`);
  if (report.measures.bugs != null) console.log(`  Bugs: ${report.measures.bugs}`);
  if (report.measures.vulnerabilities != null) console.log(`  Vulnerabilities: ${report.measures.vulnerabilities}`);
  if (report.measures.security_hotspots_reviewed != null) console.log(`  Hotspots reviewed: ${report.measures.security_hotspots_reviewed}%`);
  if (report.measures.sqale_rating != null) console.log(`  Maintainability rating: ${RATING_LABEL[report.measures.sqale_rating] || report.measures.sqale_rating}`);
  if (report.measures.reliability_rating != null) console.log(`  Reliability rating: ${RATING_LABEL[report.measures.reliability_rating] || report.measures.reliability_rating}`);
  if (report.measures.security_rating != null) console.log(`  Security rating: ${RATING_LABEL[report.measures.security_rating] || report.measures.security_rating}`);

  console.log(`Issues: ${report.summary.total_issues} total`);
  if (report.summary.total_issues > 0) {
    if (report.summary.bugs > 0) console.log(`  Bugs: ${report.summary.bugs}`);
    if (report.summary.vulnerabilities > 0) console.log(`  Vulnerabilities: ${report.summary.vulnerabilities}`);
    if (report.summary.code_smells > 0) console.log(`  Code smells: ${report.summary.code_smells}`);
    if (report.summary.unreviewed_hotspots > 0) console.log(`  Hotspots (unreviewed): ${report.summary.unreviewed_hotspots}`);
  }

  if (fileEntries.length > 0) {
    console.log('Issues by file:');
    fileEntries
      .sort(([, left], [, right]) => right.length - left.length)
      .slice(0, 10)
      .forEach(([file, fileIssues]) => {
        const bySeverity = fileIssues.reduce((acc, issue) => {
          acc[issue.severity] = (acc[issue.severity] || 0) + 1;
          return acc;
        }, {});
        const severityLabel = Object.entries(bySeverity).map(([severity, count]) => `${severity.toLowerCase()}:${count}`).join(' ');
        console.log(`  ${file} [${fileIssues.length} issues${severityLabel ? ` — ${severityLabel}` : ''}]`);
        if (verbose) {
          fileIssues.slice(0, 3).forEach((issue) => {
            const line = issue.line ? `:${issue.line}` : '';
            console.log(`    L${line} ${TYPE_LABEL[issue.type] || issue.type} — ${String(issue.message || '').slice(0, 90)}`);
          });
        }
      });
  }

  if ((report.unreviewed_hotspots || []).length > 0) {
    console.log('Unreviewed security hotspots:');
    report.unreviewed_hotspots.slice(0, 5).forEach((hotspot) => {
      const line = hotspot.line ? `:${hotspot.line}` : '';
      console.log(`  ${hotspot.file}${line} — ${String(hotspot.message || '').slice(0, 90)}`);
    });
  }

  console.log(`Report saved: ${path.relative(REPO_ROOT, reportPath)}`);
}

async function run(rawArgs = process.argv, injected = {}) {
  const args = parseArgs(rawArgs);
  if (args.help) {
    printHelp();
    return { ok: true, help: true };
  }

  if (!injected.skipEnvLoad) loadEnv();

  const config = injected.config || loadConfig();
  const runtime = injected.runtime || resolveSonarRuntime(config);
  const branchHead = injected.branchHead || detectBranchHead(runtime.repoRoot);
  const branch = args.branch || (args.pr ? null : branchHead.branch);
  const pr = args.pr || null;

  if (!runtime.token || !runtime.projectKey) {
    throw new Error('SONARCLOUD_TOKEN and SONARCLOUD_PROJECT (or settings.sonar.project_key) are required.');
  }

  const [qualityGate, issues, hotspots, measures] = await Promise.all([
    (injected.fetchQualityGate || fetchQualityGate)(runtime.projectKey, branch, pr, runtime.token, runtime.baseUrl),
    (injected.fetchIssues || fetchIssues)(runtime.projectKey, branch, pr, runtime.token, runtime.baseUrl),
    (injected.fetchHotspots || fetchHotspots)(runtime.projectKey, branch, pr, runtime.token, runtime.baseUrl),
    (injected.fetchMeasures || fetchMeasures)(runtime.projectKey, branch, pr, runtime.token, runtime.baseUrl),
  ]);

  const report = buildReport({
    qualityGate,
    issues,
    hotspots,
    measures,
    projectKey: runtime.projectKey,
    org: runtime.org,
    branch,
    pr,
    head: branchHead.head,
  });

  ensureDir(path.dirname(runtime.reportPath));
  fs.writeFileSync(runtime.reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  let registration = { created: 0, skipped: 0, gaps: [] };
  if (!report.quality_gate.passed && runtime.gapRegistration.enabled && runtime.gapRegistration.registerOnGateFail) {
    registration = registerGaps(report, {
      ackPath: runtime.ackPath,
      gapExpiryDays: runtime.gapRegistration.gapExpiryDays,
      dryRun: args.dryRun,
    });
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return { ok: true, report, registration };
  }

  printReport(report, true, runtime.reportPath);
  if (!report.quality_gate.passed) {
    if (registration.created > 0) console.log(`Registered ${registration.created} open Sherlog gap(s) from SonarCloud.`);
    else if (args.dryRun) console.log('Dry run: SonarCloud gaps were not written to sherlog.acknowledgements.json.');
    else console.log('No new SonarCloud gaps were registered.');
  } else {
    console.log('Quality Gate passed; no SonarCloud gaps were registered.');
  }

  return { ok: true, report, registration };
}

async function main() {
  try {
    await run(process.argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  buildReport,
  fetchHotspots,
  fetchIssues,
  fetchMeasures,
  fetchQualityGate,
  loadEnv,
  parseArgs,
  qualityGateToGapTypes,
  registerGaps,
  resolveSonarRuntime,
  run,
  sonarGet,
};
