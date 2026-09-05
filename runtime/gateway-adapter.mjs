import { randomUUID } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export class GatewayAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GatewayAdapterError';
    this.code = code;
    this.details = details;
  }
}

function parseGatewayUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayAdapterError('GATEWAY_URL_INVALID', 'Gateway URL is invalid');
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new GatewayAdapterError('GATEWAY_URL_NOT_ALLOWED', 'Gateway URL must be a credential-free loopback WebSocket URL');
  }
  return parsed;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function dataToText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data ?? '');
}

export function createGatewayAdapter({
  url = 'ws://127.0.0.1:18789',
  token,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const gatewayUrl = parseGatewayUrl(url);
  if (token !== undefined && (typeof token !== 'string' || token.length < 1 || token.length > 4096)) throw new GatewayAdapterError('GATEWAY_TOKEN_INVALID', 'Gateway token must be a bounded string');
  for (const [name, value] of [['connectTimeoutMs', connectTimeoutMs], ['requestTimeoutMs', requestTimeoutMs], ['maxMessageBytes', maxMessageBytes]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new GatewayAdapterError('GATEWAY_CONFIG_INVALID', `${name} must be a positive safe integer`);
  }

  let socket = null;
  let state = 'disconnected';
  let connectPromise = null;
  let cancelConnect = null;
  let lifecycleGeneration = 0;
  const pending = new Map();

  function failPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.reject(error);
    }
    pending.clear();
  }

  function attach(type, listener) {
    if (typeof socket?.addEventListener === 'function') socket.addEventListener(type, listener);
    else if (socket) socket[`on${type}`] = listener;
  }

  function handleMessage(event) {
    const text = dataToText(event?.data);
    if (byteLength(text) > maxMessageBytes) {
      socket?.close?.();
      state = 'failed';
      failPending(new GatewayAdapterError('GATEWAY_FRAME_LIMIT', 'Gateway frame exceeded the configured limit'));
      return;
    }
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string') return;
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.cleanup?.();
    if (frame.error) entry.reject(new GatewayAdapterError('GATEWAY_REMOTE_ERROR', 'Gateway returned an error response'));
    else entry.resolve(frame.result);
  }

  function handleClose(processRef) {
    if (socket !== processRef) return;
    socket = null;
    state = 'disconnected';
    failPending(new GatewayAdapterError('GATEWAY_CLOSED', 'Gateway connection closed'));
  }

  async function connect() {
    if (state === 'ready') return Object.freeze({ status: 'ready' });
    if (connectPromise) return connectPromise;
    if (typeof WebSocketImpl !== 'function') throw new GatewayAdapterError('GATEWAY_WS_UNAVAILABLE', 'WebSocket implementation is unavailable');
    const generation = ++lifecycleGeneration;
    state = 'connecting';
    connectPromise = new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connectPromise = null;
        cancelConnect = null;
        fn(value);
      };
      try { socket = new WebSocketImpl(gatewayUrl.toString()); }
      catch { state = 'failed'; finish(reject, new GatewayAdapterError('GATEWAY_CONNECT_FAILED', 'Gateway connection could not be opened')); return; }
      const processRef = socket;
      cancelConnect = (error) => finish(reject, error);
      attach('open', () => {
        if (generation !== lifecycleGeneration || socket !== processRef) return;
        state = 'ready';
        finish(resolve, Object.freeze({ status: 'ready' }));
      });
      attach('message', handleMessage);
      attach('close', () => {
        if (generation !== lifecycleGeneration || socket !== processRef) return;
        handleClose(processRef);
        finish(reject, new GatewayAdapterError('GATEWAY_CONNECT_FAILED', 'Gateway connection closed before ready'));
      });
      attach('error', () => {
        if (generation !== lifecycleGeneration || socket !== processRef) return;
        if (state === 'connecting') { state = 'failed'; finish(reject, new GatewayAdapterError('GATEWAY_CONNECT_FAILED', 'Gateway connection failed')); }
      });
      timer = setTimeout(() => {
        if (generation !== lifecycleGeneration || socket !== processRef) return;
        state = 'failed';
        finish(reject, new GatewayAdapterError('GATEWAY_CONNECT_TIMEOUT', 'Gateway connection timed out'));
        socket?.close?.();
      }, connectTimeoutMs);
    });
    return connectPromise;
  }

  function request(method, params = {}, { signal } = {}) {
    if (state !== 'ready' || !socket) return Promise.reject(new GatewayAdapterError('GATEWAY_NOT_CONNECTED', 'Gateway is not connected'));
    if (typeof method !== 'string' || !method || method.length > 256) return Promise.reject(new GatewayAdapterError('GATEWAY_METHOD_INVALID', 'Gateway method is invalid'));
    const id = randomUUID();
    const payload = JSON.stringify({ id, method, params });
    if (byteLength(payload) > maxMessageBytes) return Promise.reject(new GatewayAdapterError('GATEWAY_FRAME_LIMIT', 'Gateway frame exceeded the configured limit'));
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        clearTimeout(timer);
        reject(new GatewayAdapterError('GATEWAY_REQUEST_ABORTED', 'Gateway request was cancelled'));
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        signal?.removeEventListener('abort', abort);
        reject(new GatewayAdapterError('GATEWAY_REQUEST_TIMEOUT', 'Gateway request timed out'));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      try { socket.send(payload); }
      catch { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new GatewayAdapterError('GATEWAY_SEND_FAILED', 'Gateway request could not be sent')); }
    });
  }

  async function close() {
    lifecycleGeneration += 1;
    cancelConnect?.(new GatewayAdapterError('GATEWAY_CLOSED', 'Gateway connection closed'));
    const current = socket;
    socket = null;
    state = 'disconnected';
    failPending(new GatewayAdapterError('GATEWAY_CLOSED', 'Gateway connection closed'));
    current?.close?.();
  }

  return Object.freeze({
    connect,
    request,
    close,
    getState: () => state,
    getUrl: () => gatewayUrl.toString(),
  });
}
