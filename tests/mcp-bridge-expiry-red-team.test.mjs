import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';

const TOKEN = 'bridge-token-012345';
const VERSION = '2025-06-18';

function endpoint(address) {
  return `http://${address.address}:${address.port}/mcp`;
}

function headers(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra };
}

async function initialize(address, id = 'init-1') {
  const response = await fetch(endpoint(address), { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'expiry-red-team', version: '1' } } }) });
  return { response, sessionId: response.headers.get('mcp-session-id') };
}

async function postPing(address, sessionId, id = 'ping-1') {
  const response = await fetch(endpoint(address), { method: 'POST', headers: headers({ 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: {} }) });
  return response;
}

// Expiry error-code table (one-shot snapshot semantics — resume never
// reports EXPIRED unconditionally; the code depends on what is left):
//   - expired snapshot still stored: first resume EXPIRED, second NOT_FOUND.
//   - no replay store: an idle-expired live session is closed with no
//     snapshot to consume, so resume is NOT_FOUND directly.
//   - HTTP path expired it first but a store is configured: the expiry
//     close still persists the snapshot, so the first resume is EXPIRED.
//   - explicit DELETE leaves a closed tombstone: resume is CLOSED, not
//     EXPIRED (see also the DELETE-closed test in mcp-bridge-replay).
// Expiry itself reuses the HTTP path's full-session scan (expireSessions
// walks every live session); broadcast/resume only add scan frequency,
// they are not target-only or O(1) checks. The idle comparison is
// strictly greater-than: exactly at the window the session is still live,
// 1ms past it the session is dead (see the boundary test below).
test('MCP expiry red team: broadcast to an idle-expired live session fails and does not resurrect it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-'));
  let now = 1_000_000;
  const store = path.join(root, 'replay.json');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), replayStorePath: store, idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId } = await initialize(address);
    assert.equal(bridge.sessionCount(), 1);
    now += 5000;
    assert.throws(() => bridge.broadcast(sessionId, { method: 'notifications/late', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.equal(bridge.sessionCount(), 0, 'the expired session must be closed, not left live');
    assert.equal(bridge.replaySnapshotCount(), 1, 'the expiry close persists the interrupted snapshot for a first resume');
    // Expiry closed it as an interrupted (not DELETE-closed) session, so
    // its snapshot is past the idle window too: resume reports EXPIRED,
    // never a silent revival, and a second resume finds nothing.
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_EXPIRED' });
    assert.equal(bridge.replaySnapshotCount(), 0, 'the first resume consumes the expired snapshot');
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_NOT_FOUND' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: a live broadcast still refreshes activity, and only the idle window kills it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-live-'));
  let now = 1_000_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId } = await initialize(address);
    now += 500;
    const first = bridge.broadcast(sessionId, { method: 'notifications/still-live', params: {} });
    assert.equal(first.eventId, 'evt-1');
    // 900ms after the broadcast (1400ms after initialize) the session
    // is still live, because the broadcast refreshed lastActivity.
    now += 900;
    const second = bridge.broadcast(sessionId, { method: 'notifications/still-live-2', params: {} });
    assert.equal(second.eventId, 'evt-2');
    now += 5000;
    assert.throws(() => bridge.broadcast(sessionId, { method: 'notifications/too-late', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: resume of an idle-expired live session reports EXPIRED, not ACTIVE', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-resume-'));
  let now = 1_000_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), replayStorePath: path.join(root, 'replay.json'), idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId } = await initialize(address);
    bridge.broadcast(sessionId, { method: 'notifications/before-expiry', params: {} });
    now += 5000;
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_EXPIRED' });
    assert.equal(bridge.sessionCount(), 0);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: HTTP, broadcast, and resume agree — an expired session is 404 everywhere, a live one is not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-agree-'));
  let now = 1_000_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId: expiredId } = await initialize(address, 'init-expired');
    const { sessionId: liveId } = await initialize(address, 'init-live');
    // Only the first session ages out: both sessions are created at the
    // same mock time, but the live session's broadcast below refreshes
    // its lastActivity, so it stays live while the first expires.
    now += 800;
    const liveBroadcast = bridge.broadcast(liveId, { method: 'notifications/live-only', params: {} });
    assert.equal(liveBroadcast.eventId, 'evt-1');
    now += 800;
    // Expired session: HTTP 404, broadcast NOT_FOUND, resume NOT_FOUND
    // (not EXPIRED: no replay store is configured here, so the HTTP
    // path's expiry close leaves no snapshot to consume — the point is
    // that none of the three paths revives it).
    const httpExpired = await postPing(address, expiredId, 'ping-expired');
    assert.equal(httpExpired.status, 404);
    assert.throws(() => bridge.broadcast(expiredId, { method: 'notifications/no', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.throws(() => bridge.resumeSession(expiredId), { code: 'MCP_SESSION_NOT_FOUND' });
    // Live session: all three paths still see it as live.
    const httpLive = await postPing(address, liveId, 'ping-live');
    assert.equal(httpLive.status, 200);
    assert.equal(bridge.broadcast(liveId, { method: 'notifications/live-again', params: {} }).eventId, 'evt-2');
    assert.throws(() => bridge.resumeSession(liveId), { code: 'MCP_SESSION_ACTIVE' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: exactly at the idle window the session is still live; 1ms past it, it is dead', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-boundary-'));
  let now = 1_000_000;
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId: atWindowId } = await initialize(address, 'init-at-window');
    const { sessionId: pastWindowId } = await initialize(address, 'init-past-window');
    // The comparison is strictly greater-than, not greater-or-equal:
    // exactly 1000ms after initialize the session is still live.
    now += 1000;
    assert.equal(bridge.broadcast(atWindowId, { method: 'notifications/at-window', params: {} }).eventId, 'evt-1');
    // 1ms later the untouched session is past the window and expires;
    // the just-refreshed session stays live, so exactly one remains.
    now += 1;
    assert.throws(() => bridge.broadcast(pastWindowId, { method: 'notifications/past-window', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.equal(bridge.sessionCount(), 1);
    assert.throws(() => bridge.resumeSession(pastWindowId), { code: 'MCP_SESSION_NOT_FOUND' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: with a store, HTTP-first expiry still leaves an expired snapshot for the first resume', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-http-first-'));
  let now = 1_000_000;
  const store = path.join(root, 'replay.json');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), replayStorePath: store, idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId } = await initialize(address);
    bridge.broadcast(sessionId, { method: 'notifications/before-expiry', params: {} });
    now += 5000;
    // The HTTP path expires and closes the session first, but because
    // a store is configured the expiry close persists the snapshot:
    // the first resume is EXPIRED (not NOT_FOUND), the second is NOT_FOUND.
    const httpExpired = await postPing(address, sessionId, 'ping-expired-first');
    assert.equal(httpExpired.status, 404);
    assert.equal(bridge.sessionCount(), 0);
    assert.throws(() => bridge.broadcast(sessionId, { method: 'notifications/no', params: {} }), { code: 'MCP_SESSION_NOT_FOUND' });
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_EXPIRED' });
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_NOT_FOUND' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP expiry red team: an explicit DELETE leaves a tombstone, so resume reports CLOSED, not EXPIRED', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-expiry-rt-delete-'));
  let now = 1_000_000;
  const store = path.join(root, 'replay.json');
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), replayStorePath: store, idleSessionMs: 1000, clock: () => now });
  const address = await bridge.start();
  try {
    const { sessionId } = await initialize(address);
    bridge.broadcast(sessionId, { method: 'notifications/before-delete', params: {} });
    const deleted = await fetch(endpoint(address), { method: 'DELETE', headers: headers({ 'mcp-session-id': sessionId, 'mcp-protocol-version': VERSION }) });
    assert.equal(deleted.status, 204);
    assert.equal(bridge.sessionCount(), 0);
    // The tombstone is not consumed by a failed resume: repeated
    // resumes keep reporting CLOSED, never EXPIRED or NOT_FOUND.
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_CLOSED' });
    assert.throws(() => bridge.resumeSession(sessionId), { code: 'MCP_SESSION_CLOSED' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
