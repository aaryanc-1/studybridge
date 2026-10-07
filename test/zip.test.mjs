// "Download my data" makes a real ZIP file (checked by unzipping it with the system's own tools)
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataZip } from '../src/lib/zip.js';

test('download my data: a ZIP with one JSON file per kind of thing', async () => {
  const blob = dataZip({ account: { name: 'Aaryan' }, assignments: [{ title: 'Algebra – ünïcode ✓' }] });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const dir = mkdtempSync(join(tmpdir(), 'sbzip-'));
  try {
    const file = join(dir, 'data.zip');
    writeFileSync(file, bytes);
    const out = join(dir, 'out');
    if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${out}'`]);
    else execFileSync('unzip', ['-q', file, '-d', out]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'assignments.json'), 'utf8')), [{ title: 'Algebra – ünïcode ✓' }]);
    assert.match(readFileSync(join(out, 'README.txt'), 'utf8'), /Your StudyBridge data/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
