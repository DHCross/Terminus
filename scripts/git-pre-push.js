#!/usr/bin/env node
/* eslint-disable no-console */

// Sherlog programmatically-enforced pre-push gate.
//
// Two checks run in sequence, each with its own exit code:
//   1. --assert: scope allowlist check (staged paths vs declared allowlist)
//      This check computes its OWN exit code and never inherits the
//      aggregate --strict exit from trace preflight. A pre-existing
//      false positive (e.g. runaway process threshold) must not bypass
//      the scope allowlist. (Correction #2)
//   2. --trace --strict: existing environmental gate (gaps, verify, blast radius)
//
// Bypass: SKIP_SHERLOG=1 is honored but appends a ledger line so the
// bypass is visible rather than silent. (Correction #5)

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function getActiveBranch() {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {
    // fallback
  }
  return 'Current Change';
}

function appendLedger(entry) {
  const ledgerPath = path.resolve(__dirname, '..', 'sherlog-velocity', 'data', 'sherlog-unverified.jsonl');
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
}

function getCurrentSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function main() {
  // Honor existing bypass convention
  if (process.env.SKIP_SHERLOG === '1') {
    appendLedger({
      ts: new Date().toISOString(),
      sha: getCurrentSha(),
      feature: null,
      field: 'scope_allowlist',
      state: 'unknown',
      source: 'SKIP_SHERLOG=1 bypass (pre-push)',
    });
    console.log('[SHERLOG INFO] SKIP_SHERLOG active. Skipping pre-push checks (logged).');
    process.exit(0);
  }

  const branch = getActiveBranch();

  // Skip strict validation on safe branches to allow merges, pull updates, or recovery.
  if (branch === 'main' || branch === 'master' || branch === 'HEAD') {
    console.log(`[SHERLOG INFO] Safe branch "${branch}" detected. Skipping strict pre-push check.`);
    process.exit(0);
  }

  console.log(`\n======================================================`);
  console.log(`[SHERLOG PRE-PUSH GATE] Active branch: "${branch}"`);
  console.log(`======================================================\n`);

  // Check 1: Scope allowlist (--assert)
  // This has its own exit code and does not inherit --strict aggregate.
  const assertResult = spawnSync('npm', ['run', 'sherlog:preflight', '--', '--assert'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });

  if (assertResult.status !== 0) {
    console.error(`\n\x1b[31m[SHERLOG BLOCKED] SCOPE ALLOWLIST CHECK FAILED.`);
    console.error(`Staged files are outside the declared allowlist, or the declaration is stale.`);
    console.error(`Re-declare with \`sherlog:preflight -- --declare --plan-file <path>\` or unstage out-of-scope files.\x1b[0m\n`);
    process.exit(1);
  }

  // Check 2: Strict trace preflight (existing environmental gate)
  const isWarnOnly = process.env.WARN_ONLY === '1' || process.env.SHERLOG_WARN_ONLY === '1';
  const extraArgs = isWarnOnly ? ['--warn-only'] : [];

  const preflight = spawnSync('npm', ['run', 'sherlog:preflight', '--', '--trace', '--strict', '--feature', branch, ...extraArgs], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit'
  });

  if (preflight.status !== 0) {
    console.error(`\n\x1b[31m[SHERLOG BLOCKED] PUSH ABORTED!`);
    console.error(`Gaps, verification hazards, or missing tests were detected on your branch.`);
    console.error(`To maintain workspace integrity, you cannot push this code upstream.`);
    console.error(`Please fix the errors shown above or add the missing test suites.\x1b[0m\n`);
    console.error(`[Help] Run locally:  npm run sherlog:preflight -- --trace --feature "${branch}"`);
    console.error(`[Bypass] If this is a false positive, push using: git push --no-verify\n`);
    process.exit(1);
  }

  console.log(`\n\x1b[32m[SHERLOG APPROVED] Branch is green and compliant. Proceeding with push...\x1b[0m\n`);
  process.exit(0);
}

main();
