import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpHttpTransport } from '../runtime/mcp-http-transport.mjs';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';

const TOKEN = 'bridge-token-012345';
const VERSION = '2025-06-18';

function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (predicate() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error('timed out waiting for SSE frame')) : setTimeout(tick, 10));
    tick();
  });
}

test('MCP streamable HTTP: initialize negotiates, GET stream receives broadcast, DELETE terminates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-stream-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${address.port}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } });
    await transport.start();
    const negotiated = await transport.initialize();
    assert.equal(negotiated.protocolVersion, VERSION);
    assert.equal(transport.getProtocolVersion(), VERSION);
    assert.ok(transport.getSessionId());
    const received = [];
    const stream = transport.subscribe({ onNotification: (frame) => received.push(frame), onMessage: (frame) => received.push(frame) });
    await waitFor(() => bridge.streamCount(transport.getSessionId()) === 1);
    const broadcast = bridge.broadcast(transport.getSessionId(), { method: 'notifications/test-event', params: { note: 'hello' } });
    assert.equal(broadcast.delivered, 1);
    await waitFor(() => received.some((frame) => frame.method === 'notifications/test-event'));
    assert.equal(received.find((frame) => frame.method === 'notifications/test-event').params.note, 'hello');
    stream.close();
    assert.deepEqual(await transport.terminateSession(), { status: 'terminated' });
    assert.equal(transport.getSessionId(), null);
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP streamable HTTP: notify accepts 202 and subscribe requires a session', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (parsed.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'mock-session');
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: VERSION, capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }));
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    assert.throws(() => transport.subscribe({}), { code: 'MCP_SESSION_REQUIRED' });
    await transport.initialize();
    assert.deepEqual(await transport.notify('notifications/ping', {}), { status: 202 });
    await transport.close();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('MCP SSE parser ignores malformed events and enforces the frame limit', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.write(': keep-alive\n\n');
        response.write('data: not-json\n\n');
        response.write(`id: evt-1\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ok', params: {} })}\n\n`);
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/big', params: { text: 'x'.repeat(5000) } })}\n\n`);
        return response.end();
      }
      if (parsed.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'mock-session');
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: VERSION, capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }));
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp`, maxFrameBytes: 1024 });
    await transport.start();
    await transport.initialize();
    const received = [];
    const errors = [];
    const stream = transport.subscribe({ onNotification: (frame) => received.push(frame), onError: (error) => errors.push(error) });
    await waitFor(() => received.some((frame) => frame.method === 'notifications/ok'));
    await assert.rejects(stream.closedPromise, (error) => error.code === 'MCP_FRAME_LIMIT');
    assert.equal(errors[0]?.code, 'MCP_FRAME_LIMIT');
    await transport.close();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('MCP bridge broadcast validates session and notification shape', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-broadcast-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  await bridge.start();
  try {
    assert.throws(() => bridge.broadcast('missing-session', { method: 'notifications/x', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.equal(bridge.sessionCount(), 0);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
