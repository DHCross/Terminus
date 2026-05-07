'use strict';

const SECTIONS_BY_TIER = {
  intro: ['summary', 'top_risks', 'handoff_prompt', 'next_action', 'not_covered', 'methodology'],
  full: ['summary', 'top_risks', 'stale_seams', 'missing_tests', 'blast_radius', 'handoff_prompt', 'next_action', 'notes', 'not_covered', 'methodology'],
  setup: ['summary', 'top_risks', 'stale_seams', 'missing_tests', 'blast_radius', 'handoff_prompt', 'next_action', 'notes', 'not_covered', 'methodology'],
};

const SECTION_TITLES = {
  summary: '1. Repo summary',
  top_risks: '2. Top risks (ranked)',
  stale_seams: '3. Stale or misleading seams',
  missing_tests: '4. Missing tests and coverage concerns',
  blast_radius: '5. Blast-radius concerns',
  handoff_prompt: '6. AI-agent handoff prompt',
  next_action: '7. Recommended next action',
  notes: '8. Notes, caveats, and lower-priority observations',
  not_covered: '9. What this audit did not cover',
  methodology: '10. Methodology and reproducibility',
};

const HUMAN_REVIEW = (note) => `<HUMAN_REVIEW: ${note}>`;

const SEVERITY_BY_GAP = {
  missing_implementation: 'Critical',
  test_coverage: 'High',
  context_drift: 'High',
  stale_context: 'High',
  missing_bundle: 'High',
  arch_complexity_hotspot: 'High',
  arch_monolith: 'Medium',
  arch_missing_docs: 'Medium',
  hygiene_console_log: 'Low',
  hygiene_any_abuse: 'Medium',
  dead_code_unreachable: 'Medium',
  dead_code_unused_symbol: 'Low',
  changelog_update_missing: 'Low',
};

const GAP_HUMAN_LABEL = {
  test_coverage: 'Insufficient automated test coverage on the feature surface',
  missing_implementation: 'Implementation appears missing or incomplete for the named feature',
  context_drift: 'Context map disagrees with the live code in mapped zones',
  stale_context: 'Context map is older than the code it claims to describe',
  missing_bundle: 'Files claimed by the context map are missing on disk',
  arch_complexity_hotspot: 'A small number of files carry outsized complexity',
  arch_monolith: 'Code is organized in a way that resists isolated change',
  arch_missing_docs: 'Significant code surface lacks any documentation',
  hygiene_console_log: 'Stray debug logging in production paths',
  hygiene_any_abuse: 'Type system bypassed via `any` in non-trivial places',
  dead_code_unreachable: 'Code paths that cannot be reached from any entry point',
  dead_code_unused_symbol: 'Exports with no observed consumers',
  changelog_update_missing: 'Changelog has not been updated to match recent code changes',
};

function severityFor(gapName) {
  return SEVERITY_BY_GAP[gapName] || 'Medium';
}

function humanLabelFor(gapName) {
  return GAP_HUMAN_LABEL[gapName] || gapName.replace(/_/g, ' ');
}

function rankSeverity(label) {
  return { Critical: 4, High: 3, Medium: 2, Low: 1 }[label] || 0;
}

function nonEmptyArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function selectHotFiles(gapsJson, limit = 3) {
  const files = nonEmptyArray(gapsJson?.code_gaps?.files);
  if (files.length === 0) return [];
  const scored = files.map((entry) => {
    const any = safeNumber(entry?.any?.unsuppressed);
    const missing = safeNumber(entry?.missing_tests);
    const complexity = safeNumber(entry?.complexity?.unsuppressed);
    const downstream = safeNumber(entry?.risk?.downstream_consumers);
    const score = any * 2 + missing * 3 + complexity + downstream * 2;
    return { file: entry.file, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((entry) => entry.score > 0).slice(0, limit).map((entry) => entry.file);
}

function buildTopRisks(input, opts) {
  const max = opts?.tier === 'intro' ? 5 : 7;
  const risks = [];
  const seen = new Set();

  const rankedSalience = nonEmptyArray(input?.gaps?.salience?.ranked);
  for (const item of rankedSalience) {
    const gapName = String(item?.gap || '');
    if (!gapName || seen.has(gapName)) continue;
    seen.add(gapName);
    const severity = severityFor(gapName);
    risks.push({
      title: humanLabelFor(gapName),
      gap: gapName,
      severity,
      score: safeNumber(item?.score),
      blast_level: item?.blast_radius?.level ?? null,
      blast_scope: item?.blast_radius?.scope ?? null,
      persistence_runs: safeNumber(item?.persistence?.consecutive_runs, 1),
      source: 'salience',
    });
  }

  const detected = nonEmptyArray(input?.doctor?.gaps);
  for (const gapName of detected) {
    if (seen.has(gapName)) continue;
    seen.add(gapName);
    risks.push({
      title: humanLabelFor(gapName),
      gap: gapName,
      severity: severityFor(gapName),
      score: 0,
      blast_level: null,
      blast_scope: null,
      persistence_runs: 1,
      source: 'doctor',
    });
  }

  risks.sort((a, b) => {
    const sevDelta = rankSeverity(b.severity) - rankSeverity(a.severity);
    if (sevDelta !== 0) return sevDelta;
    return b.score - a.score;
  });

  return risks.slice(0, max);
}

function pickEvidenceForGap(gapName, input) {
  const matched = nonEmptyArray(input?.doctor?.feature_match_files);
  const codeGapFiles = nonEmptyArray(input?.gaps?.code_gaps?.files);

  if (gapName === 'test_coverage' || gapName === 'missing_implementation') {
    if (matched.length > 0) {
      return matched.slice(0, 3).map((file) => file.path).join(', ');
    }
  }
  if (gapName === 'arch_complexity_hotspot' || gapName === 'hygiene_any_abuse') {
    const hot = codeGapFiles.slice(0, 3).map((entry) => entry.file).filter(Boolean);
    if (hot.length > 0) return hot.join(', ');
  }
  if (gapName === 'context_drift' || gapName === 'stale_context' || gapName === 'missing_bundle') {
    const ctxPath = input?.doctor?.context_health?.map_path;
    if (ctxPath) return ctxPath;
  }
  return 'See `gaps --json` evidence section';
}

function recommendActionForGap(gapName, feature) {
  const featureArg = feature || 'Current Task';
  const map = {
    test_coverage: `Add at least one test exercising the highest-risk file in the matched feature set, then re-run \`npm run sherlog:gaps -- --feature "${featureArg}" --json\` to verify the gap drops out.`,
    missing_implementation: `Resolve scope: either implement the missing surface or rename the feature so the matcher stops looking for it.`,
    context_drift: `Run \`npm run sherlog:init-context -- --force\` to regenerate the context map from current code, then diff and review the drift.`,
    stale_context: `Run \`npm run sherlog:init-context -- --force\` and review changes; remove zones that no longer correspond to live code.`,
    missing_bundle: `Either restore the missing files or remove their entries from \`sherlog.context.json\`.`,
    arch_complexity_hotspot: `Extract one nested branch from the highest-complexity file into a named function with its own test.`,
    arch_monolith: `Identify the natural seam (likely along a feature boundary) and extract one module behind a clean interface.`,
    arch_missing_docs: `Add a one-paragraph README to the largest undocumented module describing intent, inputs, and outputs.`,
    hygiene_console_log: `Remove the console.log calls or replace with the project's logger.`,
    hygiene_any_abuse: `Type the most-called \`any\` from the gap report; add a regression test if behavior changes.`,
    dead_code_unreachable: `Delete the unreachable branch and run the test suite. If anything fails, the path was not actually unreachable.`,
    dead_code_unused_symbol: `Confirm the export is truly unused (search consumers across the org), then remove.`,
    changelog_update_missing: `Add a changelog entry summarizing recent commits affecting this feature.`,
  };
  return map[gapName] || `${HUMAN_REVIEW(`recommend a concrete action for gap "${gapName}"`)}`;
}

function effortFor(severity) {
  if (severity === 'Critical') return 'L';
  if (severity === 'High') return 'M';
  return 'S';
}

function renderHeader(meta) {
  const lines = [];
  lines.push(`# Sherlog Audit: \`${meta.repo_name || '<repo>'}\``);
  lines.push('');
  lines.push(`**Prepared for:** ${meta.customer || HUMAN_REVIEW('customer name / company')}`);
  lines.push(`**Tier:** ${meta.tier_label}`);
  lines.push(`**Audit date:** ${meta.date}`);
  lines.push(`**Repo commit audited:** \`${meta.commit || HUMAN_REVIEW('short SHA')}\` on branch \`${meta.branch || 'main'}\``);
  lines.push(`**Sherlog version:** \`${meta.sherlog_version || 'dev'}\``);
  lines.push(`**Auditor:** ${meta.auditor || HUMAN_REVIEW('your name')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function renderSummary(input) {
  const sourceRoots = nonEmptyArray(input?.doctor?.source_roots);
  const matched = nonEmptyArray(input?.doctor?.feature_match_files);
  const ctx = input?.doctor?.context_health || {};
  const lines = [];
  lines.push(`## ${SECTION_TITLES.summary}`);
  lines.push('');
  lines.push(`This repository exposes ${sourceRoots.length} source root(s): ${sourceRoots.length ? '`' + sourceRoots.join('`, `') + '`' : 'none discovered'}.`);
  lines.push(`The Sherlog feature matcher located ${matched.length} file(s) directly tied to the feature \`${input.meta.feature}\`.`);
  if (ctx?.enabled) {
    lines.push(`A context map is in use (mode: \`${ctx.mode}\`, present: ${ctx.map_exists ? 'yes' : 'no'}, valid: ${ctx.map_valid ? 'yes' : 'no'}).`);
  } else {
    lines.push('No active context map is in use; risk findings are derived from code structure alone.');
  }
  lines.push('');
  lines.push(HUMAN_REVIEW('Add 2-4 sentences in the customer\'s own language describing what this repo IS — language(s), framework(s), recent activity pattern, anything structurally unusual. The customer should read this and recognize their own project.'));
  lines.push('');
  return lines.join('\n');
}

function renderTopRisks(input, opts) {
  const risks = buildTopRisks(input, opts);
  const lines = [];
  lines.push(`## ${SECTION_TITLES.top_risks}`);
  lines.push('');
  if (risks.length === 0) {
    lines.push('No ranked risks surfaced from this run. Either the repo is in unusually good shape, or Sherlog could not match the feature scope to any code surface — verify the feature name before assuming the former.');
    lines.push('');
    return lines.join('\n');
  }
  risks.forEach((risk, index) => {
    lines.push(`### Risk ${index + 1} — ${risk.title}`);
    lines.push('');
    lines.push(`- **Severity:** ${risk.severity}`);
    lines.push(`- **Evidence:** ${pickEvidenceForGap(risk.gap, input)}`);
    lines.push(`- **Why it matters:** ${HUMAN_REVIEW(`1-2 sentences in customer language explaining the consequence of leaving "${risk.gap}" unaddressed`)}`);
    lines.push(`- **Recommended action:** ${recommendActionForGap(risk.gap, input.meta.feature)}`);
    lines.push(`- **Effort to address:** ${effortFor(risk.severity)} — ${HUMAN_REVIEW('one-line justification of effort sizing')}`);
    if (risk.blast_level || risk.persistence_runs > 1) {
      const tags = [];
      if (risk.blast_level) tags.push(`blast L${risk.blast_level}/${risk.blast_scope || 'scope?'}`);
      if (risk.persistence_runs > 1) tags.push(`seen ${risk.persistence_runs} consecutive runs`);
      lines.push(`- _Sherlog signal: ${tags.join(', ')}_`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function describeZoneEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object') return String(entry);
  const name = entry.area || entry.name || entry.zone || entry.id || null;
  const pathHint = entry.path || entry.file || (Array.isArray(entry.paths) ? entry.paths[0] : null) || null;
  const reasonParts = [];
  if (entry.reason) reasonParts.push(String(entry.reason));
  else if (entry.detail) reasonParts.push(String(entry.detail));
  else if (entry.message) reasonParts.push(String(entry.message));
  if (Number.isFinite(entry.lag_days)) reasonParts.push(`${entry.lag_days} days lag`);
  if (entry.last_updated) reasonParts.push(`last updated ${entry.last_updated}`);
  if (entry.enforcement) reasonParts.push(`enforcement: ${entry.enforcement}`);
  const reason = reasonParts.join('; ');
  const pieces = [];
  if (name) pieces.push(`**${name}**`);
  if (pathHint) pieces.push(`\`${pathHint}\``);
  if (reason) pieces.push(`— ${reason}`);
  if (pieces.length === 0) return JSON.stringify(entry);
  return pieces.join(' ');
}

function renderZoneEntries(label, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const lines = [`### ${label} (${entries.length})`, ''];
  entries.slice(0, 20).forEach((entry, index) => {
    const summary = describeZoneEntry(entry);
    lines.push(`${index + 1}. ${summary}`);
    lines.push(`   - **What it claims to be:** ${HUMAN_REVIEW('one line')}`);
    lines.push(`   - **What it actually is:** ${HUMAN_REVIEW('one line')}`);
    lines.push(`   - **How AI tools are likely to be misled:** ${HUMAN_REVIEW('one line')}`);
    lines.push(`   - **Suggested cleanup:** ${HUMAN_REVIEW('rename / delete / split / document')}`);
  });
  if (entries.length > 20) {
    lines.push('');
    lines.push(`_…and ${entries.length - 20} more. See \`context_health\` JSON for the full list._`);
  }
  lines.push('');
  return lines;
}

function renderStaleSeams(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.stale_seams}`);
  lines.push('');
  const ctx = input?.doctor?.context_health || {};
  const staleZones = nonEmptyArray(ctx.stale_zones);
  const driftZones = nonEmptyArray(ctx.drift_zones);
  const staleCount = staleZones.length || safeNumber(ctx.stale_areas);
  const driftCount = driftZones.length || safeNumber(ctx.drift_areas);

  if (staleCount === 0 && driftCount === 0) {
    lines.push('No stale or drifted context zones were surfaced in this audit. Re-check after the next 50 commits or after any major refactor.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`Sherlog flagged ${staleCount} stale zone(s) and ${driftCount} drifted zone(s) in the context map.`);
  lines.push('');

  if (staleZones.length > 0 || driftZones.length > 0) {
    lines.push(...renderZoneEntries('Stale zones', staleZones));
    lines.push(...renderZoneEntries('Drifted zones', driftZones));
    lines.push(HUMAN_REVIEW('Polish the per-entry "claims to be / actually is" pairs into customer-readable language. If a finding does not warrant a writeup, delete its block.'));
  } else {
    lines.push('Per-entry detail was not available in the doctor payload (counts only). For each, fill in:');
    lines.push('');
    lines.push('- **Path:** `<file or directory>`');
    lines.push('- **What it claims to be:** `<one line>`');
    lines.push('- **What it actually is:** `<one line>`');
    lines.push('- **How AI tools are likely to be misled:** `<one line>`');
    lines.push('- **Suggested cleanup:** `<rename / delete / split / document>`');
    lines.push('');
    lines.push(HUMAN_REVIEW('Walk the drift_areas/stale_areas list from the context_health output and complete one block per finding.'));
  }
  lines.push('');
  return lines.join('\n');
}

function renderMissingTests(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.missing_tests}`);
  lines.push('');
  const codeFiles = nonEmptyArray(input?.gaps?.code_gaps?.files);
  const filesWithMissing = codeFiles.filter((entry) => safeNumber(entry?.missing_tests) > 0);
  const totalMissing = filesWithMissing.reduce((sum, entry) => sum + safeNumber(entry.missing_tests), 0);

  lines.push(`- **Files flagged as missing test coverage:** ${filesWithMissing.length}`);
  lines.push(`- **Total missing-test signals:** ${totalMissing}`);
  lines.push('');

  if (filesWithMissing.length === 0) {
    lines.push('Sherlog did not flag any files as missing tests in this feature scope. This is not a guarantee that coverage exercises the risky paths — see the human-review note below.');
  } else {
    lines.push('Top files by missing-test signal:');
    lines.push('');
    filesWithMissing
      .slice()
      .sort((a, b) => safeNumber(b.missing_tests) - safeNumber(a.missing_tests))
      .slice(0, 5)
      .forEach((entry) => {
        lines.push(`- \`${entry.file}\` — ${safeNumber(entry.missing_tests)} missing-test signal(s)`);
      });
    lines.push('');
  }

  lines.push(`**One concrete first test to write:** ${HUMAN_REVIEW('pick the highest-leverage file from the list above and name a single behavior to assert')}`);
  lines.push('');
  lines.push(HUMAN_REVIEW('Be honest about confidence: if you ran the test suite and it passed, say so. If you did not, say so. Never imply coverage you did not measure.'));
  lines.push('');
  return lines.join('\n');
}

function renderBlastRadius(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.blast_radius}`);
  lines.push('');
  const items = nonEmptyArray(input?.blast_radius);
  if (items.length === 0) {
    lines.push('No hot files surfaced for blast-radius analysis. Either the repo is small enough that blast radius is uniformly low (note this as a strength), or no files met the heuristic threshold.');
    lines.push('');
    return lines.join('\n');
  }
  items.forEach((item) => {
    lines.push(`### \`${item.target_file}\``);
    lines.push('');
    lines.push(`- **Direct consumers:** ${nonEmptyArray(item.direct_consumers).length}`);
    lines.push(`- **Transitive consumers:** ${nonEmptyArray(item.transitive_consumers).length}`);
    lines.push(`- **Test files in blast radius:** ${nonEmptyArray(item.test_files).length}`);
    lines.push(`- **Blast level:** ${item.blast_level || 'unknown'} (${safeNumber(item.downstream_count)} total downstream)`);
    if (nonEmptyArray(item.do_not_touch).length > 0) {
      lines.push(`- **Do-not-touch consumers:** ${item.do_not_touch.length} — see context map`);
    }
    lines.push(`- **Why this matters:** ${HUMAN_REVIEW('1-2 sentences in customer terms — what breaks if this file changes incorrectly')}`);
    lines.push(`- **Suggested mitigation:** ${HUMAN_REVIEW('extract a seam / add a test / freeze the interface / etc.')}`);
    lines.push('');
  });
  return lines.join('\n');
}

function renderHandoffPrompt(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.handoff_prompt}`);
  lines.push('');
  lines.push('Paste this into your AI coding agent (Cursor, Claude, Codex, Replit Agent) before your next change to this feature.');
  lines.push('');
  lines.push('```');
  lines.push(`You are working in repo \`${input.meta.repo_name || '<repo>'}\` on the feature: ${input.meta.feature}.`);
  lines.push('');
  lines.push('Repo summary:');
  lines.push(HUMAN_REVIEW('Paste the polished version of section 1 (Repo summary) here in 2-4 sentences.'));
  lines.push('');
  const risks = buildTopRisks(input, { tier: 'full' }).slice(0, 3);
  lines.push('Known risks the auditor surfaced (in priority order):');
  if (risks.length === 0) {
    lines.push('- (none surfaced this audit)');
  } else {
    risks.forEach((risk, index) => {
      lines.push(`${index + 1}. [${risk.severity}] ${risk.title}`);
    });
  }
  lines.push('');
  const blastFiles = nonEmptyArray(input?.blast_radius)
    .filter((entry) => entry?.blast_level === 'high' || entry?.blast_level === 'medium')
    .map((entry) => entry.target_file);
  lines.push('Treat as load-bearing — do not change without a paired test:');
  if (blastFiles.length === 0) {
    lines.push('- (no high-blast-radius files identified)');
  } else {
    blastFiles.forEach((file) => lines.push(`- ${file}`));
  }
  lines.push('');
  lines.push('Recommended next action (from this audit):');
  lines.push(HUMAN_REVIEW('Paste section 7 here verbatim.'));
  lines.push('');
  lines.push('If you cannot satisfy this in one PR, stop and say so.');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function renderNextAction(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.next_action}`);
  lines.push('');
  const topRisk = buildTopRisks(input, { tier: 'full' })[0];
  const doctorRec = input?.doctor?.recommendation;

  if (topRisk) {
    lines.push(`**Do this first:** ${recommendActionForGap(topRisk.gap, input.meta.feature)}`);
    lines.push('');
    lines.push(`**Why:** The highest-severity finding in this audit is **${topRisk.title}** (severity: ${topRisk.severity}). ${HUMAN_REVIEW('Add 1-2 sentences in customer language explaining why this risk was ranked first relative to the others.')}`);
    lines.push('');
    lines.push(`**How you'll know it worked:** ${HUMAN_REVIEW('Name an observable signal — e.g. "the gap drops out of `sherlog:gaps` output", "the test you added catches the regression locally", or a customer-defined acceptance condition.')}`);
  } else if (doctorRec) {
    lines.push(`**Do this first:** ${doctorRec.rationale}`);
    lines.push('');
    if (nonEmptyArray(doctorRec.commands).length > 0) {
      lines.push('Suggested commands:');
      doctorRec.commands.forEach((cmd) => lines.push(`- \`${cmd}\``));
      lines.push('');
    }
    lines.push(`**Why:** Doctor's automated recommendation is to \`${doctorRec.action}\` (priority: ${doctorRec.priority}).`);
    lines.push('');
    lines.push(`**How you'll know it worked:** ${HUMAN_REVIEW('Name an observable signal.')}`);
  } else {
    lines.push(HUMAN_REVIEW('No automated next-action could be derived. Name one concrete action in plain language.'));
  }
  lines.push('');
  return lines.join('\n');
}

function renderNotes(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.notes}`);
  lines.push('');
  const diagnostics = input?.doctor?.diagnostics;
  if (diagnostics) {
    lines.push(`Doctor diagnostics: ${safeNumber(diagnostics.pass)} pass, ${safeNumber(diagnostics.warn)} warn, ${safeNumber(diagnostics.fail)} fail.`);
    const checks = nonEmptyArray(diagnostics.checks);
    const warned = checks.filter((c) => c?.status === 'warn' || c?.status === 'fail');
    if (warned.length > 0) {
      lines.push('');
      lines.push('Diagnostic warnings/failures worth noting:');
      warned.forEach((check) => {
        lines.push(`- **${check.id}** (${check.status}): ${check.message}`);
      });
    }
  }
  lines.push('');
  lines.push(HUMAN_REVIEW('Add anything else worth flagging at low priority. If this section grows past one screen, you are diluting sections 2-7.'));
  lines.push('');
  return lines.join('\n');
}

function renderNotCovered(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.not_covered}`);
  lines.push('');
  lines.push('- This was not a security audit.');
  lines.push('- This was not a runtime / performance review.');
  lines.push('- This audit did not run the customer\'s full test suite end-to-end.');
  if (input?.doctor?.context_health?.enabled === false) {
    lines.push('- The context map is not enabled for this repo, so context-drift findings are limited.');
  }
  lines.push(`- ${HUMAN_REVIEW('List anything else explicitly out of scope — packages skipped, languages we cannot model, customer-supplied exclusions.')}`);
  lines.push('');
  return lines.join('\n');
}

function renderMethodology(input) {
  const lines = [];
  lines.push(`## ${SECTION_TITLES.methodology}`);
  lines.push('');
  const meta = input.meta;
  const cmds = nonEmptyArray(meta.commands_run);
  lines.push(`- **Sherlog commands run:** ${cmds.length ? cmds.map((c) => '`' + c + '`').join(', ') : HUMAN_REVIEW('list the doctor/gaps/blast-radius invocations used')}`);
  lines.push(`- **Branch and commit audited:** \`${meta.branch || 'main'}\` @ \`${meta.commit || HUMAN_REVIEW('short SHA')}\``);
  lines.push(`- **Auditor environment:** Node \`${meta.node_version || HUMAN_REVIEW('node version')}\`, Sherlog \`${meta.sherlog_version || 'dev'}\``);
  lines.push(`- **Scratch checkout retention:** Will be deleted within 14 days of delivery, or immediately on request, per data-handling policy.`);
  lines.push('');
  return lines.join('\n');
}

const RENDERERS = {
  summary: renderSummary,
  top_risks: renderTopRisks,
  stale_seams: renderStaleSeams,
  missing_tests: renderMissingTests,
  blast_radius: renderBlastRadius,
  handoff_prompt: renderHandoffPrompt,
  next_action: renderNextAction,
  notes: renderNotes,
  not_covered: renderNotCovered,
  methodology: renderMethodology,
};

function tierLabel(tier) {
  if (tier === 'intro') return 'Intro $49';
  if (tier === 'setup') return 'Setup + Audit $299';
  return 'Full $149';
}

function renderAuditReport(input, options = {}) {
  const tier = options.tier === 'intro' || options.tier === 'setup' ? options.tier : 'full';
  const sections = SECTIONS_BY_TIER[tier];
  const meta = {
    feature: input?.meta?.feature || 'Current Task',
    repo_name: input?.meta?.repo_name || null,
    customer: input?.meta?.customer || null,
    auditor: input?.meta?.auditor || null,
    commit: input?.meta?.commit || null,
    branch: input?.meta?.branch || 'main',
    date: input?.meta?.date || new Date().toISOString().slice(0, 10),
    sherlog_version: input?.meta?.sherlog_version || null,
    node_version: input?.meta?.node_version || null,
    tier,
    tier_label: tierLabel(tier),
    commands_run: nonEmptyArray(input?.meta?.commands_run),
  };
  const enriched = { ...input, meta };

  const parts = [renderHeader(meta)];
  for (const section of sections) {
    const renderer = RENDERERS[section];
    if (!renderer) continue;
    parts.push(renderer(enriched, { tier }));
  }

  parts.push('---');
  parts.push('');
  parts.push('## Quality bar before sending');
  parts.push('');
  parts.push('- [ ] All `<HUMAN_REVIEW: ...>` markers have been resolved or deleted.');
  parts.push('- [ ] Section 7 names exactly one action.');
  parts.push('- [ ] A second human has read the report end-to-end.');
  parts.push('- [ ] Customer-stated worry from intake is addressed somewhere in sections 2, 7, or 8 — explicitly.');
  parts.push('');

  const markdown = parts.join('\n').replace(/\n{3,}/g, '\n\n');

  return {
    markdown,
    tier,
    sections,
    human_review_count: (markdown.match(/<HUMAN_REVIEW:/g) || []).length,
  };
}

module.exports = {
  renderAuditReport,
  selectHotFiles,
  buildTopRisks,
  SECTIONS_BY_TIER,
  SEVERITY_BY_GAP,
};
