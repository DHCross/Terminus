#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('../core/shared');

function loadDependencyGraph(repoRoot) {
  const graphPath = path.join(repoRoot, 'sherlog.dependency.json');
  if (!fs.existsSync(graphPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  } catch {
    return null;
  }
}

function getFrontier() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  const repoRoot = runtime.config?.repo_root || process.cwd();
  const graph = loadDependencyGraph(repoRoot);

  if (!graph) {
    console.error('No dependency graph found. Run `npm run sherlog:dependency-graph` first.');
    process.exit(1);
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  // 1. Identify all nodes and their status
  const nodeStatus = new Map(nodes.map(n => [n.id, n.status]));

  // 2. Find tasks that are marked 'ready' or 'open'
  // Actually, the frontier should only be things that are ready to go.
  const candidateTasks = nodes.filter(n => n.kind === 'task' && (n.status === 'ready' || n.status === 'open'));

  // 3. Filter by hard blockers
  const frontier = candidateTasks.filter(task => {
    // Find everything this task is blocked by or depends on
    const blockers = edges.filter(e => e.from === task.id && (e.type === 'blocked_by' || e.type === 'depends_on') && e.hard === true);
    for (const edge of blockers) {
      const targetStatus = nodeStatus.get(edge.to);
      // If the thing we depend on isn't 'done' or 'closed', we are blocked.
      if (targetStatus !== 'done' && targetStatus !== 'closed' && targetStatus !== 'resolved') {
        return false;
      }
    }
    return true;
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(frontier, null, 2));
  } else {
    console.log('SHERLOG FRONTIER');
    console.log(`Feature: ${graph.feature}`);
    console.log(`Ready tasks: ${frontier.length}`);
    console.log('');
    if (frontier.length === 0) {
      console.log('No ready tasks found in the current frontier.');
      console.log('Check blocked tasks and resolve dependencies first.');
    } else {
      frontier.forEach((task, idx) => {
        console.log(`${idx + 1}. [${task.id}] ${task.title}`);
        if (task.priority) console.log(`   Priority: ${task.priority}`);
        if (task.owners) console.log(`   Owners: ${task.owners.join(', ')}`);
      });
    }
  }
}

if (require.main === module) {
  getFrontier();
}
