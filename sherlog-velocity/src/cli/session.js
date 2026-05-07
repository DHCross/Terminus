#!/usr/bin/env node
/* eslint-disable no-console */

const { loadRuntimeConfig } = require('../core/shared');
const { SessionTracker } = require('../core/session-tracker');

function parseArgs(argv) {
  const command = argv[2];
  const args = argv.slice(3);
  let feature = '';
  let type = 'implementation'; // default
  let noteText = '';
  let lookback;

  const lookbackIndex = args.indexOf('--lookback');
  if (lookbackIndex !== -1 && args[lookbackIndex + 1]) {
    const parsed = Number.parseInt(args[lookbackIndex + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      lookback = parsed;
    }
    args.splice(lookbackIndex, 2);
  }

  if (command === 'start' || command === 'update') {
      // Crude flag parsing
      const typeIndex = args.indexOf('--type');
      if (typeIndex !== -1 && args[typeIndex + 1]) {
          type = args[typeIndex + 1];
          args.splice(typeIndex, 2); // Remove flag and value
      }
      feature = args.join(' '); 
  } else if (command === 'note') {
      noteText = args.join(' ');
  }

  // Determine actual type value to pass (undefined if not set, for update)
  // For start, we default to 'implementation'. For update, we want to know if it was set.
  // This crude parsing sets type='implementation' by default at top.
  // We need to differentiate "default" vs "explicitly passed" for update.
  // Refactor:
  
  return {
    command,
    feature,
    type: type === 'implementation' && command === 'update' && !argv.includes('--type') ? undefined : type,
    noteText,
    lookback,
  };
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

function printPromptOutputFeatures(features) {
  const sampleSize = Number(features?.sample_size || 0);
  const lookback = Number(features?.lookback_sessions || 0);
  const multiplier = features?.multiplier || {};
  const ledger = features?.wasted_time_ledger || {};
  const velocityTracker = features?.velocity_tracker || {};
  const boss = features?.boss_ready_report || {};

  console.log('SESSION TRACKING OUTPUT FEATURES');
  console.log(`Sample size: ${sampleSize} session(s) (lookback ${lookback})`);

  if (multiplier.available && Number.isFinite(multiplier.value)) {
    console.log(`Invisible work multiplier: ${Number(multiplier.value).toFixed(2)}x`);
    console.log(`  - Implementation: ${Number(multiplier.implementation_hours || 0).toFixed(2)}h`);
    console.log(`  - Discovery/debugging: ${Number(multiplier.invisible_hours || 0).toFixed(2)}h`);
  } else {
    console.log('Invisible work multiplier: n/a (need implementation + discovery/debugging history)');
  }

  console.log(`Wasted time ledger: ${Number(ledger.wasted_hours || 0).toFixed(2)}h of ${Number(ledger.total_hours || 0).toFixed(2)}h (${Number(ledger.wasted_ratio || 0).toFixed(1)}%)`);
  const topFeatures = Array.isArray(ledger.top_features) ? ledger.top_features : [];
  if (topFeatures.length > 0) {
    console.log('Top drag areas:');
    topFeatures.slice(0, 5).forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.feature} — ${Number(item.wasted_hours || 0).toFixed(2)}h wasted (${Number(item.wasted_ratio || 0).toFixed(1)}%), ${Number(item.sessions || 0)} session(s)`);
    });
  }

  console.log('Velocity tracker reality check:');
  console.log(`  - Apparent delivery hours: ${Number(velocityTracker.apparent_hours || 0).toFixed(2)}h`);
  console.log(`  - Actual effort hours: ${Number(velocityTracker.actual_hours || 0).toFixed(2)}h`);
  console.log(`  - Timeline drift: ${Number(velocityTracker.timeline_drift_hours || 0).toFixed(2)}h (${Number(velocityTracker.timeline_drift_pct || 0).toFixed(1)}%)`);
  if (Number.isFinite(velocityTracker.estimate_bias_multiplier)) {
    console.log(`  - AI timeline bias: ${Number(velocityTracker.estimate_bias_multiplier).toFixed(2)}x`);
  } else {
    console.log('  - AI timeline bias: n/a (need implementation + discovery/debugging history)');
  }

  console.log(`Boss-ready headline: ${boss.headline || 'n/a'}`);
  const bullets = Array.isArray(boss.bullets) ? boss.bullets : [];
  bullets.slice(0, 5).forEach((bullet) => {
    console.log(`  - ${bullet}`);
  });
}

function main() {
  const { command, feature, type, noteText, lookback } = parseArgs(process.argv);
  const config = loadConfig();
  const tracker = new SessionTracker(config);

  try {
    switch (command) {
      case 'start':
        if (!feature) {
          console.error('Error: Please specify a feature or task description.');
          console.error('Usage: sherlog:session:start <feature-name> [--type discovery|debugging|implementation]');
          process.exit(1);
        }
        const started = tracker.start(feature, type);
        console.log(`✅ Session started for "${started.feature}" [${started.type}] at ${started.startTime}`);
        break;

      case 'note':
        if (!noteText) {
          console.error('Error: Please provide note text.');
          console.error('Usage: sherlog:session:note <text>');
          process.exit(1);
        }
        const note = tracker.addNote(noteText);
        console.log(`📝 Note added: "${noteText}"`);
        break;

      case 'update':
        const updates = {};
        if (feature) updates.feature = feature;
        if (type) updates.type = type;
        
        if (Object.keys(updates).length === 0) {
             console.log('No updates specified. Use --type <type> or <new-name>.');
             break;
        }
        
        const updated = tracker.updateSession(updates);
        console.log(`🔄 Session updated: "${updated.feature}" [${updated.type}]`);
        break;

      case 'end':
        const ended = tracker.end();
        console.log(`⏹️  Session ended for "${ended.feature}".`);
        console.log(`   Duration: ${formatDuration(ended.durationSeconds)}`);
        if (ended.notes && ended.notes.length > 0) {
            console.log(`   Notes captured: ${ended.notes.length}`);
        }
        const intelligence = ended.intelligence || {};
        const survival = intelligence.code_survival;
        if (survival) {
          if (survival.available) {
            console.log(`   Code survival (last ${survival.lookback_sessions} sessions): ${survival.survival_rate}% (${survival.lines_survived}/${survival.lines_added} added lines still present)`);
            if (survival.lines_rewritten > 0) {
              console.log(`   Rewritten/deleted since creation: ${survival.lines_rewritten} lines`);
            }
            if (Array.isArray(survival.hotspots) && survival.hotspots.length > 0) {
              const hotspot = survival.hotspots[0];
              console.log(`   Churn hotspot: ${hotspot.file} (${hotspot.rewritten_lines} rewritten/deleted lines)`);
            }
          } else if (survival.reason === 'git_unavailable') {
            console.log('   Code survival: unavailable (git context not detected).');
          } else {
            console.log('   Code survival: collecting baseline from recent committed sessions.');
          }
        }

        const synergy = intelligence.net_synergy;
        if (synergy && synergy.available) {
          console.log(`   Net delivery signal: ${synergy.net_sessions} (${synergy.delivery_sessions} delivery - ${synergy.rework_sessions} rework, ${synergy.momentum})`);
        }

        const frustration = intelligence.frustration_index;
        if (frustration) {
          if (frustration.available) {
            console.log(`   Frustration index: ${frustration.level.toUpperCase()} ${frustration.score}/100 (${frustration.keyword_hits} churn-keyword commits in last ${frustration.recent_commits})`);
          } else if (frustration.reason === 'git_unavailable') {
            console.log('   Frustration index: unavailable (git context not detected).');
          }
        }
        break;

      case 'report':
        const report = tracker.generateReport();
        console.log('📊 Session Report:\n');
        if (report.length === 0) {
            console.log('No sessions recorded.');
        } else {
            console.table(report.map(r => ({
                Feature: r.feature,
                Sessions: r.count,
                "Total Time": formatDuration(r.totalSeconds),
                "Hours": r.totalHours
            })));
        }
        break;

      case 'prompt':
        printPromptOutputFeatures(tracker.generatePromptOutputFeatures({ lookbackSessions: lookback }));
        break;
        
      case 'status':
        const active = tracker.status();
        if (active) {
            const start = new Date(active.startTime);
            const now = new Date();
            const diff = (now - start) / 1000;
            console.log(`🕒 Active session: "${active.feature}" [${active.type || 'implementation'}]`);
            console.log(`   Started: ${active.startTime}`);
            console.log(`   Running for: ${formatDuration(diff)}`);
            if (active.notes && active.notes.length > 0) {
                console.log(`   Notes:`);
                active.notes.forEach(n => console.log(`     - [${n.timestamp}] ${n.text}`));
            }
        } else {
            console.log('No active session.');
        }
        break;

      default:
        console.log('Usage:');
        console.log('  sherlog:session:start <feature> [--type discovery|debugging|implementation]');
        console.log('  sherlog:session:update [--type <type>] [<new-feature-name>]');
        console.log('  sherlog:session:note <text>');
        console.log('  sherlog:session:end');
        console.log('  sherlog:session:report');
        console.log('  sherlog:session:prompt [--lookback <sessions>]');
        console.log('  sherlog:session:status');
        break;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
