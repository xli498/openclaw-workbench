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

async function startBridge() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-session404-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  return { root, bridge, address };
}

function transportFor(address) {
  return createMcpHttpTransport({ endpoint: `http://127.0.0.1:${address.port}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } });
}

async function deleteSession(address, sessionId) {
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION } });
  assert.equal(response.status, 204);
}

// Spec session rule: when a client receives 404 for a request carrying
// a session id, it MUST start a new session with a bare
// InitializeRequest. The old transport kept the dead id, so the next
// initialize sent it back and the server answered 400 (session
// fixation) — the transport was wedged until close(). After a 404 the
// transport must therefore clear the stale id and report the session
// loss distinctly, so initialize() works again immediately.
test('MCP session recovery: a 404 request clears the dead session and the next initialize succeeds', async () => {
  const { root, bridge, address } = await startBridge();
  try {
    const transport = transportFor(address);
    await transport.start();
    await transport.initialize();
    const oldId = transport.getSessionId();
    assert.ok(oldId);
    await deleteSession(address, oldId);
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    assert.equal(transport.getProtocolVersion(), null);
    // Without re-initializing, the next request is a plain HTTP error
    // (the server answers 400 for a missing session id), not a
    // repeated session error and not a wedge.
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    // And a bare initialize now works and yields a fresh session.
    await transport.initialize();
    const newId = transport.getSessionId();
    assert.ok(newId);
    assert.notEqual(newId, oldId);
    assert.deepEqual(await transport.request('ping'), {});
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP session recovery: a 404 notification clears the dead session too', async () => {
  const { root, bridge, address } = await startBridge();
  try {
    const transport = transportFor(address);
    await transport.start();
    await transport.initialize();
    const oldId = transport.getSessionId();
    await deleteSession(address, oldId);
    await assert.rejects(transport.notify('notifications/ping', {}), (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    await transport.initialize();
    assert.notEqual(transport.getSessionId(), oldId);
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP session recovery: a 404 GET stream reports session loss and clears the id before onError runs', async () => {
  const { root, bridge, address } = await startBridge();
  try {
    const transport = transportFor(address);
    await transport.start();
    await transport.initialize();
    const oldId = transport.getSessionId();
    await deleteSession(address, oldId);
    const errors = [];
    const stream = transport.subscribe({ onError: (error) => errors.push(error) });
    await assert.rejects(stream.closedPromise, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(errors[0]?.code, 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    await transport.initialize();
    assert.notEqual(transport.getSessionId(), oldId);
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP session recovery: a 404 with no session id carried stays a plain HTTP error', async () => {
  const server = createServer((request, response) => {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${port}/mcp` });
    await transport.start();
    // No session id is carried here, so this 404 cannot be a terminated
    // session: it must not be recoded as a session error.
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    await assert.rejects(transport.initialize(), (error) => error.code === 'MCP_HTTP_STATUS');
    await transport.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
