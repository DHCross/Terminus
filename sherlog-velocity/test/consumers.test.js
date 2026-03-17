const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyzeConsumers, buildConsumerGraph, summarizeConsumersForFile } = require('../src/core/consumers');

function makeConfig(repoRoot) {
  return {
    repo_root: repoRoot,
    settings: {
      gap_scan_ignore_dirs: [],
    },
  };
}

describe('consumer tracing', () => {
  test('detects direct and transitive consumers through barrel re-exports', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-consumers-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'resonanceService.ts'),
      [
        'export type ValidationContext = { id: string };',
        'export enum ValidationTier { Low = "low", High = "high" }',
        'export type RespondentRole = "admin" | "user";',
        'export const passthrough = true;',
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'useOracleRequestPipelineUtils.ts'),
      [
        'export { ValidationContext, ValidationTier, RespondentRole } from "./resonanceService";',
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'OracleInterface.tsx'),
      [
        'import type { ValidationContext } from "./useOracleRequestPipelineUtils";',
        'export const render = (ctx: ValidationContext) => ctx.id;',
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'useOracleRequestPipeline.ts'),
      [
        'import { ValidationTier, RespondentRole } from "./useOracleRequestPipelineUtils";',
        'export const run = (tier: ValidationTier, role: RespondentRole) => `${tier}:${role}`;',
      ].join('\n') + '\n',
      'utf8'
    );

    const { summary } = analyzeConsumers(makeConfig(repoRoot), 'src/resonanceService.ts');

    assert.equal(summary.target_file, 'src/resonanceService.ts');
    assert.ok(summary.exports.includes('ValidationContext'));
    assert.ok(summary.exports.includes('ValidationTier'));
    assert.ok(summary.exports.includes('RespondentRole'));
    assert.ok(summary.downstream_count >= 2);

    const contextExport = summary.by_export.find(entry => entry.export === 'ValidationContext');
    assert.ok(contextExport);
    assert.ok(contextExport.chains.some(chain => (
      chain.join(' -> ') === 'src/resonanceService.ts -> src/useOracleRequestPipelineUtils.ts -> src/OracleInterface.tsx'
    )));

    const tierExport = summary.by_export.find(entry => entry.export === 'ValidationTier');
    assert.ok(tierExport.chains.some(chain => chain[chain.length - 1] === 'src/useOracleRequestPipeline.ts'));
  });

  test('summarizes downstream consumers for a high-density source file', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-consumers-summary-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src', 'core.ts'),
      [
        'export const alpha = 1;',
        'export const beta = 2;',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'barrel.ts'),
      'export { alpha, beta } from "./core";\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'consumer.ts'),
      'import { alpha } from "./barrel";\n',
      'utf8'
    );

    const graph = buildConsumerGraph(makeConfig(repoRoot));
    const summary = summarizeConsumersForFile(graph, 'src/core.ts');
    assert.equal(summary.target_file, 'src/core.ts');
    assert.ok(summary.downstream_count >= 1);
    assert.ok(summary.consumers.includes('src/consumer.ts'));
  });
});
