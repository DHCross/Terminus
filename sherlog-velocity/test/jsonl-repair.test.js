const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractJsonObjects,
  runRepair,
} = require('../../scripts/jsonl-repair');

describe('jsonl-repair extractJsonObjects', () => {
  test('recovers multiline objects and quarantines trailing partial', () => {
    const src = `{
"a":1
}
{
"b":2
}
{`;
    const { recovered, quarantined } = extractJsonObjects(src, 'abc123');
    assert.equal(recovered.length, 2);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].reason, 'unterminated_json_object');
  });
});

describe('jsonl-repair runRepair', () => {
  test('normalizes timestamps, strips invalid signature, and resequences', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-repair-'));
    const input = path.join(dir, 'events.jsonl');

    const src = [
      '{\n"seq":3,\n"timestamp":"bad",\n"signature":"",\n"event":"a"\n}',
      '{"seq":3,"timestamp":"2020-01-01T00:00:00Z","event":"a"}',
      '{"seq":1,"timestamp":"2020-01-01T00:00:01Z","event":"b"}',
    ].join('\n');

    fs.writeFileSync(input, src, 'utf8');

    const result = runRepair({
      mode: 'analyze',
      input,
      timestampField: 'timestamp',
      sequenceField: 'seq',
      signatureField: 'signature',
      snapshotKey: 'snapshot',
      allowGaps: false,
      schema: null,
    });

    assert.equal(result.report.totals.invalidSignatures, 1);
    assert.equal(result.report.totals.repairedTimestamps, 1);
    assert.ok(result.repairedRecords.length >= 2);
    assert.equal(result.repairedRecords[0].seq, 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('drops stale snapshots deterministically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-repair-'));
    const input = path.join(dir, 'snapshots.jsonl');

    const src = [
      '{"seq":1,"timestamp":"2020-01-01T00:00:01Z","snapshot":{"id":"main","snapshot_seq":1}}',
      '{"seq":2,"timestamp":"2020-01-01T00:00:02Z","snapshot":{"id":"main","snapshot_seq":2}}',
    ].join('\n');

    fs.writeFileSync(input, src, 'utf8');

    const result = runRepair({
      mode: 'analyze',
      input,
      timestampField: 'timestamp',
      sequenceField: 'seq',
      signatureField: 'signature',
      snapshotKey: 'snapshot',
      allowGaps: false,
      schema: null,
    });

    assert.equal(result.report.totals.snapshotConflictsResolved, 1);
    assert.equal(result.repairedRecords.length, 1);
    assert.equal(result.repairedRecords[0].snapshot.snapshot_seq, 2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
