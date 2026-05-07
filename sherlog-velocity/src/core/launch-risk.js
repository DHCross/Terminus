function normalizeRiskCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeLaunchRisk(input) {
  if (!input || typeof input !== 'object') return null;
  const code = normalizeRiskCode(input.code);
  if (!code) return null;

  return {
    code,
    severity: String(input.severity || 'launch_risk').trim().toLowerCase() || 'launch_risk',
    non_fatal: input.non_fatal !== false,
    message: String(input.message || '').trim() || null,
    recommendation: String(input.recommendation || '').trim() || null,
    source: String(input.source || 'unknown').trim() || 'unknown',
    detected_at: String(input.detected_at || new Date().toISOString()).trim(),
  };
}

function normalizeLaunchRisks(risks = []) {
  const out = [];
  const seen = new Set();

  (Array.isArray(risks) ? risks : [risks]).forEach((item) => {
    const normalized = normalizeLaunchRisk(item);
    if (!normalized) return;
    const key = `${normalized.code}::${normalized.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  });

  return out;
}

function detectLaunchRisksInText(text, options = {}) {
  const source = String(options.source || 'unknown').trim() || 'unknown';
  const detectedAt = new Date().toISOString();
  const raw = String(text || '');
  const lowered = raw.toLowerCase();
  const risks = [];

  const has429 = /\b429\b/.test(lowered) || /too many requests/.test(lowered);
  const hasQuota = /insufficient_quota|quota/.test(lowered);
  const hasOpenAI = /\bopenai\b/.test(lowered);
  const hasSessionSummary = /session-summary|session summary/.test(lowered);
  const hasFallback = /\bfallback\b/.test(lowered);

  if (has429 && (hasQuota || hasOpenAI)) {
    risks.push({
      code: 'openai_quota_429',
      severity: 'launch_risk',
      non_fatal: true,
      message: 'OpenAI quota/rate limit fallback detected (HTTP 429).',
      recommendation: 'Treat as launch risk: keep local fallback, add quota buffer, and monitor retry volume.',
      source,
      detected_at: detectedAt,
    });
  }

  if (hasSessionSummary && hasFallback && (has429 || hasQuota)) {
    risks.push({
      code: 'session_summary_fallback_active',
      severity: 'launch_risk',
      non_fatal: true,
      message: 'Session-summary is running in fallback mode.',
      recommendation: 'Include this in launch recommendations and verify quota/runtime stability before release.',
      source,
      detected_at: detectedAt,
    });
  }

  return normalizeLaunchRisks(risks);
}

function detectLaunchRisksInPayload(payload, options = {}) {
  try {
    return detectLaunchRisksInText(JSON.stringify(payload), options);
  } catch {
    return [];
  }
}

module.exports = {
  normalizeLaunchRisks,
  detectLaunchRisksInText,
  detectLaunchRisksInPayload,
};
