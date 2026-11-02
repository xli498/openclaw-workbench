import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpBridgeServer } from '../runtime/mcp-bridge-server.mjs';
import { createToolRegistry } from '../runtime/tool-registry.mjs';

const TOKEN = 'bridge-token-012345';
const VERSION = '2025-06-18';

function keyOf(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

function event(id, sequence, encoded) {
  return { id, sequence, encoded };
}

function notification(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

function entry(sessionId, events, nextEventSequence, { closed = false } = {}) {
  return { key: keyOf(sessionId), nextEventSequence, lastActivity: Date.now(), closed, events };
}

async function bridgeWithStore(root, store, extra = {}) {
  const bridge = createMcpBridgeServer({ root, token: TOKEN, registry: createToolRegistry({ root }), replayStorePath: store, ...extra });
  const address = await bridge.start();
  return { bridge, address };
}

function endpoint(address) {
  return `http://${address.address}:${address.port}/mcp`;
}

function headers(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra };
}

async function initialize(address, id = 'init-1') {
  const response = await fetch(endpoint(address), { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'snapshot-red-team', version: '1' } } }) });
  return { response, sessionId: response.headers.get('mcp-session-id') };
}

// A snapshot entry that fails validation must never seed a session:
// the bridge loads nothing for it, resume reports NOT_FOUND (not a
// partial buffer), and no live session appears.
test('MCP snapshot red team: id/sequence mismatch, gaps, duplicates, and cursor mismatch are rejected whole-entry', async () => {
  const cases = [
    ['id does not match sequence', entry('old-a', [event('evt-99', 1, notification('notifications/x'))], 2)],
    ['gap in the buffer', entry('old-a', [event('evt-1', 1, notification('notifications/x')), event('evt-3', 3, notification('notifications/x'))], 4)],
    ['duplicate id and sequence', entry('old-a', [event('evt-1', 1, notification('notifications/x')), event('evt-1', 1, notification('notifications/x'))], 2)],
    ['out-of-order buffer', entry('old-a', [event('evt-2', 2, notification('notifications/x')), event('evt-1', 1, notification('notifications/x'))], 3)],
    ['cursor does not follow the last event', entry('old-a', [event('evt-1', 1, notification('notifications/x')), event('evt-2', 2, notification('notifications/x'))], 99)],
    ['open session with no events but cursor past 1', entry('old-a', [], 5)],
    ['event sequence zero', entry('old-a', [event('evt-0', 0, notification('notifications/x'))], 1)],
  ];
  for (const [label, snapshotEntry] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-'));
    const store = path.join(root, 'replay.json');
    await writeFile(store, JSON.stringify({ version: 1, snapshots: [snapshotEntry] }), 'utf8');
    const { bridge } = await bridgeWithStore(root, store);
    try {
      assert.equal(bridge.replaySnapshotCount(), 0, label);
      assert.throws(() => bridge.resumeSession('old-a'), { code: 'MCP_SESSION_NOT_FOUND' }, label);
      assert.equal(bridge.sessionCount(), 0, label);
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('MCP snapshot red team: encoded frames must be broadcast notifications, never responses or requests', async () => {
  const cases = [
    ['JSON-RPC response shape', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: {} }))],
    ['notification smuggled with a JSON-RPC id (client would answer it)', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'notifications/x', params: {} }))],
    ['error shape', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x', error: { code: -32000, message: 'x' } }))],
    ['missing jsonrpc version', event('evt-1', 1, JSON.stringify({ method: 'notifications/x', params: {} }))],
    ['non-object params', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x', params: 'not-an-object' }))],
    ['empty method', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', method: '', params: {} }))],
    ['method with a newline', event('evt-1', 1, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/x\n', params: {} }))],
    ['truncated encoded JSON', event('evt-1', 1, '{"jsonrpc":"2.0","method":"notifications/x"')],
    ['encoded JSON is not an object', event('evt-1', 1, '"just-a-string"')],
  ];
  for (const [label, badEvent] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-enc-'));
    const store = path.join(root, 'replay.json');
    await writeFile(store, JSON.stringify({ version: 1, snapshots: [entry('old-a', [badEvent], 2)] }), 'utf8');
    const { bridge } = await bridgeWithStore(root, store);
    try {
      assert.equal(bridge.replaySnapshotCount(), 0, label);
      assert.throws(() => bridge.resumeSession('old-a'), { code: 'MCP_SESSION_NOT_FOUND' }, label);
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('MCP snapshot red team: a legitimately truncated buffer still resumes, and a closed tombstone keeps its cursor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-legit-'));
  const store = path.join(root, 'replay.json');
  // Buffer truncated from the front by the bounded buffer (evt-1, evt-2
  // already dropped): sequences stay contiguous and the cursor follows.
  await writeFile(store, JSON.stringify({ version: 1, snapshots: [
    entry('old-truncated', [event('evt-3', 3, notification('notifications/t-3')), event('evt-4', 4, notification('notifications/t-4')), event('evt-5', 5, notification('notifications/t-5'))], 6),
    entry('old-closed', [], 4, { closed: true }),
    entry('old-empty', [], 1),
  ] }), 'utf8');
  const { bridge } = await bridgeWithStore(root, store);
  try {
    assert.equal(bridge.replaySnapshotCount(), 3);
    const resumed = bridge.resumeSession('old-truncated');
    assert.equal(resumed.replayedEvents, 3);
    assert.equal(resumed.lastEventId, 'evt-5');
    assert.throws(() => bridge.resumeSession('old-closed'), { code: 'MCP_SESSION_CLOSED' });
    const empty = bridge.resumeSession('old-empty');
    assert.equal(empty.replayedEvents, 0);
    assert.equal(empty.lastEventId, null);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP snapshot red team: one bad entry never poisons a good entry, and a duplicate key keeps the first valid snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-mixed-'));
  const store = path.join(root, 'replay.json');
  const bad = entry('old-bad', [event('evt-99', 1, notification('notifications/bad'))], 2);
  const good = entry('old-good', [event('evt-1', 1, notification('notifications/good-one')), event('evt-2', 2, notification('notifications/good-two'))], 3);
  const first = entry('old-dup', [event('evt-1', 1, notification('notifications/first-wins'))], 2);
  const second = entry('old-dup', [event('evt-1', 1, notification('notifications/second-shadow')), event('evt-2', 2, notification('notifications/second-shadow-two'))], 3);
  await writeFile(store, JSON.stringify({ version: 1, snapshots: [bad, good, first, second] }), 'utf8');
  const { bridge } = await bridgeWithStore(root, store);
  try {
    // Bad dropped, good + first kept; the duplicate second is ignored.
    assert.equal(bridge.replaySnapshotCount(), 2);
    assert.throws(() => bridge.resumeSession('old-bad'), { code: 'MCP_SESSION_NOT_FOUND' });
    const resumedGood = bridge.resumeSession('old-good');
    assert.equal(resumedGood.replayedEvents, 2);
    assert.equal(resumedGood.lastEventId, 'evt-2');
    const resumedDup = bridge.resumeSession('old-dup');
    assert.equal(resumedDup.replayedEvents, 1);
    assert.equal(resumedDup.lastEventId, 'evt-1');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP snapshot red team: cross-session isolation holds for snapshots — resuming A never consumes or leaks B', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-iso-'));
  const store = path.join(root, 'replay.json');
  await writeFile(store, JSON.stringify({ version: 1, snapshots: [
    entry('old-a', [event('evt-1', 1, notification('notifications/only-a'))], 2),
    entry('old-b', [event('evt-1', 1, notification('notifications/only-b'))], 2),
  ] }), 'utf8');
  const { bridge } = await bridgeWithStore(root, store);
  try {
    const resumedA = bridge.resumeSession('old-a');
    assert.equal(resumedA.replayedEvents, 1);
    // B is still resumable after A was resumed; A cannot resume twice.
    assert.throws(() => bridge.resumeSession('old-a'), { code: 'MCP_SESSION_NOT_FOUND' });
    const resumedB = bridge.resumeSession('old-b');
    assert.equal(resumedB.replayedEvents, 1);
    assert.notEqual(resumedB.sessionId, resumedA.sessionId);
    assert.equal(bridge.replaySnapshotCount(), 0);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP snapshot red team: truncated, empty, and wrong-version store files fail closed without breaking startup, and recovery overwrites them', async () => {
  for (const [label, content] of [
    ['truncated JSON', '{"version":1,"snapshots":[{'],
    ['empty file', ''],
    ['trailing garbage', '{"version":1,"snapshots":[]} trailing'],
    ['wrong version', JSON.stringify({ version: 2, snapshots: [] })],
    ['snapshots not an array', JSON.stringify({ version: 1, snapshots: {} })],
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-file-'));
    const store = path.join(root, 'replay.json');
    await writeFile(store, content, 'utf8');
    const { bridge, address } = await bridgeWithStore(root, store);
    try {
      assert.equal(bridge.replaySnapshotCount(), 0, label);
      assert.throws(() => bridge.resumeSession('old-a'), { code: 'MCP_SESSION_NOT_FOUND' }, label);
      // Startup is not broken: a fresh session still initializes.
      const { response, sessionId } = await initialize(address);
      assert.equal(response.status, 200, label);
      bridge.broadcast(sessionId, { method: 'notifications/recovered', params: { note: 'recovered-after-corrupt-store' } });
      // The next persist overwrites the corrupt file with valid JSON.
      const stored = JSON.parse(await readFile(store, 'utf8'));
      assert.equal(stored.version, 1, label);
      assert.equal(stored.snapshots.length, 1, label);
      assert.match(JSON.stringify(stored), /recovered-after-corrupt-store/, label);
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('MCP snapshot red team: an oversized event in a snapshot is dropped, not replayed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-snap-rt-big-'));
  const store = path.join(root, 'replay.json');
  const big = event('evt-1', 1, notification('notifications/big', { text: 'x'.repeat(5000) }));
  await writeFile(store, JSON.stringify({ version: 1, snapshots: [entry('old-a', [big], 2)] }), 'utf8');
  const { bridge } = await bridgeWithStore(root, store, { maxResponseBytes: 1024 });
  try {
    assert.equal(bridge.replaySnapshotCount(), 0);
    assert.throws(() => bridge.resumeSession('old-a'), { code: 'MCP_SESSION_NOT_FOUND' });
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});