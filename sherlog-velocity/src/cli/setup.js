#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectGitRepoRoot, findRuntimeConfigPath, readJson } = require('../core/shared');
const { computeReadiness, overallStatus } = require('../core/readiness');

function parseArgs(argv) {
  const out = {
    json: false,
    apply: false,
    mode: 'auto',
    strict: false,
    repoRoot: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--dry-run') out.apply = false;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--mode' && argv[i + 1]) {
      const mode = String(argv[++i]).trim().toLowerCase();
      if (mode === 'auto' || mode === 'fresh' || mode === 'upgrade') out.mode = mode;
    } else if (arg === '--repo-root' && argv[i + 1]) {
      out.repoRoot = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }

  return out;
}

function printHelp() {
  console.log('Usage: sherlog setup [options]');
  console.log('');
  console.log('Plan or apply Sherlog setup in a host repo with dry-run-first behavior.');
  console.log('');
  console.log('Options:');
  console.log('  --mode <auto|fresh|upgrade>  setup mode (default: auto)');
  console.log('  --apply                      apply changes (default is dry-run plan only)');
  console.log('  --dry-run                    force plan-only mode');
  console.log('  --strict                     enforce strict bridge checks on upgrade mode');
  console.log('  --repo-root <path>           target repository root (default: git top-level)');
  console.log('  --json                       machine-readable output');
  console.log('  --help, -h                   show this help');
}

function resolveRepoRoot(args) {
  if (args.repoRoot) return path.resolve(process.cwd(), args.repoRoot);
  return detectGitRepoRoot(process.cwd());
}

function detectState(repoRoot) {
  const runtime = findRuntimeConfigPath({ cwd: repoRoot, packageRoot: path.resolve(__dirname, '../..') });
  const packagePath = path.join(repoRoot, 'package.json');
  const pkg = readJson(packagePath, {});
  const scripts = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object'
    ? pkg.scripts
    : {};

  return {
    configPath: runtime.configPath,
    configExists: fs.existsSync(runtime.configPath),
    packagePath,
    packageExists: fs.existsSync(packagePath),
    hasCoreScripts: ['sherlog:verify', 'sherlog:doctor', 'sherlog:gaps', 'sherlog:prompt']
      .every(name => typeof scripts[name] === 'string' && scripts[name].trim().length > 0),
    hasSetupScript: typeof scripts['sherlog:setup'] === 'string' && scripts['sherlog:setup'].trim().length > 0,
  };
}

function detectMode(args, state) {
  if (args.mode !== 'auto') return args.mode;
  return state.configExists ? 'upgrade' : 'fresh';
}

function buildPlan(mode, args, repoRoot) {
  const installPath = path.resolve(__dirname, '../..', 'install.js');
  const bridgePath = path.resolve(__dirname, 'bridge.js');

  if (mode === 'fresh') {
    return [
      {
        id: 'install',
        label: 'Install Sherlog in target repo',
        command: `node ${JSON.stringify(installPath)} --auto --target-repo ${JSON.stringify(repoRoot)}`,
      },
      {
        id: 'verify',
        label: 'Validate install wiring',
        command: `node ${JSON.stringify(path.resolve(__dirname, 'verify.js'))} --json${args.strict ? ' --strict' : ''}`,
      },
    ];
  }

  return [
    {
      id: 'bridge',
      label: 'Repair/upgrade existing Sherlog install',
      command: `node ${JSON.stringify(bridgePath)} --json${args.strict ? ' --strict' : ''} --repo-root ${JSON.stringify(repoRoot)}`,
    },
  ];
}

function runNode(scriptPath, scriptArgs, cwd, inheritOutput = false) {
  const result = {
    ok: true,
    status: 0,
    stdout: '',
    stderr: '',
  };

  try {
    const output = execFileSync(process.execPath, [scriptPath, ...scriptArgs], {
      cwd,
      encoding: 'utf8',
      stdio: inheritOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    result.stdout = inheritOutput ? '' : String(output || '');
    return result;
  } catch (error) {
    result.ok = false;
    result.status = Number.isFinite(error?.status) ? error.status : 1;
    result.stdout = error?.stdout ? String(error.stdout) : '';
    result.stderr = error?.stderr ? String(error.stderr) : String(error?.message || 'command failed');
    return result;
  }
}

function tryReadiness(repoRoot) {
  const runtime = findRuntimeConfigPath({ cwd: repoRoot, packageRoot: path.resolve(__dirname, '../..') });
  if (!fs.existsSync(runtime.configPath)) return null;
  const rawConfig = readJson(runtime.configPath, null);
  if (!rawConfig) return null;

  const capabilities = computeReadiness(repoRoot, rawConfig);
  return {
    overall: overallStatus(capabilities),
    capabilities,
  };
}

function printHuman(summary) {
  console.log('SHERLOG SETUP WIZARD');
  console.log(`Repo: ${summary.repo_root}`);
  console.log(`Mode: ${summary.mode}`);
  console.log(`Apply: ${summary.apply ? 'yes' : 'no (dry-run)'}`);
  console.log('');
  console.log('Safety boundaries:');
  console.log('- Does not touch branches/worktrees/workspace files/editor settings.');
  console.log('- Uses explicit apply mode for any file mutations.');
  console.log('');

  console.log('Plan:');
  summary.plan.forEach((step, index) => {
    console.log(`${index + 1}. ${step.label}`);
    console.log(`   ${step.command}`);
  });

  if (summary.apply) {
    console.log('');
    console.log(`Status: ${summary.status}`);
    summary.executed.forEach(step => {
      console.log(`- ${step.id}: ${step.status}`);
    });
  }

  if (summary.readiness) {
    console.log('');
    console.log(`Readiness: ${summary.readiness.overall}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot(args);
  const state = detectState(repoRoot);
  const mode = detectMode(args, state);
  const plan = buildPlan(mode, args, repoRoot);

  const summary = {
    version: 1,
    timestamp: new Date().toISOString(),
    repo_root: repoRoot,
    mode,
    apply: args.apply,
    state,
    plan,
    executed: [],
    readiness: null,
    status: 'planned',
    errors: [],
  };

  if (args.apply) {
    if (mode === 'fresh') {
      const installResult = runNode(path.resolve(__dirname, '../..', 'install.js'), ['--auto', '--target-repo', repoRoot], repoRoot, true);
      summary.executed.push({ id: 'install', status: installResult.ok ? 'success' : 'failed' });
      if (!installResult.ok) summary.errors.push(installResult.stderr || 'install failed');

      const verifyArgs = ['--json'];
      if (args.strict) verifyArgs.push('--strict');
      const verifyResult = runNode(path.resolve(__dirname, 'verify.js'), verifyArgs, repoRoot, false);
      summary.executed.push({ id: 'verify', status: verifyResult.ok ? 'success' : 'failed' });
      if (!verifyResult.ok) summary.errors.push(verifyResult.stderr || 'verify failed');
    } else {
      const bridgeArgs = ['--json', '--repo-root', repoRoot];
      if (args.strict) bridgeArgs.push('--strict');
      const bridgeResult = runNode(path.resolve(__dirname, 'bridge.js'), bridgeArgs, repoRoot, false);
      summary.executed.push({ id: 'bridge', status: bridgeResult.ok ? 'success' : 'failed' });
      if (!bridgeResult.ok) summary.errors.push(bridgeResult.stderr || 'bridge failed');
    }

    summary.status = summary.errors.length > 0 ? 'failed' : 'applied';
  }

  summary.readiness = tryReadiness(repoRoot);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHuman(summary);
  }

  if (summary.errors.length > 0) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  detectMode,
  buildPlan,
};
