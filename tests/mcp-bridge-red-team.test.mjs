import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { WorkflowError } from '../runtime/workflow.mjs';

const TOKEN = 'bridge-token-012345';
const APPROVAL = 'approval-token-012345';
const VERSION = '2025-06-18';

function url(address, pathname = '/mcp') { return `http://${address.address}:${address.port}${pathname}`; }
function headers(extra = {}) { return { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra }; }
async function jsonRequest(address, body, extra = {}, pathname = '/mcp') {
  const response = await fetch(url(address, pathname), { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });
  return { response, body: await response.json() };
}
async function session(address, pathname = '/mcp') {
  const init = await jsonRequest(address, { jsonrpc: '2.0', id: `init-${Math.random()}`, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'red-team', version: '1' } } }, {}, pathname);
  assert.equal(init.response.status, 200);
  return init.response.headers.get('mcp-session-id');
}

test('red team: the bridge rejects unauthenticated, downgraded, fixed, replayed, and oversized requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-red-protocol-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), maxBodyBytes: 512 });
  const address = await bridge.start();
  try {
    const missing = await fetch(url(address), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(missing.status, 401);
    const wrong = await fetch(url(address), { method: 'POST', headers: { ...headers(), authorization: 'Bearer wrong-token' }, body: JSON.stringify({}) });
    assert.equal(wrong.status, 401);
    const fixed = await jsonRequest(address, { jsonrpc: '2.0', id: 'fixed', method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, { 'mcp-session-id': 'attacker-chosen-session' });
    assert.equal(fixed.response.status, 400);
    const old = await jsonRequest(address, { jsonrpc: '2.0', id: 'old', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    assert.equal(old.response.status, 400);
    const first = await session(address);
    const noVersion = await jsonRequest(address, { jsonrpc: '2.0', id: 'version', method: 'ping', params: {} }, { 'mcp-session-id': first });
    assert.equal(noVersion.response.status, 400);
    const replayBody = { jsonrpc: '2.0', id: 'replay-id', method: 'ping', params: {} };
    assert.equal((await jsonRequest(address, replayBody, { 'mcp-session-id': first, 'mcp-protocol-version': VERSION })).response.status, 200);
    const second = await session(address);
    const crossSession = await jsonRequest(address, replayBody, { 'mcp-session-id': second, 'mcp-protocol-version': VERSION });
    assert.equal(crossSession.response.status, 409);
    const oversized = await fetch(url(address), { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 'large', method: 'initialize', params: { protocolVersion: VERSION, padding: 'x'.repeat(2048) } }) });
    assert.equal(oversized.status, 413);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('red team: origin, path traversal, shell injection, approval bypass, and path-token leakage do not cross the bridge boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-red-tools-'));
  await writeFile(path.join(root, 'README.md'), 'safe\n');
  const pathToken = 'opaque-short-lived-route-token';
  const bridge = createMcpBridgeServer({ root, token: TOKEN, pathToken, pathTokenTtlMs: 60_000, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  const pathName = bridge.endpointPath();
  try {
    const defaultRoute = await fetch(url(address), { headers: headers() });
    assert.equal(defaultRoute.status, 404);
    assert.equal((await defaultRoute.text()).includes(pathToken), false);
    const origin = await fetch(url(address, pathName), { method: 'POST', headers: headers({ origin: 'https://attacker.example' }), body: JSON.stringify({}) });
    assert.equal(origin.status, 403);
    const active = await session(address, pathName);
    const call = async (id, name, argumentsValue) => jsonRequest(address, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsValue } }, { 'mcp-session-id': active, 'mcp-protocol-version': VERSION }, pathName);
    const escaped = await call('escape', 'workspace.read_files', { paths: ['../outside.txt'] });
    assert.equal(escaped.response.status, 200);
    assert.equal(escaped.body.result.isError, true);
    const injected = await call('inject', 'workspace.command', { argv: ['cmd', '/c', 'whoami & echo owned'] });
    assert.equal(injected.response.status, 200);
    assert.equal(injected.body.result.isError, true);
    const proposal = await call('proposal', 'workspace.patch', { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-safe\n+owned\n', declaredPaths: ['README.md'] });
    assert.equal(proposal.response.status, 200);
    assert.equal(proposal.body.result.structuredContent.approvalRequired, true);
    assert.equal(proposal.body.result.structuredContent.proposal.status, 'awaiting_approval');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('red team: an expired path token returns a generic endpoint failure even with valid bearer authentication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-red-token-expiry-'));
  const pathToken = 'short-lived-route-token';
  let now = 1_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, pathToken, pathTokenTtlMs: 100, clock: () => now, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    assert.equal((await session(address, bridge.endpointPath())).length > 0, true);
    now = 1_100;
    const expired = await fetch(url(address, bridge.endpointPath()), { method: 'POST', headers: headers(), body: JSON.stringify({}) });
    assert.equal(expired.status, 404);
    assert.equal((await expired.text()).includes(pathToken), false);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('red team: a post-claim patch failure enters manual review instead of leaving an executing proposal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-bridge-red-approval-'));
  await writeFile(path.join(root, 'README.md'), 'safe\n');
  const app = createWorkbenchServer({
    root,
    token: TOKEN,
    approvalToken: APPROVAL,
    __testHooks: {
      approvePatch: async ({ proposal }) => {
        throw new WorkflowError('SIMULATED_POST_CLAIM_FAILURE', 'simulated failure', { action: { ...proposal.action, status: 'executing' } });
      },
    },
  });
  const control = await app.listen();
  let bridge;
  try {
    bridge = app.createMcpBridge({ token: TOKEN });
    const bridgeAddress = await bridge.start();
    const active = await session(bridgeAddress);
    const proposed = await jsonRequest(bridgeAddress, {
      jsonrpc: '2.0',
      id: 'manual-review-patch',
      method: 'tools/call',
      params: { name: 'workspace.patch', arguments: { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-safe\n+owned\n', declaredPaths: ['README.md'] } },
    }, { 'mcp-session-id': active, 'mcp-protocol-version': VERSION });
    const proposal = proposed.body.result.structuredContent.proposal;
    const base = `http://${control.address}:${control.port}`;
    const approval = await fetch(`${base}/v1/proposals/${proposal.action.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-approval-token': APPROVAL, 'content-type': 'application/json' },
      body: JSON.stringify({ actionHash: proposal.action.actionHash }),
    });
    assert.equal(approval.status, 400);
    assert.equal((await approval.json()).error, 'SIMULATED_POST_CLAIM_FAILURE');
    const stored = await fetch(`${base}/v1/proposals/${proposal.action.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const storedBody = await stored.json();
    assert.equal(storedBody.proposal.action.status, 'manual_review');
    assert.equal(storedBody.recovery.state, 'manual_review');
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'safe\n');
  } finally {
    await bridge?.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
