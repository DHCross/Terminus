#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const defaultSettings = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'settings.json'),
  ];
  const out = {
    apply: false,
    json: false,
    root: path.join(os.homedir(), 'Dev', 'GitHub'),
    settings: defaultSettings,
    maxDepth: 5,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--root' && argv[i + 1]) out.root = path.resolve(argv[++i]);
    else if (arg === '--settings' && argv[i + 1]) out.settings = [path.resolve(argv[++i])];
    else if (arg === '--max-depth' && argv[i + 1]) out.maxDepth = Number(argv[++i]) || out.maxDepth;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }

  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/repair-antigravity.js [--apply] [--json]',
    '',
    'Options:',
    '  --apply              write repairs; default is dry-run',
    '  --root <dir>         repo search root (default: ~/Dev/GitHub)',
    '  --settings <file>    user settings path; overrides default Code + Antigravity settings scan',
    '  --max-depth <n>      max directory depth while scanning repos/workspaces',
    '  --json               emit machine-readable output',
  ].join('\n');
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isGitRepo(dir) {
  const dotGit = path.join(dir, '.git');
  return fs.existsSync(dotGit);
}

function walk(root, visitor, options = {}) {
  const maxDepth = Number(options.maxDepth || 5);
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv']);
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    visitor(current.dir, entries);
    if (current.depth >= maxDepth) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignored.has(entry.name)) continue;
      stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
}

function discoverRepos(root, maxDepth) {
  const repos = [];
  walk(root, (dir) => {
    if (isGitRepo(dir)) repos.push(dir);
  }, { maxDepth });
  return Array.from(new Set(repos)).sort();
}

function discoverWorkspaceFiles(root, maxDepth) {
  const files = [];
  walk(root, (dir, entries) => {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.code-workspace')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }, { maxDepth });
  return Array.from(new Set(files)).sort();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error };
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function repairUserSettings(settingsPath, apply) {
  const result = { path: settingsPath, exists: fs.existsSync(settingsPath), changed: false, actions: [], error: null };
  if (!result.exists) return result;

  const parsed = readJson(settingsPath);
  if (parsed.error) {
    result.error = parsed.error.message;
    return result;
  }

  if (parsed['chat.mcp.gallery.enabled'] !== false) {
    parsed['chat.mcp.gallery.enabled'] = false;
    result.changed = true;
    result.actions.push('set chat.mcp.gallery.enabled=false');
  }

  if (JSON.stringify(parsed['chat.mcp.serverSampling'] || {}) !== '{}') {
    parsed['chat.mcp.serverSampling'] = {};
    result.changed = true;
    result.actions.push('cleared chat.mcp.serverSampling');
  } else if (!Object.prototype.hasOwnProperty.call(parsed, 'chat.mcp.serverSampling')) {
    parsed['chat.mcp.serverSampling'] = {};
    result.changed = true;
    result.actions.push('created empty chat.mcp.serverSampling');
  }

  if (JSON.stringify(parsed['chat.tools.terminal.autoApprove'] || {}) !== '{}') {
    parsed['chat.tools.terminal.autoApprove'] = {};
    result.changed = true;
    result.actions.push('cleared chat.tools.terminal.autoApprove');
  } else if (!Object.prototype.hasOwnProperty.call(parsed, 'chat.tools.terminal.autoApprove')) {
    parsed['chat.tools.terminal.autoApprove'] = {};
    result.changed = true;
    result.actions.push('created empty chat.tools.terminal.autoApprove');
  }

  if (apply && result.changed) writeJson(settingsPath, parsed);
  return result;
}

function repairWorkspaceFile(filePath, apply) {
  const result = { path: filePath, changed: false, actions: [], error: null };
  const parsed = readJson(filePath);
  if (parsed.error) {
    result.error = parsed.error.message;
    return result;
  }

  if (parsed.settings && Object.prototype.hasOwnProperty.call(parsed.settings, 'chat.tools.terminal.autoApprove')) {
    delete parsed.settings['chat.tools.terminal.autoApprove'];
    result.changed = true;
    result.actions.push('removed workspace chat.tools.terminal.autoApprove');
  }

  if (apply && result.changed) writeJson(filePath, parsed);
  return result;
}

function repairRepo(repo, apply) {
  const result = { path: repo, changed: false, actions: [], errors: [] };
  const configValue = run('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: repo });
  if (configValue.status === 0 && configValue.stdout.trim() === 'true') {
    result.changed = true;
    result.actions.push('unset extensions.worktreeConfig');
    if (apply) {
      const unset = run('git', ['config', '--unset', 'extensions.worktreeConfig'], { cwd: repo });
      if (unset.status !== 0) result.errors.push(unset.stderr.trim() || 'failed to unset extensions.worktreeConfig');
    }
  }

  const before = run('git', ['worktree', 'list', '--porcelain'], { cwd: repo });
  if (before.status !== 0) {
    result.errors.push(before.stderr.trim() || 'failed to list worktrees');
    return result;
  }

  const prunableBefore = before.stdout.split('\n').filter(line => line.startsWith('prunable')).length;
  if (prunableBefore > 0) {
    result.changed = true;
    result.actions.push(`prune ${prunableBefore} stale worktree entr${prunableBefore === 1 ? 'y' : 'ies'}`);
  }

  if (apply) {
    const prune = run('git', ['worktree', 'prune'], { cwd: repo });
    if (prune.status !== 0) result.errors.push(prune.stderr.trim() || 'failed to prune worktrees');
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const repos = fs.existsSync(args.root) ? discoverRepos(args.root, args.maxDepth) : [];
  const workspaceFiles = fs.existsSync(args.root) ? discoverWorkspaceFiles(args.root, args.maxDepth) : [];
  const settings = args.settings.map(settingsPath => repairUserSettings(settingsPath, args.apply));
  const output = {
    mode: args.apply ? 'apply' : 'dry-run',
    root: args.root,
    settings,
    repos: repos.map(repo => repairRepo(repo, args.apply)).filter(item => item.changed || item.errors.length > 0),
    workspaces: workspaceFiles.map(file => repairWorkspaceFile(file, args.apply)).filter(item => item.changed || item.error),
  };

  output.summary = {
    settings_changed: output.settings.filter(item => item.changed).length,
    repos_changed: output.repos.filter(item => item.changed).length,
    workspace_files_changed: output.workspaces.filter(item => item.changed).length,
    errors: [
      ...output.settings.map(item => item.error),
      ...output.repos.flatMap(item => item.errors),
      ...output.workspaces.map(item => item.error),
    ].filter(Boolean).length,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Antigravity repair (${output.mode})`);
  console.log(`Root: ${output.root}`);
  console.log(`Settings files changed: ${output.summary.settings_changed}`);
  console.log(`Repos changed: ${output.summary.repos_changed}`);
  console.log(`Workspace files changed: ${output.summary.workspace_files_changed}`);
  console.log(`Errors: ${output.summary.errors}`);

  for (const settingsFile of output.settings) {
    settingsFile.actions.forEach(action => console.log(`- ${settingsFile.path}: ${action}`));
    if (settingsFile.error) console.log(`! ${settingsFile.path}: ${settingsFile.error}`);
  }
  for (const repo of output.repos) {
    repo.actions.forEach(action => console.log(`- ${repo.path}: ${action}`));
    repo.errors.forEach(error => console.log(`! ${repo.path}: ${error}`));
  }
  for (const workspace of output.workspaces) {
    workspace.actions.forEach(action => console.log(`- ${workspace.path}: ${action}`));
    if (workspace.error) console.log(`! ${workspace.path}: ${workspace.error}`);
  }

  if (!args.apply) console.log('\nDry run only. Re-run with --apply to write repairs.');
  else console.log('\nRepairs applied. Fully reload/restart VS Code or Antigravity to drop cached state.');
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  repairUserSettings,
  repairWorkspaceFile,
  repairRepo,
};