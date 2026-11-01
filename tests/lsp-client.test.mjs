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
