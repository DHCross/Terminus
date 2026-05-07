#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const { execFileSync } = require('child_process');
const {
  detectPackageRoot,
  detectGitRepoRoot,
  loadRuntimeConfig,
  readJson,
} = require('../core/shared');

function parseArgs(argv) {
  const out = {
    json: false,
    version: 'latest',
    registry: '',
    check: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--check') out.check = true;
    else if (arg === '--version' && argv[i + 1]) out.version = argv[++i];
    else if (arg === '--registry' && argv[i + 1]) out.registry = argv[++i];
  }

  return out;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function resolveLatestVersion(packageName, repoRoot, registry) {
  const npmArgs = ['view', packageName, 'version'];
  if (registry) npmArgs.push('--registry', registry);

  try {
    return { ok: true, version: run('npm', npmArgs, repoRoot) };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: String(error.stderr || error.message || 'Unable to resolve remote version').trim(),
    };
  }
}

function main() {
  const args = parseArgs(process.argv);
  const packageRoot = detectPackageRoot(__dirname);
  const packageJson = readJson(path.join(packageRoot, 'package.json'), {});
  const packageName = String(packageJson.name || 'sherlog-velocity');
  const currentVersion = String(packageJson.version || '0.0.0');
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  const repoRoot = runtime.repoRoot || detectGitRepoRoot(process.cwd());
  const latest = args.version === 'latest'
    ? resolveLatestVersion(packageName, repoRoot, args.registry)
    : { ok: true, version: args.version };

  const result = {
    package: packageName,
    current_version: currentVersion,
    requested_version: args.version,
    latest_version: latest.version,
    repo_root: repoRoot,
    state_root: runtime.stateRoot,
    can_update: Boolean(latest.ok && latest.version),
    updated: false,
    protected_paths: [
      path.join(runtime.stateRoot || path.join(repoRoot, 'sherlog-velocity'), 'data'),
      path.join(runtime.stateRoot || path.join(repoRoot, 'sherlog-velocity'), 'config'),
      path.join(repoRoot, 'sherlog.context.json'),
    ],
    message: '',
  };

  if (!latest.ok) {
    result.message = `Remote version lookup failed: ${latest.error}`;
  } else if (latest.version === currentVersion) {
    result.message = 'Sherlog is already up to date.';
  } else if (args.check) {
    result.message = `Update available: ${currentVersion} -> ${latest.version}`;
  } else {
    const installArgs = ['install', '--save-dev', `${packageName}@${latest.version}`];
    if (args.registry) installArgs.push('--registry', args.registry);
    execFileSync('npm', installArgs, { cwd: repoRoot, stdio: 'inherit' });

    const delegatedInstallPath = path.join(repoRoot, 'node_modules', packageName, 'install.js');
    execFileSync(process.execPath, [delegatedInstallPath, '--auto', '--target-repo', repoRoot], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    result.updated = true;
    result.message = `Updated Sherlog from ${currentVersion} to ${latest.version}.`;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.message);
  console.log(`Package: ${result.package}`);
  console.log(`Current: ${result.current_version}`);
  console.log(`Latest: ${result.latest_version || 'unavailable'}`);
  console.log('Protected state:');
  result.protected_paths.forEach(entry => console.log(`- ${entry}`));
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  resolveLatestVersion,
};
