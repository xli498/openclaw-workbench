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

test('红队真实攻击：HTTP response 洪泛在达到上限时被中止', async () => {
  let clientClosed = false;
  await withServer(async (request, response) => {
    request.on('close', () => { clientClosed = true; });
    response.setHeader('content-type', 'application/json');
    response.write('{"jsonrpc":"2.0","id":"flood","result":"');
    const interval = setInterval(() => {
      if (response.destroyed) return clearInterval(interval);
      response.write('x'.repeat(4_096));
    }, 1);
    response.on('close', () => clearInterval(interval));
  }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, maxFrameBytes: 128 });
    await transport.start();
    await assert.rejects(transport.request('flood'), (error) => error.code === 'MCP_FRAME_LIMIT');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(clientClosed, true);
    assert.equal(transport.getState(), 'failed');
    await transport.close();
  });
});

test('红队真实攻击：HTTP endpoint 凭据和敏感查询不会进入 transport', () => {
  for (const endpoint of ['https://attacker:secret@example.com/mcp', 'https://example.com/mcp?access_token=secret']) {
    assert.throws(() => createMcpHttpTransport({ endpoint }), (error) => error.code === 'MCP_ENDPOINT_INVALID' && !error.message.includes('secret'));
  }
  assert.throws(() => createMcpHttpTransport({ endpoint: 'https://example.com/mcp', headers: { 'x-injected': 'ok\r\nX-Injected: yes' } }), { code: 'MCP_HEADERS_INVALID' });
});

test('红队真实攻击：恶意 SSE 数据不会作为错误文本回显', async () => {
  const secret = 'attacker-secret-value';
  await withServer(async (_request, response) => {
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${secret}\n\n`);
  }, async (endpoint) => {
    const transport = createMcpHttpTransport({ endpoint, transport: 'sse' });
    await transport.start();
    await assert.rejects(transport.request('malicious-sse'), (error) => error.code === 'MCP_FRAME_INVALID' && !error.message.includes(secret));
    await transport.close();
  });
});
