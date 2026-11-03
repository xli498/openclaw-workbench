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

// Q28-3/Q28-4 follow-ups: server-request replies used to bypass the
// frame limit and swallow every failure, and a throwing onError could
// strand closedPromise forever. These tests pin the fixed behavior.
function serverRequestMock({ onReply, replyStatus = 202 } = {}) {
  const held = [];
  const replies = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.write(`id: evt-1\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'server/ping', params: {} })}\n\n`);
        held.push(response);
        return;
      }
      if (parsed.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', 'mock-session');
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: VERSION, capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }));
      }
      // Only a server-request reply (id + result) counts as a reply:
      // the notifications/initialized notify sent during initialize
      // is a plain notification and must not be counted or failed.
      const isReply = parsed.id !== undefined && parsed.result !== undefined;
      if (isReply) replies.push(parsed);
      onReply?.(parsed);
      response.statusCode = isReply ? replyStatus : 202;
      response.end();
    });
  });
  return {
    server, replies, held,
    close: async () => {
      for (const response of held) { try { response.destroy(); } catch {} }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('MCP streamable HTTP: oversize server-request reply hits the frame limit and is never sent', async () => {
  const mock = serverRequestMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp`, maxFrameBytes: 1024 });
    await transport.start();
    await transport.initialize();
    const errors = [];
    const stream = transport.subscribe({ onRequest: async () => ({ text: 'x'.repeat(5000) }), onError: (error) => errors.push(error) });
    await waitFor(() => errors.length > 0);
    assert.equal(errors[0].code, 'MCP_FRAME_LIMIT');
    assert.equal(mock.replies.length, 0);
    assert.equal(stream.closed, false);
    await transport.close();
  } finally { await mock.close(); }
});

test('MCP streamable HTTP: failed server-request reply surfaces via onError', async () => {
  const mock = serverRequestMock({ replyStatus: 500 });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    await transport.initialize();
    const errors = [];
    transport.subscribe({ onRequest: async () => ({ ok: true }), onError: (error) => errors.push(error) });
    await waitFor(() => errors.length > 0);
    assert.equal(errors[0].code, 'MCP_HTTP_STATUS');
    assert.equal(mock.replies.length, 1);
    assert.equal(mock.replies[0].id, 'req-1');
    await transport.close();
  } finally { await mock.close(); }
});

test('MCP streamable HTTP: throwing server-request handler surfaces via onError', async () => {
  const mock = serverRequestMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    await transport.initialize();
    const errors = [];
    transport.subscribe({ onRequest: async () => { throw new Error('handler boom'); }, onError: (error) => errors.push(error) });
    await waitFor(() => errors.length > 0);
    assert.equal(errors[0].code, 'MCP_REQUEST_FAILED');
    assert.equal(mock.replies.length, 0);
    await transport.close();
  } finally { await mock.close(); }
});

test('MCP streamable HTTP: throwing onError cannot strand closedPromise', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
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
    const stream = transport.subscribe({ onError: () => { throw new Error('onError boom'); } });
    await assert.rejects(stream.closedPromise, (error) => error.code === 'MCP_FRAME_LIMIT');
    await transport.close();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('MCP streamable HTTP: terminateSession closes a live subscription', async () => {
  const mock = serverRequestMock();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const port = mock.server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    await transport.initialize();
    // The mock GET stream stays open on DELETE (unlike the bridge,
    // which ends it), so only the terminate-closes-subscription link
    // can close this stream.
    const stream = transport.subscribe({ onRequest: async () => undefined });
    await waitFor(() => mock.held.length === 1);
    assert.deepEqual(await transport.terminateSession(), { status: 'terminated' });
    assert.equal(stream.closed, true);
    assert.deepEqual(await stream.closedPromise, { status: 'closed', lastEventId: 'evt-1' });
    assert.equal(transport.getSessionId(), null);
    await transport.close();
  } finally { await mock.close(); }
});

test('MCP bridge broadcast expires an idle session before delivering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-broadcast-expire-'));
  let now = 1_000_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), idleSessionMs: 5000, clock: () => now });
  const address = await bridge.start();
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${address.port}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } });
    await transport.start();
    await transport.initialize();
    const sessionId = transport.getSessionId();
    assert.ok(sessionId);
    // Advance past the idle timeout without letting the real 5s sweep
    // timer fire: only broadcast's own expireSessions can close it.
    now += 6000;
    assert.throws(() => bridge.broadcast(sessionId, { method: 'notifications/late', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.equal(bridge.sessionCount(), 0);
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
