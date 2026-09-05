import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMcpStdioTransport, McpTransportError } from '../runtime/mcp-transport.mjs';

class FakeStream extends EventEmitter {
  constructor() { super(); this.writes = []; }
  write(value) { this.writes.push(value); return true; }
  end() { this.emit('finish'); }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killed = false;
  }
  kill() { this.killed = true; this.emit('close', 0, null); return true; }
}

function harness(options = {}) {
  const child = new FakeChild();
  const calls = [];
  const transport = createMcpStdioTransport({
    command: 'node',
    args: ['server.mjs'],
    cwd: 'C:/workbench',
    spawnImpl: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      return child;
    },
    ...options,
  });
  return { child, calls, transport };
}

test('MCP stdio transport starts explicitly with shell disabled', async () => {
  const { child, calls, transport } = harness();
  assert.equal(transport.getState(), 'disconnected');
  await transport.start();
  assert.equal(transport.getState(), 'ready');
  assert.deepEqual(calls[0], {
    command: 'node',
    args: ['server.mjs'],
    spawnOptions: { cwd: 'C:/workbench', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  });
  assert.equal(child.stderr.listenerCount('data'), 1);
  await transport.close();
});

test('MCP stdio transport correlates JSON-RPC responses by id', async () => {
  const { child, transport } = harness();
  await transport.start();
  const pending = transport.request('tools/list', { cursor: null });
  const frame = JSON.parse(child.stdin.writes[0]);
  assert.equal(frame.jsonrpc, '2.0');
  assert.equal(frame.method, 'tools/list');
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { tools: [] } })}\n`));
  assert.deepEqual(await pending, { tools: [] });
  await transport.close();
});

test('MCP stdio transport validates each frame when stdout batches multiple lines', async () => {
  const { child, transport } = harness({ maxFrameBytes: 128 });
  await transport.start();
  const first = transport.request('first');
  const second = transport.request('second');
  const firstId = JSON.parse(child.stdin.writes[0]).id;
  const secondId = JSON.parse(child.stdin.writes[1]).id;
  const frames = `${JSON.stringify({ jsonrpc: '2.0', id: firstId, result: { ok: true } })}\n${JSON.stringify({ jsonrpc: '2.0', id: secondId, result: { ok: true } })}\n`;
  assert.ok(Buffer.byteLength(frames) > 128);
  child.stdout.emit('data', Buffer.from(frames));
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  await transport.close();
});

test('MCP stdio transport preserves UTF-8 characters split across stdout chunks', async () => {
  const { child, transport } = harness();
  await transport.start();
  const pending = transport.request('echo');
  const id = JSON.parse(child.stdin.writes[0]).id;
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: { text: '中文' } })}\n`);
  const split = bytes.indexOf(0xe4);
  child.stdout.emit('data', bytes.subarray(0, split + 1));
  child.stdout.emit('data', bytes.subarray(split + 1));
  assert.deepEqual(await pending, { text: '中文' });
  await transport.close();
});

test('MCP stdio transport supports abort and request timeout', async () => {
  const { transport } = harness({ requestTimeoutMs: 5 });
  await transport.start();
  const controller = new AbortController();
  const aborted = transport.request('slow', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, (error) => error instanceof McpTransportError && error.code === 'MCP_REQUEST_ABORTED');
  await assert.rejects(transport.request('timeout'), (error) => error.code === 'MCP_REQUEST_TIMEOUT');
  await transport.close();
});

test('MCP stdio transport rejects oversized frames and pending requests on close', async () => {
  const { child, transport } = harness({ maxFrameBytes: 32 });
  await transport.start();
  const pending = transport.request('pending');
  child.stdout.emit('data', Buffer.from(`${'x'.repeat(40)}\n`));
  await assert.rejects(pending, (error) => error.code === 'MCP_FRAME_LIMIT');
  assert.equal(child.killed, true);
  assert.equal(transport.getState(), 'failed');
  await transport.close();
});

test('MCP stdio transport turns an asynchronous stdin error into a failed request', async () => {
  const { child, transport } = harness();
  await transport.start();
  const pending = transport.request('write');
  child.stdin.emit('error', new Error('broken pipe'));
  await assert.rejects(pending, (error) => error.code === 'MCP_STDIN_ERROR');
  assert.equal(transport.getState(), 'failed');
  await transport.close();
});

test('MCP stdio transport discards partial frames before a later explicit restart', async () => {
  const children = [];
  const transport = createMcpStdioTransport({
    command: 'node',
    spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; },
  });
  await transport.start();
  const stale = transport.request('stale');
  children[0].stdout.emit('data', Buffer.from('{"jsonrpc":"2.0"'));
  children[0].emit('close', 0, null);
  await assert.rejects(stale, (error) => error.code === 'MCP_PROCESS_CLOSED');
  await transport.start();
  const fresh = transport.request('fresh');
  const id = JSON.parse(children[1].stdin.writes[0]).id;
  children[1].stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`));
  assert.deepEqual(await fresh, { ok: true });
  await transport.close();
});

test('MCP stdio transport ignores late events from an older child after restart', async () => {
  const children = [];
  const transport = createMcpStdioTransport({
    command: 'node',
    spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; },
  });
  await transport.start();
  const stale = transport.request('stale');
  await transport.close();
  await assert.rejects(stale, (error) => error.code === 'MCP_TRANSPORT_CLOSED');
  await transport.start();
  const fresh = transport.request('fresh');
  const id = JSON.parse(children[1].stdin.writes[0]).id;
  children[0].stdout.emit('data', Buffer.from('{"bad":'));
  children[0].stdin.emit('error', new Error('old pipe'));
  children[0].emit('close', 0, null);
  assert.equal(transport.getState(), 'ready');
  children[1].stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`));
  assert.deepEqual(await fresh, { ok: true });
  await transport.close();
});

test('package exports the MCP stdio transport', async () => {
  const pkg = await import('openclaw-workbench');
  assert.equal(typeof pkg.createMcpStdioTransport, 'function');
});
