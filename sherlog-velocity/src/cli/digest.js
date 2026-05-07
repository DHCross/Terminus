#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { loadRuntimeConfig } = require('../core/shared');
const { draftWeeklyDigest } = require('../core/digest');

function parseArgs(argv) {
  const out = {
    feature: '',
    json: false,
    no_llm: false,
    output: null,
    window_days: 7,
    model: null,
    llm_command: null,
    help: false,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--feature' && argv[index + 1]) out.feature = argv[++index];
    else if (arg === '--days' && argv[index + 1]) out.window_days = Number(argv[++index]) || 7;
    else if (arg === '--json') out.json = true;
    else if (arg === '--no-llm') out.no_llm = true;
    else if ((arg === '--output' || arg === '-o') && argv[index + 1]) out.output = argv[++index];
    else if (arg === '--model' && argv[index + 1]) out.model = argv[++index];
    else if (arg === '--llm-command' && argv[index + 1]) out.llm_command = argv[++index];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!arg.startsWith('-')) out.feature = out.feature ? `${out.feature} ${arg}` : arg;
  }

  return out;
}

function printHelp() {
  console.log('Usage: npm run sherlog:digest -- [options]');
  console.log('');
  console.log('Options:');
  console.log('  --feature <name>       focus on one recorded feature instead of the latest run');
  console.log('  --days <n>             comparison window in days (default: 7)');
  console.log('  --no-llm               force deterministic digest rendering');
  console.log('  --model <name>         OpenAI model to use when OPENAI_API_KEY is set');
  console.log('  --llm-command <cmd>    external local-model command that reads prompt from stdin');
  console.log('  -o, --output <path>    write markdown to a file');
  console.log('  --json                 emit markdown plus structured facts as JSON');
  console.log('  --help, -h             show this message');
}

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    console.error('Config not found. Run `node sherlog-velocity/install.js` first.');
    process.exit(1);
  }
  return runtime.config;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const result = await draftWeeklyDigest(loadConfig(), args);

  if (args.output) {
    const outputPath = path.isAbsolute(args.output) ? args.output : path.resolve(process.cwd(), args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${result.markdown}\n`, 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.markdown);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

module.exports = {
  parseArgs,
};
