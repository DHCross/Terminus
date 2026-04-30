const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sherlog-rag-${label}-`));
}

function runIngester(filePath, prevFilePath = null) {
  const scriptPath = path.join(__dirname, '..', '..', 'seed', 'coherence-lab', 'knowledge', 'rag_ingester.py');
  let cmd = `python3 "${scriptPath}" --file "${filePath}"`;
  if (prevFilePath) {
    cmd += ` --previous "${prevFilePath}"`;
  }
  
  const raw = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

describe('RAG Ingester', () => {
  test('ingests new file correctly', () => {
    const tempDir = makeTempDir('new');
    const filePath = path.join(tempDir, 'test.md');
    fs.writeFileSync(filePath, '# Heading 1\nSome content here.\n## Heading 2\nMore content.', 'utf8');

    const result = runIngester(filePath);
    
    assert.equal(result.title, 'test.md');
    assert.equal(result.chunks.length, 2);
    assert.equal(result.chunks[0].section_heading, 'Heading 1');
    assert.equal(result.chunks[0].text, 'Some content here.');
    assert.equal(result.chunks[0].change_type, 'added');

    assert.equal(result.chunks[1].section_heading, 'Heading 2');
    assert.equal(result.chunks[1].text, 'More content.');
    
    fs.rmSync(tempDir, { recursive: true });
  });

  test('diffs against previous version', () => {
    const tempDir = makeTempDir('diff');
    const prevPath = path.join(tempDir, 'test_prev.md');
    const newPath = path.join(tempDir, 'test_new.md');
    
    fs.writeFileSync(prevPath, '# Heading 1\nSome old content.\n## Heading 2\nUnchanged content.', 'utf8');
    fs.writeFileSync(newPath, '# Heading 1\nSome new content.\n## Heading 2\nUnchanged content.\n### Heading 3\nBrand new stuff.', 'utf8');

    const result = runIngester(newPath, prevPath);
    
    assert.equal(result.chunks.length, 3);
    
    // Heading 1 changed
    assert.equal(result.chunks[0].section_heading, 'Heading 1');
    assert.equal(result.chunks[0].is_changed, true);
    assert.equal(result.chunks[0].change_type, 'modified');
    
    // Heading 2 unchanged
    assert.equal(result.chunks[1].section_heading, 'Heading 2');
    assert.equal(result.chunks[1].is_changed, false);
    assert.equal(result.chunks[1].change_type, 'unchanged');
    
    // Heading 3 added
    assert.equal(result.chunks[2].section_heading, 'Heading 3');
    assert.equal(result.chunks[2].is_changed, true);
    assert.equal(result.chunks[2].change_type, 'added');

    fs.rmSync(tempDir, { recursive: true });
  });
});
