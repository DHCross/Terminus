#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const https = require('https');

function readLastTwo(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const entries = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return entries.slice(-2);
}

function detectChange(prev, curr) {
  if (!prev || !curr) return null;
  const p = prev.commits_per_hour || 0;
  const c = curr.commits_per_hour || 0;
  if (p === 0 && c === 0) return null;
  const abs = Math.abs(c - p);
  const pct = p === 0 ? 1 : abs / p;
  if (abs > 0.1 || pct > 0.2) {
    return { direction: c >= p ? 'UP' : 'DOWN', abs, pct, prev: p, curr: c };
  }
  return null;
}

function postWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Status ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function main() {
  const logPath = path.resolve(process.cwd(), process.env.VELOCITY_LOG_PATH || '.logs/velocity-log.jsonl');
  const [prev, curr] = readLastTwo(logPath);

  if (!prev || !curr) {
    console.log('Not enough runs to notify (need at least 2).');
    return;
  }

  const change = detectChange(prev, curr);
  if (!change) {
    console.log('No significant velocity change.');
    return;
  }

  const text = `Velocity ${change.direction}: ${change.prev.toFixed(2)} -> ${change.curr.toFixed(2)} commits/hour (${(change.pct * 100).toFixed(1)}%)`;
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;

  console.log(text);

  if (slackUrl) {
    await postWebhook(slackUrl, { text });
    console.log('Posted to Slack.');
  }
  if (discordUrl) {
    await postWebhook(discordUrl, { content: text });
    console.log('Posted to Discord.');
  }
  if (!slackUrl && !discordUrl) {
    console.log('No webhook URL configured; nothing sent.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
