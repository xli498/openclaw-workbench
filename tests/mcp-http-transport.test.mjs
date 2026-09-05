import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMcpHttpTransport } from '../runtime/mcp-http-transport.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await run(`http://127.0.0.1:${address.port}/mcp`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

test('MCP HTTP transport validates endpoint and starts without network I/O', async () => {
  let fetchCalls = 0;
  const transport = createMcpHttpTransport({ endpoint: 'https://example.com/mcp', fetchImpl: async () => { fetchCalls += 1; } });
  assert.equal(transport.getState(), 'disconnected');
  await transport.start();
  assert.equal(transport.getState(), 'ready');
  assert.equal(fetchCalls, 0);
  await transport.close();
  assert.throws(() => createMcpHttpTransport({ endpoint: 'https://user:pass@example.com/mcp' }), { code: 'MCP_ENDPOINT_INVALID' });
  assert.throws(() => createMcpHttpTransport({ endpoint: 'https://example.com/mcp?token=secret' }), { code: 'MCP_ENDPOINT_INVALID' });
});

test('MCP HTTP transport sends JSON-RPC over POST and captures session id', async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.accept, 'application/json, text/event-stream');
    const body = JSON.parse(await readBody(request));
    response.setHeader('content-type', 'application/json');
    response.setHeader('mcp-session-id', 'session-from-server');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }));
  }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, headers: { authorization: 'Bearer test-only' } });
    await transport.start();
    assert.deepEqual(await transport.request('tools/list', { cursor: null }), { ok: true });
    assert.equal(transport.getState(), 'ready');
    await transport.close();
  });
});

test('MCP HTTP transport parses an SSE response without exposing raw event data', async () => {
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    response.setHeader('content-type', 'text/event-stream');
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`);
  }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, transport: 'sse' });
    await transport.start();
    assert.deepEqual(await transport.request('tools/list'), { tools: [] });
    await transport.close();
  });
});

test('MCP HTTP transport enforces timeout, abort, status, and frame limits', async () => {
  await withServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    if (body.method === 'slow') return setTimeout(() => response.end(), 100);
    if (body.method === 'bad-status') { response.statusCode = 503; return response.end('unavailable'); }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { text: 'x'.repeat(1_000) } }));
  }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, requestTimeoutMs: 20, maxFrameBytes: 256 });
    await transport.start();
    await assert.rejects(transport.request('slow'), (error) => error.code === 'MCP_REQUEST_TIMEOUT');
    const controller = new AbortController();
    const aborted = transport.request('slow', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, (error) => error.code === 'MCP_REQUEST_ABORTED');
    await assert.rejects(transport.request('bad-status'), (error) => error.code === 'MCP_HTTP_STATUS');
    await assert.rejects(transport.request('large'), (error) => error.code === 'MCP_FRAME_LIMIT');
    await transport.close();
  });
});

test('MCP HTTP transport rejects invalid headers and malformed responses', async () => {
  assert.throws(() => createMcpHttpTransport({ endpoint: 'https://example.com/mcp', headers: { 'x-test': 'ok\r\n' } }), { code: 'MCP_HEADERS_INVALID' });
  await withServer(async (request, response) => { await readBody(request); response.setHeader('content-type', 'application/json'); response.end('not-json'); }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint });
    await transport.start();
    await assert.rejects(transport.request('bad-json'), (error) => error.code === 'MCP_FRAME_INVALID');
    assert.equal(transport.getState(), 'failed');
    await transport.close();
  });
});

test('MCP HTTP transport close cancels an in-flight request', async () => {
  await withServer(async (request, response) => { await readBody(request); setTimeout(() => response.end('{}'), 100); }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, requestTimeoutMs: 500 });
    await transport.start();
    const pending = transport.request('slow-close');
    await transport.close();
    await assert.rejects(pending, (error) => error.code === 'MCP_TRANSPORT_CLOSED');
    assert.equal(transport.getState(), 'disconnected');
  });
});

test('package exports the constrained MCP HTTP transport', async () => {
  const pkg = await import('openclaw-workbench');
  assert.equal(typeof pkg.createMcpHttpTransport, 'function');
});
