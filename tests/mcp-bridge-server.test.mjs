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
