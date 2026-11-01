import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createMcpHttpTransport } from '../runtime/mcp-http-transport.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';

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

async function post(address, body, extraHeaders = {}) {
  const response = await fetch(endpoint(address), { method: 'POST', headers: headers(extraHeaders), body: JSON.stringify(body) });
  let parsed = null;
  try { parsed = await response.json(); } catch {}
  return { response, body: parsed };
}

async function initialize(address, id = 'initialize-1') {
  return post(address, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'replay-test', version: '1.0.0' } },
  });
}

function sessionHeaders(sessionId) {
  return { 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION };
}

function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (predicate() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error('timed out waiting')) : setTimeout(tick, 10));
    tick();
  });
}

// Read a live SSE response until `predicate(text)` holds or the timeout
// fires (the timeout cancels the reader, so this never hangs on an open
// stream). Returns whatever text arrived, including the ': connected' line.
async function collectSse(response, predicate, timeoutMs = 3000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => { reader.cancel().catch(() => {}); }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (predicate(text) || done) break;
    }
  } catch {
    // Cancelled by the timeout, or the server closed the stream.
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch {}
  }
  return text;
}

async function openStream(address, sessionId, extraHeaders = {}) {
  const response = await fetch(endpoint(address), { headers: headers({ ...sessionHeaders(sessionId), ...extraHeaders }) });
  return response;
}

test('MCP replay: a disconnected session replays only the events after its Last-Event-ID, in order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const sessionId = (await initialize(address)).response.headers.get('mcp-session-id');
    const live = await openStream(address, sessionId);
    assert.equal(live.status, 200);
    await waitFor(() => bridge.streamCount(sessionId) === 1);
    const first = bridge.broadcast(sessionId, { method: 'notifications/replay-live-1', params: { note: 'replay-live-one' } });
    const second = bridge.broadcast(sessionId, { method: 'notifications/replay-live-2', params: { note: 'replay-live-two' } });
    assert.equal(first.delivered, 1);
    assert.equal(first.eventId, 'evt-1');
    assert.equal(second.eventId, 'evt-2');
    const liveText = await collectSse(live, (text) => text.includes('replay-live-one') && text.includes('replay-live-two'));
    assert.match(liveText, /id: evt-1/);
    assert.match(liveText, /id: evt-2/);
    // Wait for the server to observe the cancelled stream before asserting
    // that the next broadcasts have no live stream to deliver to.
    await waitFor(() => bridge.streamCount(sessionId) === 0);

    // No stream is open now: these two events are buffered, not lost.
    const third = bridge.broadcast(sessionId, { method: 'notifications/replay-buffered-3', params: { note: 'replay-buffered-three' } });
    const fourth = bridge.broadcast(sessionId, { method: 'notifications/replay-buffered-4', params: { note: 'replay-buffered-four' } });
    assert.equal(third.delivered, 0);
    assert.equal(fourth.eventId, 'evt-4');

    const resumed = await openStream(address, sessionId, { 'last-event-id': second.eventId });
    assert.equal(resumed.status, 200);
    const replayed = await collectSse(resumed, (text) => text.includes('replay-buffered-three') && text.includes('replay-buffered-four'));
    assert.ok(replayed.indexOf('replay-buffered-three') < replayed.indexOf('replay-buffered-four'));
    assert.equal(replayed.includes('replay-live-one'), false);
    assert.equal(replayed.includes('replay-live-two'), false);
    assert.match(replayed, /id: evt-3/);
    assert.match(replayed, /id: evt-4/);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP replay: cross-session isolation, a session never replays another session\'s events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-isolation-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const sessionA = (await initialize(address, 'init-a')).response.headers.get('mcp-session-id');
    const secret = bridge.broadcast(sessionA, { method: 'notifications/secret-a', params: { note: 'secret-for-A-only' } });
    assert.equal(secret.eventId, 'evt-1');

    // B has an empty buffer: presenting A's event id cannot conjure A's
    // event, it is an expired/unknown id for B's own buffer.
    const sessionB = (await initialize(address, 'init-b')).response.headers.get('mcp-session-id');
    const foreign = await openStream(address, sessionB, { 'last-event-id': secret.eventId });
    assert.equal(foreign.status, 410);
    const foreignBody = await foreign.json();
    assert.equal(foreignBody.error, 'MCP_EVENT_EXPIRED');
    assert.equal(JSON.stringify(foreignBody).includes('secret-for-A-only'), false);

    // B without Last-Event-ID gets live events only, never A's backlog.
    const liveB = await openStream(address, sessionB);
    assert.equal(liveB.status, 200);
    const liveBText = await collectSse(liveB, () => false, 300);
    assert.equal(liveBText.includes('secret-for-A-only'), false);
    assert.equal(liveBText.includes('data:'), false);

    // B's own replay returns only B's own events.
    const ownFirst = bridge.broadcast(sessionB, { method: 'notifications/own-b-1', params: { note: 'own-B-one' } });
    bridge.broadcast(sessionB, { method: 'notifications/own-b-2', params: { note: 'own-B-two' } });
    const ownReplay = await openStream(address, sessionB, { 'last-event-id': ownFirst.eventId });
    assert.equal(ownReplay.status, 200);
    const ownText = await collectSse(ownReplay, (text) => text.includes('own-B-two'));
    assert.equal(ownText.includes('own-B-one'), false);
    assert.equal(ownText.includes('secret-for-A-only'), false);
    assert.equal(ownText.includes('own-B-two'), true);

    // Positive control: A's own replay still works after B's attempts.
    bridge.broadcast(sessionA, { method: 'notifications/secret-a-2', params: { note: 'secret-for-A-two' } });
    const ownA = await openStream(address, sessionA, { 'last-event-id': secret.eventId });
    assert.equal(ownA.status, 200);
    const aText = await collectSse(ownA, (text) => text.includes('secret-for-A-two'));
    assert.equal(aText.includes('secret-for-A-two'), true);
    assert.equal(aText.includes('own-B-two'), false);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP replay: expired, truncated, future, and malformed Last-Event-ID behaviour', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-expiry-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), maxReplayEvents: 3 });
  const address = await bridge.start();
  try {
    const sessionId = (await initialize(address)).response.headers.get('mcp-session-id');
    const ids = [];
    for (let index = 1; index <= 5; index += 1) {
      ids.push(bridge.broadcast(sessionId, { method: `notifications/expire-${index}`, params: { note: `expire-note-${index}` } }).eventId);
    }
    assert.deepEqual(ids, ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5']);

    // evt-2 was truncated when the 3-event buffer kept only evt-3..evt-5:
    // 410 with a generic error, never a partial replay of evt-4/evt-5.
    const expired = await openStream(address, sessionId, { 'last-event-id': 'evt-2' });
    assert.equal(expired.status, 410);
    const expiredText = await expired.text();
    assert.equal(JSON.parse(expiredText).error, 'MCP_EVENT_EXPIRED');
    assert.equal(expiredText.includes('expire-note-4'), false);

    // The oldest surviving id still replays exactly what follows it.
    const resumed = await openStream(address, sessionId, { 'last-event-id': 'evt-3' });
    assert.equal(resumed.status, 200);
    const replayed = await collectSse(resumed, (text) => text.includes('expire-note-4') && text.includes('expire-note-5'));
    assert.ok(replayed.indexOf('expire-note-4') < replayed.indexOf('expire-note-5'));
    assert.equal((replayed.match(/data:/g) ?? []).length, 2);
    for (const note of ['expire-note-1', 'expire-note-2', 'expire-note-3']) assert.equal(replayed.includes(note), false);

    // Already at the latest event: live only, no replay frames.
    const current = await openStream(address, sessionId, { 'last-event-id': 'evt-5' });
    assert.equal(current.status, 200);
    const currentText = await collectSse(current, () => false, 300);
    assert.equal(currentText.includes('data:'), false);

    for (const [id, status, code] of [['evt-999', 410, 'MCP_EVENT_EXPIRED'], ['bogus', 400, 'MCP_EVENT_ID_INVALID'], ['evt-0', 400, 'MCP_EVENT_ID_INVALID'], ['evt-01', 400, 'MCP_EVENT_ID_INVALID']]) {
      const rejected = await openStream(address, sessionId, { 'last-event-id': id });
      assert.equal(rejected.status, status);
      assert.equal((await rejected.json()).error, code);
    }
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP replay: replaying a patch proposal never executes it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-approval-'));
  await writeFile(path.join(root, 'README.md'), 'before\n');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const sessionId = (await initialize(address)).response.headers.get('mcp-session-id');
    const before = bridge.broadcast(sessionId, { method: 'notifications/replay-before', params: { note: 'replay-before-patch' } });
    const proposed = await post(address, { jsonrpc: '2.0', id: 'patch-1', method: 'tools/call', params: { name: 'workspace.patch', arguments: { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-before\n+after\n', declaredPaths: ['README.md'] } } }, sessionHeaders(sessionId));
    assert.equal(proposed.response.status, 200);
    assert.equal(proposed.body.result.structuredContent.approvalRequired, true);
    assert.equal(proposed.body.result.structuredContent.proposal.status, 'awaiting_approval');
    const proposalId = proposed.body.result.structuredContent.proposal.action.id;
    bridge.broadcast(sessionId, { method: 'notifications/proposal-echo', params: { note: 'replay-proposal-echo', proposalId } });
    const resumed = await openStream(address, sessionId, { 'last-event-id': before.eventId });
    assert.equal(resumed.status, 200);
    const replayed = await collectSse(resumed, (text) => text.includes('replay-proposal-echo'));
    // The replayed frame is a notification carrying the proposal id; it is
    // not a tool result and it does not apply anything.
    assert.match(replayed, /notifications\/proposal-echo/);
    assert.equal(replayed.includes(proposalId), true);
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'before\n');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP replay: Bearer is checked before any replay, and a closed session beats an expired event id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-auth-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const sessionId = (await initialize(address)).response.headers.get('mcp-session-id');
    const event = bridge.broadcast(sessionId, { method: 'notifications/replay-auth', params: { note: 'replay-auth-note' } });
    const noBearer = await fetch(endpoint(address), { headers: { accept: 'text/event-stream', ...sessionHeaders(sessionId), 'last-event-id': event.eventId } });
    assert.equal(noBearer.status, 401);
    assert.equal((await noBearer.json()).error, 'MCP_UNAUTHORIZED');
    const wrongBearer = await fetch(endpoint(address), { headers: { authorization: 'Bearer wrong-token-012345', accept: 'text/event-stream', ...sessionHeaders(sessionId), 'last-event-id': event.eventId } });
    assert.equal(wrongBearer.status, 401);
    const closed = await fetch(endpoint(address), { method: 'DELETE', headers: headers(sessionHeaders(sessionId)) });
    assert.equal(closed.status, 204);
    const afterClose = await openStream(address, sessionId, { 'last-event-id': event.eventId });
    assert.equal(afterClose.status, 404);
    assert.equal((await afterClose.json()).error, 'MCP_SESSION_NOT_FOUND');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP routing: unknown method, unknown tool, read execution, proposal-only writes, and replayed ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-routing-'));
  await writeFile(path.join(root, 'README.md'), 'routing fixture\n');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const sessionId = (await initialize(address)).response.headers.get('mcp-session-id');
    const otherId = (await initialize(address, 'initialize-2')).response.headers.get('mcp-session-id');
    const call = (id, name, argumentsValue) => post(address, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: argumentsValue } }, sessionHeaders(sessionId));

    const unknownMethod = await post(address, { jsonrpc: '2.0', id: 'unknown-method-1', method: 'tools/bogus', params: {} }, sessionHeaders(sessionId));
    assert.equal(unknownMethod.response.status, 200);
    assert.equal(unknownMethod.body.error.code, -32601);

    const unknownTool = await call('unknown-tool-1', 'workspace.nope', {});
    assert.equal(unknownTool.response.status, 200);
    assert.equal(unknownTool.body.result.isError, true);
    assert.equal(unknownTool.body.result.structuredContent.error.code, 'TOOL_INPUT_INVALID');

    // Legacy aliases are not exposed over the bridge catalog.
    const alias = await call('alias-1', 'workspace.list_files', { path: '.' });
    assert.equal(alias.body.result.isError, true);
    assert.equal(alias.body.result.structuredContent.error.code, 'TOOL_INPUT_INVALID');

    const read = await call('read-1', 'workspace.read_files', { paths: ['README.md'] });
    assert.equal(read.body.result.isError, undefined);
    assert.equal(read.body.result.structuredContent.files[0].content, 'routing fixture\n');

    const patch = await call('patch-1', 'workspace.patch', { patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-routing fixture\n+changed\n', declaredPaths: ['README.md'] });
    assert.equal(patch.body.result.structuredContent.approvalRequired, true);
    assert.equal(patch.body.result.structuredContent.proposal.status, 'awaiting_approval');

    const command = await call('command-1', 'workspace.command', { argv: ['pwd'] });
    assert.equal(command.body.result.structuredContent.approvalRequired, true);
    assert.equal(command.body.result.structuredContent.proposal.status, 'awaiting_approval');
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'routing fixture\n');

    // A request id is claimed before dispatch, even when dispatch fails
    // with -32601, and the claim is global across sessions.
    const sameId = await post(address, { jsonrpc: '2.0', id: 'unknown-method-1', method: 'ping', params: {} }, sessionHeaders(sessionId));
    assert.equal(sameId.response.status, 409);
    assert.equal(sameId.body.error, 'MCP_REQUEST_REPLAY');
    const crossSession = await post(address, { jsonrpc: '2.0', id: 'read-1', method: 'ping', params: {} }, sessionHeaders(otherId));
    assert.equal(crossSession.response.status, 409);
    assert.equal(crossSession.body.error, 'MCP_REQUEST_REPLAY');

    // Notifications without an id: only notifications/initialized is 202.
    const badNotification = await fetch(endpoint(address), { method: 'POST', headers: headers(sessionHeaders(sessionId)), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }) });
    assert.equal(badNotification.status, 400);
    assert.equal((await badNotification.json()).error, 'MCP_NOTIFICATION_INVALID');
    const initialized = await fetch(endpoint(address), { method: 'POST', headers: headers(sessionHeaders(sessionId)), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) });
    assert.equal(initialized.status, 202);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP replay: the HTTP transport resumes a live stream from its last event id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-replay-transport-'));
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }) });
  const address = await bridge.start();
  try {
    const transport = createMcpHttpTransport({ endpoint: `http://127.0.0.1:${address.port}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } });
    await transport.start();
    await transport.initialize();
    const sessionId = transport.getSessionId();
    const firstReceived = [];
    const first = transport.subscribe({ onNotification: (frame) => firstReceived.push(frame) });
    await waitFor(() => bridge.streamCount(sessionId) === 1);
    const live = bridge.broadcast(sessionId, { method: 'notifications/transport-live', params: { note: 'transport-live' } });
    await waitFor(() => firstReceived.some((frame) => frame.method === 'notifications/transport-live'));
    assert.equal(first.lastEventId, live.eventId);
    first.close();
    await waitFor(() => bridge.streamCount(sessionId) === 0);

    // Buffered while disconnected, then resumed by event id.
    bridge.broadcast(sessionId, { method: 'notifications/transport-buffered-1', params: { note: 'transport-buffered-one' } });
    bridge.broadcast(sessionId, { method: 'notifications/transport-buffered-2', params: { note: 'transport-buffered-two' } });
    const secondReceived = [];
    const second = transport.subscribe({ onNotification: (frame) => secondReceived.push(frame), lastEventId: first.lastEventId });
    await waitFor(() => secondReceived.some((frame) => frame.method === 'notifications/transport-buffered-2'));
    assert.deepEqual(secondReceived.map((frame) => frame.method), ['notifications/transport-buffered-1', 'notifications/transport-buffered-2']);
    assert.equal(secondReceived.some((frame) => frame.method === 'notifications/transport-live'), false);
    second.close();
    await transport.terminateSession();
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
