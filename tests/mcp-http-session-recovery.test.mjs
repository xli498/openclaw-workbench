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
    assert.equal(transport.getProtocolVersion(), null);
    await transport.initialize();
    assert.ok(transport.getSessionId());
    assert.notEqual(transport.getSessionId(), oldId);
    assert.deepEqual(await transport.request('ping'), {});
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
    const seenInCallback = [];
    const stream = transport.subscribe({ onError: (error) => { seenInCallback.push({ code: error.code, sessionId: transport.getSessionId(), protocolVersion: transport.getProtocolVersion() }); errors.push(error); } });
    await assert.rejects(stream.closedPromise, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(errors[0]?.code, 'MCP_SESSION_NOT_FOUND');
    // Direct evidence for Q51-3: onError ran after the clear, not before.
    assert.deepEqual(seenInCallback, [{ code: 'MCP_SESSION_NOT_FOUND', sessionId: null, protocolVersion: null }]);
    assert.equal(transport.getSessionId(), null);
    assert.equal(transport.getProtocolVersion(), null);
    await transport.initialize();
    assert.ok(transport.getSessionId());
    assert.notEqual(transport.getSessionId(), oldId);
    assert.deepEqual(await transport.request('ping'), {});
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

// --- Stub-transport helpers for Q51-6 / Q51-2 / Q51-4 (no real server) ---
// initialize() answers with sess-A, then sess-B, ...; ping / notify / GET
// calls are delegated to the test-supplied handlers so a test can defer,
// script, or capture them.
function httpResponse({ ok = true, status = 200, sessionId = null, contentType = null, text = null } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (key === 'mcp-session-id') return sessionId;
        if (key === 'content-type') return contentType;
        return null;
      },
    },
    text: async () => text ?? '',
  };
}

function createStubTransport({ headers = {}, onPing, onNotify, onGet } = {}) {
  const calls = [];
  let initializeCount = 0;
  const sessions = ['sess-A', 'sess-B', 'sess-C'];
  const fetchImpl = async (target, options) => {
    const captured = { ...(options.headers ?? {}) };
    calls.push({ method: options.method, headers: captured, body: options.body ?? null });
    if (options.method === 'GET') {
      if (!onGet) throw new Error('stub: unexpected GET');
      return onGet(calls.length, captured);
    }
    const body = options.body ? JSON.parse(options.body) : null;
    if (body?.method === 'initialize') {
      const sessionId = sessions[initializeCount] ?? `sess-${initializeCount + 1}`;
      initializeCount += 1;
      return httpResponse({ status: 200, sessionId, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: VERSION, capabilities: {}, serverInfo: { name: 'stub', version: '0' } } }) });
    }
    if (body?.method === 'notifications/initialized') return httpResponse({ status: 202 });
    if (body && body.id === undefined) {
      if (onNotify) return onNotify(calls.length, body, captured);
      return httpResponse({ status: 202 });
    }
    if (onPing) return onPing(calls.length, body, captured);
    return httpResponse({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) });
  };
  const transport = createMcpHttpTransport({ endpoint: 'http://127.0.0.1:9/mcp', headers, fetchImpl });
  return { transport, calls };
}

function pingSessionIds(calls) {
  return calls.filter((call) => {
    try { return JSON.parse(call.body).method === 'ping'; } catch { return false; }
  }).map((call) => call.headers['mcp-session-id']);
}

// Q51-6 Must: R1 and R2 both carry old session A. R1's 404 clears A,
// initialize() builds new session B, and only then does R2's late 404
// arrive. R2 must still report session loss (its own session is dead),
// but it must NOT clear B, and the next request on B must succeed.
test('MCP session recovery: a late 404 for an old session must not clear a newer session', async () => {
  const deferred = [];
  let pingCount = 0;
  const { transport, calls } = createStubTransport({
    onPing: (n, body) => {
      pingCount += 1;
      if (pingCount <= 2) return new Promise((resolve) => deferred.push(resolve));
      return httpResponse({ status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) });
    },
  });
  try {
    await transport.start();
    await transport.initialize();
    assert.equal(transport.getSessionId(), 'sess-A');
    const first = transport.request('ping');
    const second = transport.request('ping');
    while (deferred.length < 2) await new Promise((resolve) => setImmediate(resolve));
    deferred[0](httpResponse({ ok: false, status: 404 }));
    await assert.rejects(first, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    assert.equal(transport.getProtocolVersion(), null);
    await transport.initialize();
    assert.equal(transport.getSessionId(), 'sess-B');
    assert.equal(transport.getProtocolVersion(), VERSION);
    deferred[1](httpResponse({ ok: false, status: 404 }));
    await assert.rejects(second, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), 'sess-B');
    assert.equal(transport.getProtocolVersion(), VERSION);
    assert.deepEqual(await transport.request('ping'), {});
    assert.deepEqual(pingSessionIds(calls), ['sess-A', 'sess-A', 'sess-B']);
  } finally {
    await transport.close();
  }
});

// Q51-6 corollary, no rebuild: the second late 404 is still classified by
// its sent identity (session loss), not downgraded to a plain HTTP error
// just because the shared id is already null.
test('MCP session recovery: a second late 404 without rebuild still reports session loss', async () => {
  const deferred = [];
  const { transport } = createStubTransport({
    onPing: () => new Promise((resolve) => deferred.push(resolve)),
  });
  try {
    await transport.start();
    await transport.initialize();
    assert.equal(transport.getSessionId(), 'sess-A');
    const first = transport.request('ping');
    const second = transport.request('ping');
    while (deferred.length < 2) await new Promise((resolve) => setImmediate(resolve));
    deferred[0](httpResponse({ ok: false, status: 404 }));
    await assert.rejects(first, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    deferred[1](httpResponse({ ok: false, status: 404 }));
    await assert.rejects(second, (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    assert.equal(transport.getProtocolVersion(), null);
  } finally {
    await transport.close();
  }
});

// Q51-2 negative: a 400 / 500 on a live session is a plain HTTP error and
// leaves both the session id and the negotiated version untouched.
test('MCP session recovery: a 400/500 with a live session keeps the session and stays a plain HTTP error', async () => {
  let pingCount = 0;
  let notifyCount = 0;
  const { transport } = createStubTransport({
    onPing: () => { pingCount += 1; return httpResponse({ ok: false, status: pingCount === 1 ? 400 : 500 }); },
    onNotify: () => { notifyCount += 1; return httpResponse({ ok: false, status: notifyCount === 1 ? 400 : 500 }); },
  });
  try {
    await transport.start();
    await transport.initialize();
    assert.equal(transport.getSessionId(), 'sess-A');
    assert.equal(transport.getProtocolVersion(), VERSION);
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    assert.equal(transport.getSessionId(), 'sess-A');
    assert.equal(transport.getProtocolVersion(), VERSION);
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    assert.equal(transport.getSessionId(), 'sess-A');
    assert.equal(transport.getProtocolVersion(), VERSION);
    await assert.rejects(transport.notify('notifications/ping', {}), (error) => error.code === 'MCP_HTTP_STATUS');
    assert.equal(transport.getSessionId(), 'sess-A');
    assert.equal(transport.getProtocolVersion(), VERSION);
    await assert.rejects(transport.notify('notifications/ping', {}), (error) => error.code === 'MCP_HTTP_STATUS');
    assert.equal(transport.getSessionId(), 'sess-A');
    assert.equal(transport.getProtocolVersion(), VERSION);
  } finally {
    await transport.close();
  }
});

// Q51-6 Should: the transport owns the session headers. Caller-supplied
// mcp-session-id / mcp-protocol-version must never be sent, so a clear
// cannot be undone by stale custom headers on the next request.
test('MCP session recovery: caller-supplied session headers are dropped, not sent', async () => {
  const { transport, calls } = createStubTransport({
    headers: { authorization: 'Bearer stub', 'mcp-session-id': 'stale-custom', 'Mcp-Protocol-Version': '1999-01-01' },
    onPing: () => httpResponse({ ok: false, status: 404 }),
  });
  try {
    await transport.start();
    await transport.initialize();
    const initCall = calls.find((call) => { try { return JSON.parse(call.body).method === 'initialize'; } catch { return false; } });
    assert.equal(initCall.headers['mcp-session-id'], undefined);
    assert.equal(initCall.headers['Mcp-Protocol-Version'], undefined);
    assert.equal(initCall.headers.authorization, 'Bearer stub');
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    // The next request is bare: no resurrected custom id, and a 404 with
    // no session carried stays a plain HTTP error.
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_HTTP_STATUS');
    assert.equal(pingSessionIds(calls).at(-1), undefined);
  } finally {
    await transport.close();
  }
});

// Q51-4: the old stream keeps its own cursor, but a fresh subscribe after
// re-initialize (no resumeId passed) sends no last-event-id.
test('MCP session recovery: a fresh subscribe after re-initialize carries no old last-event-id', async () => {
  const getHeaders = [];
  let getCount = 0;
  const sseWithId = 'id: evt-1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n';
  const { transport } = createStubTransport({
    onPing: () => httpResponse({ ok: false, status: 404 }),
    onGet: (n, headers) => {
      getHeaders.push({ ...headers });
      getCount += 1;
      return httpResponse({ status: 200, contentType: 'text/event-stream', text: getCount === 1 ? sseWithId : '' });
    },
  });
  try {
    await transport.start();
    await transport.initialize();
    // The first stream resumes from evt-0, then receives evt-1, so its own
    // handle cursor advances to evt-1 while the session is still alive.
    const first = transport.subscribe({ lastEventId: 'evt-0' });
    await first.closedPromise;
    assert.equal(first.lastEventId, 'evt-1');
    await assert.rejects(transport.request('ping'), (error) => error.code === 'MCP_SESSION_NOT_FOUND');
    assert.equal(transport.getSessionId(), null);
    await transport.initialize();
    assert.equal(transport.getSessionId(), 'sess-B');
    const second = transport.subscribe({});
    await second.closedPromise;
    assert.equal(getHeaders.length, 2);
    assert.equal(getHeaders[0]['last-event-id'], 'evt-0');
    // The new subscribe passes no resumeId, so it must not inherit the old
    // stream's evt-1 cursor implicitly.
    assert.equal(getHeaders[1]['last-event-id'], undefined);
  } finally {
    await transport.close();
  }
});

// Q51-3: an onError that throws synchronously must not prevent
// closedPromise from settling with the session error.
test('MCP session recovery: a throwing onError still lets closedPromise settle', async () => {
  const { root, bridge, address } = await startBridge();
  try {
    const transport = transportFor(address);
    await transport.start();
    await transport.initialize();
    const oldId = transport.getSessionId();
    await deleteSession(address, oldId);
    const stream = transport.subscribe({ onError: () => { throw new Error('boom'); } });
    const outcome = await Promise.race([
      stream.closedPromise.then(() => 'resolved', (error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 5000)),
    ]);
    assert.equal(outcome, 'MCP_SESSION_NOT_FOUND');
    await transport.initialize();
    assert.notEqual(transport.getSessionId(), oldId);
    await transport.close();
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
