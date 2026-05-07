#!/usr/bin/env node
/**
 * Sherlog MCP Server
 *
 * Implements the Model Context Protocol (MCP) JSON-RPC 2.0 stdio transport.
 * Each Sherlog command is exposed as a tool that AI agents can call directly,
 * eliminating the need to shell out and parse text output.
 *
 * Start via: task mcp  |  npm run sherlog:mcp
 * Spec reference: https://modelcontextprotocol.io/
 */
/* eslint-disable no-console */

const readline = require('readline');
const { loadRuntimeConfig } = require('../core/shared');
const { detectGaps } = require('../core/gap-detector');
const { generateStaticBounds } = require('../core/boundary-mapper');
const { buildConsumerGraph, summarizeConsumersForFile } = require('../core/consumers');
const { createEstimatePayload, renderPrompt } = require('../core/estimate');
const { analyzeBlastRadius } = require('../cli/blast-radius');
const { lintPlan } = require('../cli/lint-plan');

// ─── config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const runtime = loadRuntimeConfig({ fromDir: __dirname });
  if (!runtime.config) {
    throw new Error('Sherlog config not found. Run `node sherlog-velocity/install.js` first.');
  }
  return runtime.config;
}

// ─── MCP protocol helpers ────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'sherlog';
const SERVER_VERSION = '0.1.0';

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  sendMessage({ jsonrpc: '2.0', id, error });
}

// ─── tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'sherlog_get_gaps',
    description: 'Detect implementation, test, and documentation gaps for a given feature. Returns the same payload as `task gaps --json`.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature or task name to analyse.' },
        zones: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of zone/area names to scope the scan.',
        },
      },
      required: ['feature'],
    },
  },
  {
    name: 'sherlog_get_bounds',
    description: 'Generate a static boundary model for a set of files. Returns safe-touch, risky-touch, do-not-touch, and obligations. Equivalent to `task bounds --json`.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature or task label.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative file paths to classify.',
        },
      },
      required: ['feature', 'files'],
    },
  },
  {
    name: 'sherlog_get_blast_radius',
    description: 'Return the exact set of direct consumers, transitive consumers, test files, and do-not-touch files affected when a single source file changes. Equivalent to `task blast-radius --json`.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Repo-relative path of the file to analyse.' },
        threshold: {
          type: 'number',
          description: 'Consumer count above which blast level becomes "high" (default: 5).',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'sherlog_get_prompt',
    description: 'Generate the full AI execution prompt for a feature, including velocity estimate, detected gaps, salience signal, and verification commands. Equivalent to `task prompt`.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Feature or task name.' },
        zones: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional zone filter.',
        },
      },
      required: ['feature'],
    },
  },
  {
    name: 'sherlog_lint_plan',
    description: 'Validate an agent plan against current architectural constraints before any code is written. Runs scope, blast-radius, contradiction, and gap-coverage checks. Equivalent to `task lint-plan --json`.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Plan object with "feature" string and "steps" array.',
          properties: {
            feature: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string' },
                  files: { type: 'array', items: { type: 'string' } },
                  rationale: { type: 'string' },
                  type: { type: 'string' },
                },
                required: ['action', 'files'],
              },
            },
          },
          required: ['feature', 'steps'],
        },
        threshold: {
          type: 'number',
          description: 'Consumer count threshold for blast-radius warnings (default: 5).',
        },
      },
      required: ['plan'],
    },
  },
];

// ─── tool handlers ───────────────────────────────────────────────────────────

function handleGetGaps(params) {
  const config = loadConfig();
  const feature = String(params.feature || 'Current Task');
  const zones = Array.isArray(params.zones) ? params.zones : [];

  const result = detectGaps(feature, config, {
    record: false,
    persistSelfModel: false,
    zones,
  });

  return result;
}

function handleGetBounds(params) {
  const config = loadConfig();
  const feature = String(params.feature || 'Current Task');
  const files = Array.isArray(params.files) ? params.files : [];

  return generateStaticBounds(feature, files, config);
}

function handleGetBlastRadius(params) {
  const config = loadConfig();
  const file = String(params.file || '');
  const threshold = Number.isFinite(params.threshold) ? params.threshold : 5;

  if (!file) throw new Error('Parameter "file" is required.');
  return analyzeBlastRadius(config, file, threshold);
}

function handleGetPrompt(params) {
  const feature = String(params.feature || 'Current Task');
  const zones = Array.isArray(params.zones) ? params.zones : [];

  const payload = createEstimatePayload({
    feature,
    zones,
    autoGaps: true,
  });

  return {
    payload,
    prompt_text: renderPrompt(payload),
    verification_commands: Array.isArray(payload.verification_commands) ? payload.verification_commands : [],
  };
}

function handleLintPlan(params) {
  if (!params.plan || typeof params.plan !== 'object') {
    throw new Error('Parameter "plan" must be an object with "feature" and "steps".');
  }

  const config = loadConfig();
  const threshold = Number.isFinite(params.threshold) ? params.threshold : 5;

  return lintPlan(params.plan, config, threshold);
}

// ─── dispatch ────────────────────────────────────────────────────────────────

function callTool(name, params) {
  switch (name) {
    case 'sherlog_get_gaps': return handleGetGaps(params);
    case 'sherlog_get_bounds': return handleGetBounds(params);
    case 'sherlog_get_blast_radius': return handleGetBlastRadius(params);
    case 'sherlog_get_prompt': return handleGetPrompt(params);
    case 'sherlog_lint_plan': return handleLintPlan(params);
    default: {
      const err = new Error(`Unknown tool: ${name}`);
      err.code = -32601;
      throw err;
    }
  }
}

// ─── request handling ────────────────────────────────────────────────────────

function handleRequest(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolParams = params?.arguments || {};

    if (!toolName) {
      sendError(id, -32602, 'Missing "name" in tools/call params');
      return;
    }

    try {
      const result = callTool(toolName, toolParams);
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (err) {
      const code = typeof err.code === 'number' ? err.code : -32603;
      sendError(id, code, err.message);
    }
    return;
  }

  if (method === 'notifications/initialized') {
    // No response needed for notifications
    return;
  }

  // Unknown method
  sendError(id, -32601, `Method not found: ${method}`);
}

// ─── stdio transport ──────────────────────────────────────────────────────────

function startServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: null,
    terminal: false,
  });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      sendError(null, -32700, 'Parse error: invalid JSON');
      return;
    }

    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      sendError(request.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
      return;
    }

    if (!request.method) {
      sendError(request.id ?? null, -32600, 'Invalid Request: missing method');
      return;
    }

    handleRequest(request);
  });

  rl.on('close', () => {
    process.exit(0);
  });

  process.stderr.write('[sherlog-mcp] Server ready. Listening on stdin.\n');
}

if (require.main === module) startServer();

module.exports = { startServer, TOOLS };
