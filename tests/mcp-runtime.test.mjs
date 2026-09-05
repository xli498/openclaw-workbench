import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServerRuntime } from '../runtime/mcp-runtime.mjs';

function registryFor(serverOverrides = {}) {
  const server = { id: 'demo', name: 'Demo', transport: 'stdio', command: 'node', args: ['server.mjs'], endpoint: null, tools: ['read_file'], configHash: 'a'.repeat(64), enabled: true, ...serverOverrides };
  return { get: (id) => id === server.id ? { ...server } : null };
}

function fakeTransport(result = { content: [{ type: 'text', text: 'ok' }] }) {
  return { starts: 0, closes: 0, requests: [], async start() { this.starts += 1; return { status: 'ready' }; }, async request(method, params) { this.requests.push({ method, params }); return result; }, async close() { this.closes += 1; } };
}

test('MCP runtime requires approval and current config hash to start', async () => {
  const transport = fakeTransport();
  const runtime = createMcpServerRuntime({ registry: registryFor(), transportFactory: () => transport });
  await assert.rejects(runtime.start('demo', { expectedConfigHash: 'a'.repeat(64) }), { code: 'MCP_APPROVAL_REQUIRED' });
  await assert.rejects(runtime.start('demo', { expectedConfigHash: 'b'.repeat(64), approved: true }), { code: 'MCP_CONFLICT' });
  const started = await runtime.start('demo', { expectedConfigHash: 'a'.repeat(64), approved: true });
  assert.deepEqual(started, { id: 'demo', transport: 'stdio', state: 'ready' });
  assert.equal(transport.starts, 1);
});

test('MCP runtime refuses disabled servers even with approval', async () => {
  const runtime = createMcpServerRuntime({ registry: registryFor({ enabled: false }), transportFactory: () => fakeTransport() });
  await assert.rejects(runtime.start('demo', { expectedConfigHash: 'a'.repeat(64), approved: true }), { code: 'MCP_SERVER_DISABLED' });
});

test('MCP runtime only calls an explicitly allowlisted tool', async () => {
  const transport = fakeTransport();
  const runtime = createMcpServerRuntime({ registry: registryFor(), transportFactory: () => transport });
  await runtime.start('demo', { expectedConfigHash: 'a'.repeat(64), approved: true });
  await assert.rejects(runtime.callTool('demo', 'write_file', {}, { expectedConfigHash: 'a'.repeat(64), approved: true }), { code: 'MCP_TOOL_NOT_AUTHORIZED' });
  await assert.rejects(runtime.callTool('demo', 'read_file', {}, { expectedConfigHash: 'a'.repeat(64) }), { code: 'MCP_APPROVAL_REQUIRED' });
  const result = await runtime.callTool('demo', 'read_file', { path: 'safe.txt' }, { expectedConfigHash: 'a'.repeat(64), approved: true });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual(transport.requests[0], { method: 'tools/call', params: { name: 'read_file', arguments: { path: 'safe.txt' } } });
});

test('MCP runtime stop closes the transport and prevents reuse', async () => {
  const transport = fakeTransport();
  const runtime = createMcpServerRuntime({ registry: registryFor(), transportFactory: () => transport });
  await runtime.start('demo', { expectedConfigHash: 'a'.repeat(64), approved: true });
  assert.deepEqual(await runtime.stop('demo'), { id: 'demo', state: 'stopped' });
  assert.equal(transport.closes, 1);
  await assert.rejects(runtime.callTool('demo', 'read_file', {}, { expectedConfigHash: 'a'.repeat(64), approved: true }), { code: 'MCP_NOT_RUNNING' });
});

test('MCP runtime stop invalidates an in-flight start', async () => {
  let resolveStart;
  const transport = { starts: 0, closes: 0, async start() { this.starts += 1; return new Promise((resolve) => { resolveStart = resolve; }); }, async close() { this.closes += 1; }, async request() {} };
  const runtime = createMcpServerRuntime({ registry: registryFor(), transportFactory: () => transport });
  const pending = runtime.start('demo', { expectedConfigHash: 'a'.repeat(64), approved: true });
  await runtime.stop('demo');
  resolveStart({ status: 'ready' });
  await assert.rejects(pending, { code: 'MCP_RUNTIME_CLOSED' });
  assert.equal(transport.closes, 1);
});

test('MCP runtime keeps independent server starts isolated', async () => {
  const pending = new Map();
  const servers = [{ id: 'one', name: 'one', transport: 'stdio', command: 'node', args: [], tools: [], configHash: 'o'.repeat(64), enabled: true }, { id: 'two', name: 'two', transport: 'stdio', command: 'node', args: [], tools: [], configHash: 't'.repeat(64), enabled: true }];
  const runtime = createMcpServerRuntime({
    registry: { get: (id) => servers.find((server) => server.id === id) },
    transportFactory: (server) => ({ async start() { return new Promise((resolve) => pending.set(server.id, resolve)); }, async close() {}, async request() {} }),
  });
  const first = runtime.start('one', { expectedConfigHash: 'o'.repeat(64), approved: true });
  const second = runtime.start('two', { expectedConfigHash: 't'.repeat(64), approved: true });
  await new Promise((resolve) => setImmediate(resolve));
  pending.get('one')({ status: 'ready' });
  assert.deepEqual(await first, { id: 'one', transport: 'stdio', state: 'ready' });
  pending.get('two')({ status: 'ready' });
  assert.deepEqual(await second, { id: 'two', transport: 'stdio', state: 'ready' });
  await runtime.close();
});
