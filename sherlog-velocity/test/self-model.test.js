const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyRole,
  computeFragility,
  extractExports,
  extractImportEdges,
  fragilityLabel,
  generateSelfModel,
  getSelfModel,
  renderSelfModel,
  resolveImportTarget,
} = require('../src/core/self-model');

test('classifyRole identifies common module roles', () => {
  assert.equal(classifyRole('src/hooks/usePromptMode.ts'), 'hook');
  assert.equal(classifyRole('src/components/VelocityPanel.tsx'), 'component');
  assert.equal(classifyRole('src/app/page.tsx'), 'page');
  assert.equal(classifyRole('src/lib/session/summary.ts'), 'lib');
  assert.equal(classifyRole('src/test/estimate.test.ts'), 'test');
  assert.equal(classifyRole('docs/why-sherlog.md'), 'doc');
});

test('extractExports finds exported functions, consts, and types', () => {
  const code = `
export function handleChat() {}
export async function processMessage() {}
export const MAX_TOKENS = 100;
export type PromptMode = 'CHAT' | 'SOLO';
export interface GovernorState {}
export default function RavenPage() {}
`;
  const exports = extractExports(code);
  assert.ok(exports.includes('handleChat'));
  assert.ok(exports.includes('processMessage'));
  assert.ok(exports.includes('MAX_TOKENS'));
  assert.ok(exports.includes('PromptMode'));
  assert.ok(exports.includes('GovernorState'));
  assert.ok(exports.includes('RavenPage'));
});

test('extractImportEdges captures local imports only', () => {
  const code = `
import { foo } from './utils';
import bar from '@/lib/bar';
import React from 'react';
import { something } from '~/shared';
`;
  const edges = extractImportEdges(code, 'src/app/page.tsx');
  assert.equal(edges.length, 3);
  assert.ok(edges.some(edge => edge.to === './utils'));
  assert.ok(edges.some(edge => edge.to === '@/lib/bar'));
  assert.ok(edges.some(edge => edge.to === '~/shared'));
  assert.ok(!edges.some(edge => edge.to === 'react'));
});

test('resolveImportTarget resolves relative and alias imports against source roots', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-resolve-import-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'helper.ts'), 'export const helper = true;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'Widget.tsx'), 'export function Widget() { return null; }\n', 'utf8');

    assert.equal(
      resolveImportTarget('./helper', 'src/lib/math.ts', { repoRoot: tmpDir, sourceRoots: ['src'] }),
      'src/lib/helper.ts',
    );
    assert.equal(
      resolveImportTarget('@/components/Widget', 'src/lib/math.ts', { repoRoot: tmpDir, sourceRoots: ['src'] }),
      'src/components/Widget.tsx',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeFragility scoring stays bounded and labeled', () => {
  assert.equal(fragilityLabel(computeFragility(100, 3, 4, 0)), 'low');
  const highScore = computeFragility(1200, 25, 20, 15);
  assert.ok(highScore >= 5);
  assert.equal(fragilityLabel(highScore), 'high');
});

test('generateSelfModel produces valid structure on a temp repo', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-self-model-'));
  try {
    const srcDir = path.join(tmpDir, 'src', 'lib');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'math.ts'), `
export function add(a, b) { return a + b; }
export const PI = 3.14;
import { helper } from './helper';
export const result = helper();
`, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'helper.ts'), `
export function helper() { return true; }
`, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'sherlog.context.json'), JSON.stringify({
      zones: [{ name: 'Src Lib Zone', paths: ['src/lib/**/*'], belief: 'Core library', last_updated: '2026-03-01' }],
    }), 'utf8');

    const model = generateSelfModel(tmpDir, {
      sourceRoots: ['src'],
      contextMapPath: path.join(tmpDir, 'sherlog.context.json'),
      churnDays: 7,
    });

    assert.equal(model.version, 1);
    assert.ok(model.summary.total_modules >= 2);
    assert.ok(model.summary.total_edges >= 1);
    assert.ok(Array.isArray(model.modules));
    assert.ok(Array.isArray(model.edges));
    assert.ok(Array.isArray(model.dependency_hubs));
    assert.ok(Array.isArray(model.fragile_files));
    assert.ok(typeof model.narrative === 'string' && model.narrative.length > 0);

    const mathMod = model.modules.find(mod => mod.path.includes('math.ts'));
    assert.ok(mathMod);
    assert.equal(mathMod.role, 'lib');
    assert.ok(mathMod.export_count >= 2);
    assert.ok(mathMod.import_count >= 1);
    assert.ok(model.edges.some(edge => edge.resolved_to === 'src/lib/helper.ts'));

    const rendered = renderSelfModel(model);
    assert.ok(rendered.includes('SHERLOG SELF-MODEL'));
    assert.ok(rendered.includes('Modules indexed'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getSelfModel persists and reloads the cached index artifact', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlog-self-model-cache-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const sherlogIndex = true;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'sherlog.context.json'), JSON.stringify({ zones: [] }), 'utf8');

    const first = getSelfModel(tmpDir, {
      sourceRoots: ['src'],
      contextMapPath: path.join(tmpDir, 'sherlog.context.json'),
      selfModelPath: path.join(tmpDir, 'artifacts', 'self-model.json'),
      persist: true,
      force: true,
    });

    assert.equal(first.source, 'generated');
    assert.equal(fs.existsSync(first.model_path), true);

    const second = getSelfModel(tmpDir, {
      sourceRoots: ['src'],
      contextMapPath: path.join(tmpDir, 'sherlog.context.json'),
      selfModelPath: first.model_path,
      persist: true,
    });

    assert.equal(second.source, 'cache');
    assert.equal(second.model.summary.total_modules, first.model.summary.total_modules);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
