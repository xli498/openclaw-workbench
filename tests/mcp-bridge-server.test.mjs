import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

const TOKEN = 'bridge-token-012345';
const VERSION = '2025-06-18';

function endpoint(address, pathname = '/mcp') {
  return `http://${address.address}:${address.port}${pathname}`;
}

function headers(extra = {}) {
  return {
    authorization: `Bearer ${TOKEN}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...extra,
  };
}

async function post(address, body, extraHeaders = {}, pathname = '/mcp') {
  const response = await fetch(endpoint(address, pathname), { method: 'POST', headers: headers(extraHeaders), body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

async function initialize(address, extraHeaders = {}, pathname = '/mcp') {
  return post(address, {
    jsonrpc: '2.0',
    id: 'initialize-1',
    method: 'initialize',
    params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } },
  }, extraHeaders, pathname);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('MCP bridge initializes a loopback session, lists tools, calls read tools, and returns code proposals without mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-'));
  await writeFile(path.join(root, 'README.md'), 'bridge fixture\n');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const initialized = await initialize(address);
    assert.equal(initialized.response.status, 200);
    assert.equal(initialized.body.result.protocolVersion, VERSION);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    assert.match(sessionId, /^[!-~]+$/);

    const listed = await post(address, { jsonrpc: '2.0', id: 'tools-1', method: 'tools/list', params: {} }, {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': VERSION,
    });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.result.tools.some((tool) => tool.name === 'workspace.read_files'), true);
    assert.equal(listed.body.result.tools.some((tool) => tool.name === 'workspace.patch'), true);
    assert.equal(listed.body.result.tools.find((tool) => tool.name === 'workspace.read_files').annotations.readOnlyHint, true);

    const read = await post(address, { jsonrpc: '2.0', id: 'read-1', method: 'tools/call', params: { name: 'workspace.read_files', arguments: { paths: ['README.md'] } } }, {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': VERSION,
    });
    assert.equal(read.response.status, 200);
    assert.equal(read.body.result.isError, undefined);
    assert.equal(read.body.result.structuredContent.files[0].content, 'bridge fixture\n');

    const proposal = await post(address, { jsonrpc: '2.0', id: 'patch-1', method: 'tools/call', params: { name: 'workspace.patch', arguments: { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-bridge fixture\n+changed\n', declaredPaths: ['README.md'] } } }, {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': VERSION,
    });
    assert.equal(proposal.response.status, 200);
    assert.equal(proposal.body.result.structuredContent.approvalRequired, true);
    assert.equal(proposal.body.result.structuredContent.proposal.status, 'awaiting_approval');
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'bridge fixture\n');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge supports bounded POST SSE, GET streams, and DELETE session close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-stream-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const initialized = await initialize(address);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const sse = await fetch(endpoint(address), {
      method: 'POST',
      headers: headers({ accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping', params: {} }),
    });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /^text\/event-stream/);
    assert.match(await sse.text(), /"id":"ping-1"/);

    const stream = await fetch(endpoint(address), { headers: headers({ accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }) });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
    await stream.body.cancel();

    const closed = await fetch(endpoint(address), { method: 'DELETE', headers: headers({ 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }) });
    assert.equal(closed.status, 204);
    const afterClose = await post(address, { jsonrpc: '2.0', id: 'after-close', method: 'ping', params: {} }, { 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION });
    assert.equal(afterClose.response.status, 404);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge expires an idle SSE session and stops without retaining the stream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-idle-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), idleSessionMs: 40 });
  const address = await bridge.start();
  try {
    const initialized = await initialize(address);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const stream = await fetch(endpoint(address), { headers: headers({ accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }) });
    assert.equal(stream.status, 200);
    const endedWhileIdle = await Promise.race([stream.text().then(() => true), wait(250).then(() => false)]);
    assert.equal(endedWhileIdle, true);
    const expired = await post(address, { jsonrpc: '2.0', id: 'expired-session', method: 'ping', params: {} }, { 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION });
    assert.equal(expired.response.status, 404);
    await bridge.stop();
    assert.equal(bridge.address(), null);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge serves requests on an IPv6 loopback host and rejects non-loopback hosts on every entry point', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-ipv6-'));
  try {
    // Non-loopback hosts are rejected at construction, directly and
    // through the control-plane entry point that forwards host options.
    for (const host of ['0.0.0.0', '192.168.1.1', 'example.com', '::']) {
      assert.throws(() => createMcpBridgeServer({ root, token: TOKEN, host, registry: createToolRegistry({ root }) }), { code: 'MCP_BIND_INVALID' });
    }
    const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: 'approval-token-012345' });
    const controlAddress = await app.listen();
    try {
      assert.throws(() => app.createMcpBridge({ token: TOKEN, host: '0.0.0.0' }), { code: 'MCP_BIND_INVALID' });
    } finally {
      await app.close();
    }
    void controlAddress;

    // IPv6 request path: before the fix, handle() built an unbracketed
    // `http://::1` base URL outside any try, so every request on a ::1
    // bridge threw an unhandled rejection instead of being answered.
    const bridge = createMcpBridgeServer({ root, token: TOKEN, host: '::1', registry: createToolRegistry({ root }) });
    let address;
    try {
      address = await bridge.start();
    } catch (error) {
      if (['EADDRNOTAVAIL', 'ENODEV', 'EAFNOSUPPORT', 'EINVAL'].includes(error.code)) return t.skip('IPv6 loopback unavailable in this environment');
      throw error;
    }
    try {
      assert.match(address.address, /:/);
      const response = await fetch(`http://[${address.address}]:${address.port}/mcp`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 'initialize-v6', method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } } }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.protocolVersion, VERSION);
      assert.match(response.headers.get('mcp-session-id'), /^[!-~]+$/);
    } finally {
      await bridge.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge shares the control-plane proposal store so a Code proposal remains independently approvable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-control-'));
  const approvalToken = 'approval-token-012345';
  await writeFile(path.join(root, 'README.md'), 'before\n');
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken });
  const controlAddress = await app.listen();
  let bridge;
  try {
    bridge = app.createMcpBridge({ token: TOKEN });
    const bridgeAddress = await bridge.start();
    const initialized = await initialize(bridgeAddress);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const proposed = await post(bridgeAddress, { jsonrpc: '2.0', id: 'shared-patch', method: 'tools/call', params: { name: 'workspace.patch', arguments: { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-before\n+after\n', declaredPaths: ['README.md'] } } }, {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': VERSION,
    });
    const proposal = proposed.body.result.structuredContent.proposal;
    const approved = await fetch(`http://${controlAddress.address}:${controlAddress.port}/v1/proposals/${proposal.action.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-approval-token': approvalToken, 'content-type': 'application/json' },
      body: JSON.stringify({ actionHash: proposal.action.actionHash }),
    });
    assert.equal(approved.status, 200);
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'after\n');
  } finally {
    await bridge?.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge caps claimed request ids per session instead of growing without bound', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-id-cap-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), maxRequestIdsPerSession: 2 });
  const address = await bridge.start();
  try {
    const initialized = await initialize(address);
    assert.equal(initialized.response.status, 200);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const sessionHeaders = { 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION };
    for (const id of ['cap-ping-1', 'cap-ping-2']) {
      const ping = await post(address, { jsonrpc: '2.0', id, method: 'ping', params: {} }, sessionHeaders);
      assert.equal(ping.response.status, 200);
    }
    const over = await post(address, { jsonrpc: '2.0', id: 'cap-ping-3', method: 'ping', params: {} }, sessionHeaders);
    assert.equal(over.response.status, 429);
    assert.equal(over.body.error, 'MCP_REQUEST_ID_LIMIT');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge caps live SSE streams per session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-stream-cap-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), maxStreamsPerSession: 1 });
  const address = await bridge.start();
  try {
    const initialized = await initialize(address);
    const sessionId = initialized.response.headers.get('mcp-session-id');
    const streamHeaders = headers({ accept: 'text/event-stream', 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION });
    const first = await fetch(endpoint(address), { headers: streamHeaders });
    assert.equal(first.status, 200);
    try {
      const second = await fetch(endpoint(address), { headers: streamHeaders });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error, 'MCP_STREAM_LIMIT');
    } finally {
      await first.body.cancel();
    }
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP bridge still requires Bearer on the correct path-token route and never echoes the token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-path-bearer-'));
  const pathToken = 'path-token-route-012345';
  const bridge = createMcpBridgeServer({ root, token: TOKEN, pathToken, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  const pathname = bridge.endpointPath();
  try {
    const missing = await fetch(endpoint(address, pathname), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'no-bearer', method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    assert.equal(missing.status, 401);
    assert.equal((await missing.text()).includes(pathToken), false);
    const wrong = await fetch(endpoint(address, pathname), { method: 'POST', headers: headers({ authorization: 'Bearer wrong-token-012345' }), body: JSON.stringify({ jsonrpc: '2.0', id: 'wrong-bearer', method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.text()).includes(pathToken), false);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
