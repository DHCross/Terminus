#!/usr/bin/env node
/* eslint-disable no-console */

const { createEstimatePayload, parseArgs, renderPrompt } = require('../core/estimate');

function main() {
  const args = parseArgs(process.argv);
  if (!args.feature) args.feature = 'Current Task';

  try {
    const payload = createEstimatePayload(args);
    console.log(renderPrompt(payload));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) main();
