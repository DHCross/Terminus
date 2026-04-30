#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { readJson } = require('../core/shared');

const DROP_ROOT = path.resolve(__dirname, '../..');
const INSTALL_PATH = path.join(DROP_ROOT, 'install.js');
const VERIFY_PATH = path.join(__dirname, 'verify.js');
const CONFIG_PATH = path.join(DROP_ROOT, 'config', 'sherlog.config.json');

function parseArgs(argv) {
  const out = {
    json: false,
    strict: false,
    dryRun: false,
    forceContext: false,
    noInstall: false,
    repoRoot: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force-context') out.forceContext = true;
    else if (arg === '--no-install') out.noInstall = true;
    else if (arg === '--repo-root' && argv[i + 1]) out.repoRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function printHelp() {
  console.log('Usage: node sherlog-velocity/src/cli/bridge.js [options]');
  console.log('');
  console.log('Upgrade and repair Sherlog in a repo that already has it installed.');
  console.log('');
  console.log('Options:');
  console.log('  --dry-run             assess and report changes without writing files');
  console.log('  --strict              exit non-zero when post-bridge verify has FAIL checks');
  console.log('  --force-context       pass --force-context through to install.js');
  console.log('  --no-install          skip re-running install.js');
  console.log('  --repo-root <path>    target repository root (default: current git root)');
  console.log('  --json                emit machine-readable JSON output');
  console.log('  --help, -h            show this message');
}

function shellQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function detectRepoRoot(startDir, fallback) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function resolveRepoRoot(args) {
  if (args.repoRoot) return path.resolve(process.cwd(), args.repoRoot);
  return path.resolve(detectRepoRoot(process.cwd(), process.cwd()));
}

function runCommand(command, cwd) {
  try {
    const stdout = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      status: Number.isFinite(err?.status) ? err.status : 1,
      stdout: err?.stdout ? String(err.stdout) : '',
      stderr: err?.stderr ? String(err.stderr) : String(err?.message || 'unknown command failure'),
    };
  }
}

function runNodeScript(scriptPath, args, cwd) {
  const argText = Array.isArray(args) && args.length
    ? ` ${args.map(shellQuote).join(' ')}`
    : '';
  return runCommand(`node ${shellQuote(scriptPath)}${argText}`, cwd);
}

function readJsonFromStdout(commandResult) {
  if (!commandResult?.stdout) return null;
  try {
    return JSON.parse(commandResult.stdout);
  } catch {
    return null;
  }
}

function runVerify(repoRoot) {
  const result = runNodeScript(VERIFY_PATH, ['--json'], repoRoot);
  const payload = readJsonFromStdout(result);
  return {
    ok: result.ok && Boolean(payload),
    summary: payload?.summary || null,
    output: payload,
    error: result.ok
      ? (payload ? null : 'verify JSON parsing failed')
      : (result.stderr || 'verify command failed'),
  };
}

function formatStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupTargets(repoRoot, config) {
  const targets = new Set([
    path.join(repoRoot, 'package.json'),
    path.join(repoRoot, 'AGENTS.md'),
    CONFIG_PATH,
  ]);

  const configuredPaths = [
    config?.paths?.context_map,
    config?.context?.map_file,
  ].filter(Boolean);

  configuredPaths.forEach(p => {
    const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
    targets.add(abs);
  });

  return Array.from(targets).filter(filePath => fs.existsSync(filePath));
}

function copyBackupFiles(repoRoot, files, backupDir) {
  ensureDir(backupDir);
  const copied = [];

  files.forEach(sourcePath => {
    const inRepo = sourcePath === repoRoot || sourcePath.startsWith(`${repoRoot}${path.sep}`);
    const relative = inRepo
      ? path.relative(repoRoot, sourcePath)
      : path.join('external', path.basename(sourcePath));
    const targetPath = path.join(backupDir, relative);

    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
    copied.push({
      source: sourcePath,
      target: targetPath,
    });
  });

  return copied;
}

function deltaSummary(before, after) {
  const safeBefore = before || { pass: 0, warn: 0, fail: 0 };
  const safeAfter = after || { pass: 0, warn: 0, fail: 0 };
  return {
    pass: safeAfter.pass - safeBefore.pass,
    warn: safeAfter.warn - safeBefore.warn,
    fail: safeAfter.fail - safeBefore.fail,
  };
}

function humanSummary(output) {
  const before = output.verify.before || { pass: 0, warn: 0, fail: 0 };
  const after = output.verify.after || { pass: 0, warn: 0, fail: 0 };
  const delta = output.verify.delta || { pass: 0, warn: 0, fail: 0 };

  console.log('SHERLOG BRIDGE');
  console.log(`Repo: ${output.repo_root}`);
  console.log(`Mode: ${output.mode}`);
  console.log(`Status: ${output.status}`);
  console.log('');
  console.log(`Verify (before): ${before.pass} pass, ${before.warn} warn, ${before.fail} fail`);
  console.log(`Verify (after):  ${after.pass} pass, ${after.warn} warn, ${after.fail} fail`);
  console.log(`Delta:           ${delta.pass >= 0 ? '+' : ''}${delta.pass} pass, ${delta.warn >= 0 ? '+' : ''}${delta.warn} warn, ${delta.fail >= 0 ? '+' : ''}${delta.fail} fail`);
  console.log('');
  console.log('Steps:');
  output.steps.forEach(step => {
    const detail = step.detail ? ` (${step.detail})` : '';
    console.log(`- ${step.name}: ${step.status}${detail}`);
  });

  if (output.backup?.directory) {
    console.log('');
    console.log(`Backup directory: ${output.backup.directory}`);
    console.log(`Backed up files: ${output.backup.files.length}`);
  }

  if (output.errors.length) {
    console.log('');
    console.log('Errors:');
    output.errors.forEach(err => console.log(`- ${err}`));
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot(args);
  const steps = [];
  const errors = [];
  const mode = args.dryRun ? 'dry-run' : 'apply';
  const configBefore = readJson(CONFIG_PATH, null);
  const verifyBefore = runVerify(repoRoot);

  if (!verifyBefore.ok && verifyBefore.error) {
    errors.push(`pre_verify: ${verifyBefore.error}`);
  }

  const output = {
    version: 1,
    timestamp: new Date().toISOString(),
    repo_root: repoRoot,
    mode,
    options: {
      strict: args.strict,
      force_context: args.forceContext,
      no_install: args.noInstall,
    },
    backup: {
      directory: null,
      files: [],
    },
    verify: {
      before: verifyBefore.summary,
      after: null,
      delta: null,
    },
    steps,
    status: 'pass',
    errors,
  };

  if (args.dryRun) {
    steps.push({ name: 'backup', status: 'skipped', detail: 'dry_run' });
  } else {
    const backupDir = path.join(repoRoot, '.logs', 'sherlog-bridge', formatStamp(new Date()));
    const files = backupTargets(repoRoot, configBefore);
    try {
      output.backup.files = copyBackupFiles(repoRoot, files, backupDir);
      output.backup.directory = backupDir;
      steps.push({ name: 'backup', status: 'success', detail: `${output.backup.files.length} file(s)` });
    } catch (err) {
      errors.push(`backup: ${err.message}`);
      steps.push({ name: 'backup', status: 'failed', detail: err.message });
    }
  }

  if (args.noInstall) {
    steps.push({ name: 'install', status: 'skipped', detail: 'disabled_by_flag' });
  } else if (args.dryRun) {
    steps.push({ name: 'install', status: 'skipped', detail: 'dry_run' });
  } else {
    const installArgs = [];
    if (args.forceContext) installArgs.push('--force-context');
    const installResult = runNodeScript(INSTALL_PATH, installArgs, repoRoot);
    if (installResult.ok) {
      steps.push({ name: 'install', status: 'success', detail: 'install.js completed' });
    } else {
      errors.push(`install: ${installResult.stderr || 'install failed'}`);
      steps.push({ name: 'install', status: 'failed', detail: 'install.js exited non-zero' });
    }
  }

  const verifyAfter = runVerify(repoRoot);
  if (!verifyAfter.ok && verifyAfter.error) {
    errors.push(`post_verify: ${verifyAfter.error}`);
  }
  output.verify.after = verifyAfter.summary;
  output.verify.delta = deltaSummary(output.verify.before, output.verify.after);

  const postFailCount = Number(output.verify.after?.fail || 0);
  if (errors.length > 0) output.status = 'fail';
  else if (postFailCount > 0) output.status = 'warn';
  else output.status = 'pass';

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    humanSummary(output);
  }

  if ((args.strict && postFailCount > 0) || errors.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
};
