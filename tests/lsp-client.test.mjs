import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLspClient } from '../runtime/lsp-client.mjs';

const FIXTURE = new URL('./fixtures/mock-lsp-server.mjs', import.meta.url).pathname;

test('LSP client initializes, answers read-only hover, and never executes server requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-'));
  const recordPath = path.join(root, 'frames.jsonl');
  const client = createLspClient({ command: process.execPath, args: [FIXTURE, recordPath], root });
  try {
    const started = await client.start();
    assert.equal(started.status, 'ready');
    assert.equal(started.capabilities.hoverProvider, true);
    const hover = await client.request('textDocument/hover', { textDocument: { uri: 'file:///example.txt' }, position: { line: 0, character: 0 } });
    assert.equal(hover.contents.value, 'mock hover');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const serverRequestAnswer = frames.find((frame) => frame.id === 999);
    assert.equal(serverRequestAnswer.error.code, -32601);
    await assert.rejects(client.request('workspace/applyEdit', {}), (error) => error.code === 'LSP_METHOD_NOT_ALLOWED');
    await assert.rejects(client.request('workspace/executeCommand', {}), (error) => error.code === 'LSP_METHOD_NOT_ALLOWED');
    assert.deepEqual(await client.shutdown(), { status: 'closed' });
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('LSP client rejects shell and credential material before spawning', () => {
  assert.throws(() => createLspClient({ command: 'node; rm -rf /', root: '/tmp' }), { code: 'LSP_COMMAND_INVALID' });
  assert.throws(() => createLspClient({ command: process.execPath, args: ['--token=<redacted>'], root: '/tmp' }), { code: 'LSP_ARGS_INVALID' });
  assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { 'bad-key': 'v' } }), { code: 'LSP_ENV_INVALID' });
});

test('LSP client never leaks env values into errors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-env-'));
  const marker = 'lsp-env-marker-abcdef';
  const client = createLspClient({ command: '/nonexistent/lsp-binary-xyz', root, env: { LSP_TEST_VALUE: marker } });
  try {
    await assert.rejects(client.start(), (error) => !String(error.message).includes(marker) && !JSON.stringify(error.details ?? {}).includes(marker));
  } finally {
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

// Q30-2/Q30-4 follow-ups: a custom allowlist used to admit write
// methods unchecked, and the server inherited the whole parent env.
test('LSP client rejects forbidden methods even when explicitly allowlisted', () => {
  for (const method of ['workspace/executeCommand', 'workspace/applyEdit', 'textDocument/formatting', 'textDocument/rename']) {
    assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', allowedMethods: ['initialize', method] }), { code: 'LSP_METHOD_NOT_ALLOWED' });
  }
  // A custom allowlist can still add further read methods.
  const client = createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', allowedMethods: ['initialize', 'shutdown', 'textDocument/documentHighlight'] });
  assert.ok(client.getAllowedMethods().includes('textDocument/documentHighlight'));
  assert.equal(client.getAllowedMethods().includes('workspace/executeCommand'), false);
});

test('LSP client rejects shell and credential material in env values', () => {
  assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { LSP_BAD: '$(touch /tmp/x)' } }), { code: 'LSP_ENV_INVALID' });
  assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { LSP_BAD: 'a; rm -rf /' } }), { code: 'LSP_ENV_INVALID' });
  assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { LSP_BAD: 'token=abc123' } }), { code: 'LSP_ENV_INVALID' });
  assert.throws(() => createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { LSP_BAD: 'https://user:pass@example.com/x' } }), { code: 'LSP_ENV_INVALID' });
  const ok = createLspClient({ command: process.execPath, args: ['x'], root: '/tmp', env: { LSP_OK: 'plain-value_123' } });
  assert.equal(typeof ok.getRoot(), 'string');
});

test('LSP client spawns with an explicit env, never the whole parent env', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-lsp-explicit-env-'));
  const recordPath = path.join(root, 'env.jsonl');
  const fixture = new URL('./fixtures/mock-lsp-env-server.mjs', import.meta.url).pathname;
  process.env.OCW_P2_S4_PARENT_MARKER = 'parent-marker-should-not-leak';
  const client = createLspClient({ command: process.execPath, args: [fixture, recordPath], root, env: { LSP_TEST_VALUE: 'lsp-caller-value' } });
  try {
    const started = await client.start();
    assert.equal(started.status, 'ready');
    const snapshot = JSON.parse((await readFile(recordPath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(snapshot.parentMarkerPresent, false);
    assert.equal(snapshot.callerValuePresent, true);
    assert.equal(snapshot.pathPresent, true);
    await client.shutdown();
  } finally {
    delete process.env.OCW_P2_S4_PARENT_MARKER;
    await client.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
