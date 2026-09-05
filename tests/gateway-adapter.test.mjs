import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayAdapter, GatewayAdapterError } from '../runtime/gateway-adapter.mjs';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  respond(value) {
    this.emit('message', { data: JSON.stringify(value) });
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

test('Gateway adapter rejects non-loopback URLs before opening a socket', () => {
  assert.throws(
    () => createGatewayAdapter({ url: 'ws://example.com:18789', WebSocketImpl: FakeSocket }),
    (error) => error instanceof GatewayAdapterError && error.code === 'GATEWAY_URL_NOT_ALLOWED',
  );
  assert.equal(FakeSocket.instances.length, 0);
});

test('Gateway adapter connects with an explicit lifecycle and correlates JSON responses', async () => {
  const adapter = createGatewayAdapter({ url: 'ws://127.0.0.1:18789', WebSocketImpl: FakeSocket });
  const connecting = adapter.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  assert.deepEqual(await connecting, { status: 'ready' });
  const resultPromise = adapter.request('status.get', { detail: 'summary' });
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].method, 'status.get');
  socket.respond({ id: socket.sent[0].id, result: { ok: true } });
  assert.deepEqual(await resultPromise, { ok: true });
  await adapter.close();
});

test('Gateway adapter bounds connection and request timeouts without exposing token data', async () => {
  const adapter = createGatewayAdapter({ url: 'ws://localhost:18789', token: 'PRIVATE-TOKEN', WebSocketImpl: FakeSocket, connectTimeoutMs: 5 });
  await assert.rejects(adapter.connect(), (error) => error.code === 'GATEWAY_CONNECT_TIMEOUT' && !error.message.includes('PRIVATE-TOKEN'));
  await adapter.close();
});

test('Gateway adapter cancels a pending request and enforces frame size limits', async () => {
  const adapter = createGatewayAdapter({ url: 'ws://[::1]:18789', WebSocketImpl: FakeSocket, maxMessageBytes: 128, requestTimeoutMs: 100 });
  const connecting = adapter.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  await connecting;
  const controller = new AbortController();
  const pending = adapter.request('slow.method', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'GATEWAY_REQUEST_ABORTED');
  await assert.rejects(adapter.request('oversized', { value: 'x'.repeat(512) }), (error) => error.code === 'GATEWAY_FRAME_LIMIT');
  await adapter.close();
});
