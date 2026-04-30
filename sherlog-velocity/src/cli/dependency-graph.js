#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('../core/shared');
const { detectGaps } = require('../core/gap-detector');

function parseArgs(argv) {
  const out = { feature: 'Unknown Feature' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--feature' && argv[i + 1]) {
      out.feature = argv[++i];
    }
  }
  return out;
}

function generateDependencyGraph() {
  const args = parseArgs(process.argv);
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  
  if (!runtime.config) {
    console.error('Sherlog config not found.');
    process.exit(1);
  }
  
  const repoRoot = runtime.config.repo_root || process.cwd();
  
  // Gather current gaps
  const gapResult = detectGaps(args.feature, runtime.config, { record: false });
  const rankedGaps = (gapResult.salience && gapResult.salience.ranked) || [];
  
  const nodes = [];
  const edges = [];

  // Base feature task
  const featureTaskId = 'task.feature_implementation';
  nodes.push({
    id: featureTaskId,
    kind: 'task',
    title: `Implement ${args.feature}`,
    status: 'ready',
    priority: 0.8,
    confidence: 'medium',
    evidence: [],
    owners: ['agent.backend'],
    tags: ['feature']
  });

  // Derived nodes from gaps
  rankedGaps.forEach(g => {
    const gapId = `gap.${g.gap}`;
    
    // Add the gap node
    nodes.push({
      id: gapId,
      kind: 'gap',
      title: `Resolve ${g.gap.replace(/_/g, ' ')}`,
      status: 'open',
      priority: Math.min(0.99, (g.score || 10) / 100),
      confidence: 'high',
      evidence: [
        { source: 'gap_detector', gap: g.gap, weight: g.score, trend: g.trend }
      ],
      tags: ['gap', g.gap]
    });

    if (g.gap === 'context_drift' || g.gap === 'stale_context') {
      // Feature implementation blocked by context drift
      edges.push({
        from: featureTaskId,
        to: gapId,
        type: 'blocked_by',
        hard: true
      });
      // The feature task shouldn't be ready if blocked
      nodes.find(n => n.id === featureTaskId).status = 'blocked';
    } 
    else if (g.gap === 'test_coverage') {
      const testTaskId = 'task.tests';
      nodes.push({
        id: testTaskId,
        kind: 'task',
        title: 'Write tests',
        status: 'blocked',
        priority: 0.7,
        confidence: 'medium',
        evidence: [
          { source: 'gap_detector', gap: 'test_coverage', weight: g.score }
        ],
        owners: ['agent.test'],
        tags: ['tests']
      });
      
      edges.push({
        from: testTaskId,
        to: featureTaskId,
        type: 'depends_on',
        hard: true
      });
    }
    else {
      // General gap blocks the feature task softly
      edges.push({
        from: featureTaskId,
        to: gapId,
        type: 'blocked_by',
        hard: false
      });
    }
  });

  const artifact = {
    version: '0.1.0',
    generated_at: new Date().toISOString(),
    feature: args.feature,
    mode: 'advisory',
    nodes,
    edges,
    policies: {
      dispatch_when_all_hard_deps_closed: true,
      max_parallel_ready_tasks: 3,
      retry_limit: 2
    }
  };
  
  const outputPath = path.join(repoRoot, 'sherlog.dependency.json');
  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2), 'utf8');
  
  console.log(`Generated v0 dependency graph at ${outputPath}`);
}

if (require.main === module) {
  generateDependencyGraph();
}
