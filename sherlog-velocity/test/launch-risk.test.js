const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectLaunchRisksInText,
  detectLaunchRisksInPayload,
  normalizeLaunchRisks,
} = require('../src/core/launch-risk');

describe('launch-risk detection', () => {
  test('detects OpenAI 429 quota fallback as launch risk', () => {
    const text = [
      '/api/session-summary hit OpenAI 429 insufficient_quota',
      'fallback to local summary',
    ].join('\n');
    const risks = detectLaunchRisksInText(text, { source: 'ui:session-summary' });
    const codes = risks.map(item => item.code);

    assert.ok(codes.includes('openai_quota_429'));
    assert.ok(codes.includes('session_summary_fallback_active'));
    assert.equal(risks.every(item => item.non_fatal === true), true);
  });

  test('returns empty for non-risk text', () => {
    const risks = detectLaunchRisksInText('all checks passed and summary generated');
    assert.equal(risks.length, 0);
  });

  test('normalizes and dedupes risks by code+source', () => {
    const risks = normalizeLaunchRisks([
      { code: 'OpenAI Quota 429', source: 'alpha' },
      { code: 'openai_quota_429', source: 'alpha' },
      { code: 'openai_quota_429', source: 'beta' },
    ]);
    assert.equal(risks.length, 2);
  });

  test('detects risk from structured payload', () => {
    const payload = {
      error: 'HTTP 429',
      details: {
        provider: 'OpenAI',
        code: 'insufficient_quota',
        mode: 'fallback',
        route: '/api/session-summary',
      },
    };
    const risks = detectLaunchRisksInPayload(payload, { source: 'api' });
    assert.equal(risks.length >= 1, true);
    assert.ok(risks.some(item => item.code === 'openai_quota_429'));
  });
});
