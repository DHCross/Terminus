#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {
    mode: null,
    input: null,
    output: null,
    report: null,
    quarantine: null,
    schema: null,
    timestampField: 'timestamp',
    sequenceField: 'seq',
    signatureField: 'signature',
    snapshotKey: 'snapshot',
    allowGaps: false,
    replaceOnSuccess: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!out.mode && (arg === 'analyze' || arg === 'apply')) {
      out.mode = arg;
    } else if (arg === '--input') {
      out.input = argv[++i];
    } else if (arg === '--output') {
      out.output = argv[++i];
    } else if (arg === '--report') {
      out.report = argv[++i];
    } else if (arg === '--quarantine') {
      out.quarantine = argv[++i];
    } else if (arg === '--schema') {
      out.schema = argv[++i];
    } else if (arg === '--timestamp-field') {
      out.timestampField = argv[++i];
    } else if (arg === '--sequence-field') {
      out.sequenceField = argv[++i];
    } else if (arg === '--signature-field') {
      out.signatureField = argv[++i];
    } else if (arg === '--snapshot-key') {
      out.snapshotKey = argv[++i];
    } else if (arg === '--allow-gaps') {
      out.allowGaps = true;
    } else if (arg === '--replace-on-success') {
      out.replaceOnSuccess = true;
    }
  }

  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/jsonl-repair.js analyze --input <file> [--schema <schema.json>] [--report <file>] [--quarantine <file>]',
    '  node scripts/jsonl-repair.js apply --input <file> --output <file> [--schema <schema.json>] [--report <file>] [--quarantine <file>] [--replace-on-success]',
    '',
    'Flags:',
    '  --timestamp-field <name>   default: timestamp',
    '  --sequence-field <name>    default: seq',
    '  --signature-field <name>   default: signature',
    '  --snapshot-key <name>      default: snapshot',
    '  --allow-gaps               preserve sequence gaps',
  ].join('\n');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeIsoTimestamp(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { ok: false, value: null };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, value: null };
  }
  return { ok: true, value: date.toISOString() };
}

function extractJsonObjects(sourceText, inputHash) {
  const recovered = [];
  const quarantined = [];

  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i];

    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;

    if (depth === 0) {
      const end = i + 1;
      const raw = sourceText.slice(start, end);
      recovered.push({
        raw,
        start,
        end,
        recovery_id: `${inputHash}:${start}:${end}`,
      });
      start = -1;
    }
  }

  if (start >= 0) {
    const raw = sourceText.slice(start);
    quarantined.push({
      reason: 'unterminated_json_object',
      raw,
      start,
      end: sourceText.length,
      recovery_id: `${inputHash}:${start}:${sourceText.length}`,
    });
  }

  return { recovered, quarantined };
}

function loadSchema(schemaPath) {
  if (!schemaPath) return null;
  const parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const props = parsed && parsed.properties && typeof parsed.properties === 'object'
    ? Object.keys(parsed.properties)
    : null;
  return {
    raw: parsed,
    allowedKeys: props,
  };
}

function normalizeRecord(record, index, options, state) {
  const out = { ...record };
  const removedFields = [];
  const sigField = options.signatureField;
  const tsField = options.timestampField;

  if (state.allowedKeys && !state.allowedKeys.includes('_repair')) {
    for (const key of Object.keys(out)) {
      if (!state.allowedKeys.includes(key)) {
        removedFields.push(key);
        delete out[key];
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(out, sigField)) {
    const sig = out[sigField];
    if (typeof sig !== 'string' || sig.trim() === '' || !/^[A-Za-z0-9+/=_-]{8,}$/.test(sig.trim())) {
      delete out[sigField];
      state.metrics.invalidSignatures += 1;
    }
  }

  const ts = normalizeIsoTimestamp(out[tsField]);
  if (ts.ok) {
    out[tsField] = ts.value;
  } else {
    const prev = state.lastTimestamp ? new Date(state.lastTimestamp).getTime() : Date.UTC(1970, 0, 1);
    const repaired = new Date(prev + 1).toISOString();
    out[tsField] = repaired;
    state.metrics.repairedTimestamps += 1;
  }
  state.lastTimestamp = out[tsField];

  if (removedFields.length) {
    state.metrics.removedFields += removedFields.length;
    state.removedFieldLog.push({ index, removedFields });
  }

  return out;
}

function repairSequence(records, options, report) {
  const seqField = options.sequenceField;
  const bySeq = new Map();
  const survivors = [];
  const quarantined = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const seq = rec[seqField];
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      rec.__old_seq = null;
      survivors.push(rec);
      continue;
    }

    const existing = bySeq.get(seq);
    if (!existing) {
      bySeq.set(seq, rec);
      survivors.push(rec);
      continue;
    }

    const existingHash = sha256(stableStringify(existing));
    const incomingHash = sha256(stableStringify(rec));
    if (existingHash === incomingHash) {
      quarantined.push({ reason: 'duplicate_sequence_identical_payload', record: rec });
      continue;
    }

    const existingTs = Date.parse(existing[options.timestampField]);
    const incomingTs = Date.parse(rec[options.timestampField]);
    const chooseIncoming = Number.isFinite(incomingTs) && Number.isFinite(existingTs)
      ? incomingTs > existingTs
      : false;

    if (chooseIncoming) {
      const idx = survivors.indexOf(existing);
      if (idx >= 0) survivors[idx] = rec;
      bySeq.set(seq, rec);
      quarantined.push({ reason: 'duplicate_sequence_conflict_loser', record: existing });
    } else {
      quarantined.push({ reason: 'duplicate_sequence_conflict_loser', record: rec });
    }
  }

  let nextSeq = 1;
  const mapping = [];
  for (const rec of survivors) {
    const old = rec[seqField];
    if (options.allowGaps && typeof old === 'number' && Number.isInteger(old) && old > 0) {
      mapping.push({ from: old, to: old });
      continue;
    }
    rec[seqField] = nextSeq;
    mapping.push({ from: typeof old === 'number' ? old : null, to: nextSeq });
    nextSeq += 1;
  }

  report.sequenceMapping = mapping;
  report.sequenceDuplicates = quarantined.length;

  return { survivors, quarantined };
}

function resolveSnapshotConflicts(records, options, report) {
  const key = options.snapshotKey;
  const seen = new Map();
  const survivors = [];
  const quarantined = [];

  for (const rec of records) {
    if (!rec[key] || typeof rec[key] !== 'object') {
      survivors.push(rec);
      continue;
    }

    const snap = rec[key];
    const id = String(snap.id || 'default');
    const seq = Number.isInteger(snap.snapshot_seq) ? snap.snapshot_seq : -1;
    const tsMs = Date.parse(rec[options.timestampField]);
    const hash = sha256(stableStringify(snap));
    const rank = { seq, tsMs: Number.isFinite(tsMs) ? tsMs : -1, hash };

    const prev = seen.get(id);
    if (!prev) {
      seen.set(id, { rec, rank });
      survivors.push(rec);
      continue;
    }

    const better = (
      rank.seq > prev.rank.seq ||
      (rank.seq === prev.rank.seq && rank.tsMs > prev.rank.tsMs) ||
      (rank.seq === prev.rank.seq && rank.tsMs === prev.rank.tsMs && rank.hash > prev.rank.hash)
    );

    if (better) {
      const idx = survivors.indexOf(prev.rec);
      if (idx >= 0) survivors[idx] = rec;
      quarantined.push({ reason: 'stale_snapshot_metadata', record: prev.rec });
      seen.set(id, { rec, rank });
    } else {
      quarantined.push({ reason: 'stale_snapshot_metadata', record: rec });
    }
  }

  report.snapshotConflictsResolved = quarantined.length;
  return { survivors, quarantined };
}

function validateRepaired(records, options, state) {
  const errors = [];
  let lastSeq = 0;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    try {
      JSON.parse(stableStringify(rec));
    } catch (err) {
      errors.push(`record ${i}: invalid json serialization`);
    }

    const ts = normalizeIsoTimestamp(rec[options.timestampField]);
    if (!ts.ok) {
      errors.push(`record ${i}: invalid timestamp`);
    }

    const seq = rec[options.sequenceField];
    if (typeof seq === 'number' && Number.isInteger(seq)) {
      if (!options.allowGaps && seq !== lastSeq + 1) {
        errors.push(`record ${i}: sequence out of order (expected ${lastSeq + 1}, found ${seq})`);
      }
      if (seq <= lastSeq) {
        errors.push(`record ${i}: duplicate/regressing sequence ${seq}`);
      }
      lastSeq = seq;
    }

    if (state.allowedKeys) {
      for (const key of Object.keys(rec)) {
        if (!state.allowedKeys.includes(key)) {
          errors.push(`record ${i}: unexpected key ${key}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function writeAtomicFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function runRepair(options) {
  const inputPath = path.resolve(options.input);
  const sourceText = fs.readFileSync(inputPath, 'utf8');
  const inputHash = sha256(sourceText);

  const schema = loadSchema(options.schema ? path.resolve(options.schema) : null);
  const { recovered, quarantined: parseQuarantine } = extractJsonObjects(sourceText, inputHash);

  const report = {
    mode: options.mode,
    input: inputPath,
    inputHash,
    totals: {
      recoveredObjects: recovered.length,
      parseQuarantine: parseQuarantine.length,
      validObjects: 0,
      invalidObjects: 0,
      removedFields: 0,
      invalidSignatures: 0,
      repairedTimestamps: 0,
      sequenceDuplicates: 0,
      snapshotConflictsResolved: 0,
      finalRecords: 0,
    },
    removedFieldLog: [],
    validation: { ok: false, errors: [] },
    sequenceMapping: [],
  };

  const state = {
    allowedKeys: schema ? schema.allowedKeys : null,
    metrics: report.totals,
    removedFieldLog: report.removedFieldLog,
    lastTimestamp: null,
  };

  const parsed = [];
  const invalid = [];

  for (let i = 0; i < recovered.length; i++) {
    try {
      const obj = JSON.parse(recovered[i].raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        invalid.push({ reason: 'json_value_not_object', raw: recovered[i].raw, recovery_id: recovered[i].recovery_id });
        continue;
      }
      const normalized = normalizeRecord(obj, i, options, state);
      parsed.push(normalized);
      report.totals.validObjects += 1;
    } catch (err) {
      invalid.push({ reason: 'json_parse_error', error: err.message, raw: recovered[i].raw, recovery_id: recovered[i].recovery_id });
      report.totals.invalidObjects += 1;
    }
  }

  const seqStep = repairSequence(parsed, options, report.totals);
  const snapStep = resolveSnapshotConflicts(seqStep.survivors, options, report.totals);

  const quarantine = [
    ...parseQuarantine,
    ...invalid,
    ...seqStep.quarantined,
    ...snapStep.quarantined,
  ];

  const validation = validateRepaired(snapStep.survivors, options, state);
  report.validation = validation;
  report.totals.finalRecords = snapStep.survivors.length;

  return {
    repairedRecords: snapStep.survivors,
    quarantine,
    report,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.mode || !args.input) {
    console.error(usage());
    process.exit(1);
  }

  if (args.mode === 'apply' && !args.output) {
    console.error('apply mode requires --output');
    process.exit(1);
  }

  const result = runRepair(args);
  const reportPath = path.resolve(args.report || `${args.input}.repair-report.json`);
  const quarantinePath = path.resolve(args.quarantine || `${args.input}.quarantine.jsonl`);

  writeAtomicFile(reportPath, JSON.stringify(result.report, null, 2) + '\n');
  writeAtomicFile(quarantinePath, result.quarantine.map((q) => stableStringify(q)).join('\n') + (result.quarantine.length ? '\n' : ''));

  if (args.mode === 'analyze') {
    console.log(JSON.stringify({ ok: result.report.validation.ok, report: reportPath, quarantine: quarantinePath }, null, 2));
    process.exit(result.report.validation.ok ? 0 : 2);
  }

  if (!result.report.validation.ok) {
    console.error(JSON.stringify({ ok: false, errors: result.report.validation.errors, report: reportPath }, null, 2));
    process.exit(2);
  }

  const outputPath = path.resolve(args.output);
  const jsonl = result.repairedRecords.map((rec) => stableStringify(rec)).join('\n') + (result.repairedRecords.length ? '\n' : '');
  writeAtomicFile(outputPath, jsonl);

  if (args.replaceOnSuccess) {
    const inputPath = path.resolve(args.input);
    const backupPath = `${inputPath}.bak.${Date.now()}`;
    fs.renameSync(inputPath, backupPath);
    fs.renameSync(outputPath, inputPath);
  }

  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    report: reportPath,
    quarantine: quarantinePath,
    summary: result.report.totals,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  stableStringify,
  extractJsonObjects,
  normalizeIsoTimestamp,
  runRepair,
};
