import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBrokerReadyContent, runWindowsFileOperationSync } from '../runtime/windows-path-lock.mjs';
import { symlinkSyncOrSkip } from './test-support.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('Windows path lock ignores an incompletely written ready file', () => {
  assert.equal(isBrokerReadyContent(''), false);
  assert.equal(isBrokerReadyContent('O'), false);
  assert.equal(isBrokerReadyContent('OK'), true);
  assert.equal(isBrokerReadyContent('ERROR:broker failure'), true);
});

test('Windows file helper writes, replaces, and reads regular files', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific regression');
  const root = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-'));
  try {
    const target = path.join(root, 'state.json');
    runWindowsFileOperationSync({
      operation: 'write',
      root,
      parent: root,
      target,
      contentBase64: Buffer.from('{"ok":true}', 'utf8').toString('base64'),
    });
    const source = path.join(root, 'replacement.json');
    writeFileSync(source, '{"ok":false}', 'utf8');
    runWindowsFileOperationSync({
      operation: 'replace',
      root,
      parent: root,
      target,
      source,
      expectedSourceHash: sha256('{"ok":false}'),
      expectedTargetHash: sha256('{"ok":true}'),
    });
    const encoded = runWindowsFileOperationSync({ operation: 'read', root, parent: root, target });
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '{"ok":false}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows file helper rejects a junction parent without following it', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific regression');
  const root = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-outside-'));
  const junction = path.join(root, 'junction');
  try {
    if (!symlinkSyncOrSkip(t, outside, junction, 'junction')) return;
    assert.throws(() => runWindowsFileOperationSync({
      operation: 'write', root, parent: junction, target: path.join(junction, 'state.json'),
      contentBase64: Buffer.from('attacker', 'utf8').toString('base64'), expectTargetMissing: true,
    }));
    assert.equal(existsSync(path.join(outside, 'state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Windows file helper does not replace through a final junction', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific regression');
  const root = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-root-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-outside-'));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source.json');
  try {
    if (!symlinkSyncOrSkip(t, outside, target, 'junction')) return;
    writeFileSync(source, 'safe', 'utf8');
    assert.throws(() => runWindowsFileOperationSync({ operation: 'replace', root, parent: root, target, source }));
    assert.equal(existsSync(path.join(outside, 'source.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Windows file helper cleans a temporary file when a digest check rejects replace', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific regression');
  const root = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-'));
  try {
    const target = path.join(root, 'target.json');
    const source = path.join(root, 'source.json');
    writeFileSync(target, 'before', 'utf8');
    writeFileSync(source, 'after', 'utf8');
    assert.throws(() => runWindowsFileOperationSync({ operation: 'replace', root, parent: root, target, source, expectedTargetHash: sha256('not-before') }));
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.ocw-temp-')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows file helper atomically creates a nested manifest-length destination', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-specific regression');
  const root = mkdtempSync(path.join(tmpdir(), 'ocw-file-ops-'));
  const parent = path.join(root, '.openclaw-workbench', 'transactions');
  const transactionId = '12345678-1234-1234-1234-123456789abc';
  const target = path.join(parent, `${transactionId}.json`);
  const source = path.join(parent, `${transactionId}.json.tmp-${transactionId}`);
  try {
    mkdirSync(parent, { recursive: true });
    runWindowsFileOperationSync({ operation: 'write', root, parent, target: source, contentBase64: Buffer.from('{"state":"prepared"}', 'utf8').toString('base64'), expectTargetMissing: true });
    runWindowsFileOperationSync({ operation: 'replace', root, parent, target, source });
    const encoded = runWindowsFileOperationSync({ operation: 'read', root, parent, target });
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), '{"state":"prepared"}');
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith('.ocw-temp-')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
