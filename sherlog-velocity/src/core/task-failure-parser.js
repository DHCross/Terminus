function normalizeLine(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function appendFailure(target, failure, seen, limit = 8) {
  if (!failure || target.length >= limit) return;
  const title = normalizeLine(failure.title);
  const detail = normalizeLine(failure.detail);
  if (!title) return;

  const key = `${title.toLowerCase()}::${detail.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    title,
    detail: detail || null,
    format: failure.format || 'generic',
  });
}

function collapseIndentedBlock(lines, startIndex, stopPattern) {
  const collected = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const raw = String(lines[index] || '');
    const trimmed = normalizeLine(raw);
    if (!trimmed) {
      if (collected.length > 0) break;
      continue;
    }
    if (stopPattern.test(trimmed)) break;
    if (/^(duration_ms|stack|at\s)/i.test(trimmed)) continue;
    collected.push(trimmed.replace(/^[-:#>\s]+/, '').trim());
    if (collected.length >= 3) break;
  }
  return collected.filter(Boolean);
}

function parseTapFailures(lines, failures, seen) {
  const stopPattern = /^(?:ok|not ok)\b|^#\b|^\d+\.\.\d+/i;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = normalizeLine(lines[index]);
    const match = /^not ok\s+\d+\s*-\s*(.+)$/i.exec(trimmed);
    if (!match) continue;

    const detailLines = collapseIndentedBlock(lines, index + 1, stopPattern)
      .filter(line => !/^---$|^\.\.\.$/.test(line));
    appendFailure(failures, {
      title: match[1],
      detail: detailLines[0] || null,
      format: 'tap',
    }, seen);
  }
}

function parseFailHeaders(lines, failures, seen) {
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = normalizeLine(lines[index]);
    const match = /^FAIL\s+(.+)$/i.exec(trimmed);
    if (!match) continue;

    const detailLines = collapseIndentedBlock(lines, index + 1, /^(?:FAIL\s+.+|PASS\s+.+|Test Files|Tests|Snapshots|Start at|Duration)/i)
      .filter(line => /(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error:|Expected)/i.test(line));
    appendFailure(failures, {
      title: match[1],
      detail: detailLines[0] || null,
      format: 'fail_header',
    }, seen);
  }
}

function parseMarkedFailures(lines, failures, seen) {
  for (const line of lines) {
    const trimmed = normalizeLine(line);
    const marked = /^[✖×]\s+(.+)$/.exec(trimmed);
    if (marked) {
      appendFailure(failures, {
        title: marked[1],
        detail: null,
        format: 'marked',
      }, seen);
      continue;
    }

    const generic = /^(AssertionError|TypeError|ReferenceError|SyntaxError|Error):\s+(.+)$/.exec(trimmed);
    if (generic) {
      appendFailure(failures, {
        title: `${generic[1]}: ${generic[2]}`,
        detail: null,
        format: 'generic_error',
      }, seen);
    }
  }
}

function parseTaskFailures(text, options = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return [];

  const lines = raw.split(/\r?\n/);
  const failures = [];
  const seen = new Set();
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 8;

  parseTapFailures(lines, failures, seen);
  parseFailHeaders(lines, failures, seen);
  parseMarkedFailures(lines, failures, seen);

  return failures.slice(0, limit);
}

module.exports = {
  parseTaskFailures,
};
