import { randomUUID } from 'node:crypto';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = '2025-06-18';
const SENSITIVE_QUERY = /(?:token|secret|password|passwd|auth|bearer|api[_-]?key|apikey|accesskey|clientsecret|key)/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export class McpHttpTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpHttpTransportError';
    this.code = code;
    this.details = details;
  }
}

function endpointUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\0\r\n]/.test(value)) throw new McpHttpTransportError('MCP_ENDPOINT_INVALID', 'MCP endpoint is invalid');
  let parsed;
  try { parsed = new URL(value); } catch { throw new McpHttpTransportError('MCP_ENDPOINT_INVALID', 'MCP endpoint is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) throw new McpHttpTransportError('MCP_ENDPOINT_INVALID', 'MCP endpoint must be credential-free HTTP(S)');
  return parsed.toString();
}

function validateHeaders(headers) {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new McpHttpTransportError('MCP_HEADERS_INVALID', 'MCP headers are invalid');
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new McpHttpTransportError('MCP_HEADERS_INVALID', 'MCP headers are invalid');
  }
  return { ...headers };
}

function frameBytes(text) { return Buffer.byteLength(text, 'utf8'); }

function parseSse(text, requestId) {
  let candidate = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    let frame;
    try { frame = JSON.parse(data); } catch { continue; }
    if (frame && (String(frame.id) === requestId)) candidate = frame;
  }
  if (!candidate) throw new McpHttpTransportError('MCP_FRAME_INVALID', 'MCP SSE response is not a valid JSON-RPC frame');
  return candidate;
}

function createSseParser({ onFrame, maxBytes }) {
  let buffer = '';
  let lastEventId = null;
  let eventName = null;
  let dataLines = [];
  let eventId = null;
  function dispatch() {
    if (dataLines.length === 0) { eventName = null; eventId = null; return; }
    const data = dataLines.join('\n');
    const id = eventId;
    const name = eventName ?? 'message';
    eventName = null; eventId = null; dataLines = [];
    if (id !== null) lastEventId = id;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (frame && typeof frame === 'object') onFrame({ event: name, id, frame });
  }
  return {
    get lastEventId() { return lastEventId; },
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        if (Buffer.byteLength(block, 'utf8') > maxBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP SSE event exceeded the configured limit');
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('id:')) { const value = line.slice(3).trimStart(); if (value) eventId = value; continue; }
          if (line.startsWith('event:')) { eventName = line.slice(6).trimStart(); continue; }
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        dispatch();
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP SSE event exceeded the configured limit');
    },
    finish() { if (buffer.trim()) { buffer += '\n\n'; this.push(''); } },
  };
}

async function readBoundedText(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (frameBytes(text) > maxBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally { reader.releaseLock?.(); }
}

export function createMcpHttpTransport({
  endpoint,
  transport = 'streamable-http',
  headers = {},
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const target = endpointUrl(endpoint);
  if (!['sse', 'streamable-http'].includes(transport)) throw new McpHttpTransportError('MCP_TRANSPORT_INVALID', 'unsupported MCP HTTP transport');
  const baseHeaders = validateHeaders(headers);
  for (const [name, value] of [['requestTimeoutMs', requestTimeoutMs], ['maxFrameBytes', maxFrameBytes]]) if (!Number.isSafeInteger(value) || value < 1) throw new McpHttpTransportError('MCP_CONFIG_INVALID', `${name} must be a positive safe integer`);
  if (typeof fetchImpl !== 'function') throw new McpHttpTransportError('MCP_FETCH_INVALID', 'fetch implementation is unavailable');

  let state = 'disconnected';
  let sessionId = null;
  let protocolVersion = null;
  let lifecycleGeneration = 0;
  const activeControllers = new Set();
  const subscriptions = new Set();

  async function start() {
    state = 'ready';
    return Object.freeze({ status: 'ready' });
  }

  async function request(method, params = {}, { signal } = {}) {
    if (state !== 'ready') throw new McpHttpTransportError('MCP_NOT_STARTED', 'MCP HTTP transport is not started');
    if (typeof method !== 'string' || !method || method.length > 256 || /[\0\r\n]/.test(method)) throw new McpHttpTransportError('MCP_METHOD_INVALID', 'MCP method is invalid');
    const id = randomUUID();
    const generation = lifecycleGeneration;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (frameBytes(body) > maxFrameBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit');
    const controller = new AbortController();
    activeControllers.add(controller);
    let timedOut = false;
    // An explicit caller abort must win over the timeout timer: under
    // parallel load the fetch rejection from an abort can be processed
    // after the timer fires, and mapping timeout first then misreports
    // a user abort as a timeout. The timer sets timedOut directly and
    // never goes through abortExternal, so this flag is caller-only.
    let abortedByCaller = false;
    const abortExternal = () => { abortedByCaller = true; controller.abort(); };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    if (signal?.aborted) abortExternal();
    else signal?.addEventListener('abort', abortExternal, { once: true });
    try {
      const response = await fetchImpl(target, { method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}) }, body, signal: controller.signal });
      if (!response || !response.ok) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP server returned an HTTP error');
      if (response.status === 202 || response.status === 204) return null;
      const responseText = await readBoundedText(response, maxFrameBytes);
      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
      const frame = contentType.includes('text/event-stream') ? parseSse(responseText, id) : (() => { try { return JSON.parse(responseText); } catch { throw new McpHttpTransportError('MCP_FRAME_INVALID', 'MCP response is not valid JSON'); } })();
      if (!frame || typeof frame !== 'object' || String(frame.id) !== id) throw new McpHttpTransportError('MCP_FRAME_INVALID', 'MCP response is not a matching JSON-RPC frame');
      const receivedSession = response.headers?.get?.('mcp-session-id');
      if (receivedSession) sessionId = receivedSession;
      if (frame.error) throw new McpHttpTransportError('MCP_REMOTE_ERROR', 'MCP server returned an error response');
      return frame.result;
    } catch (error) {
      if (error instanceof McpHttpTransportError) { if (error.code === 'MCP_FRAME_INVALID' || error.code === 'MCP_FRAME_LIMIT') state = 'failed'; throw error; }
      if (generation !== lifecycleGeneration) throw new McpHttpTransportError('MCP_TRANSPORT_CLOSED', 'MCP transport was closed');
      if (abortedByCaller) throw new McpHttpTransportError('MCP_REQUEST_ABORTED', 'MCP request was cancelled');
      if (timedOut) throw new McpHttpTransportError('MCP_REQUEST_TIMEOUT', 'MCP request timed out');
      if (signal?.aborted) throw new McpHttpTransportError('MCP_REQUEST_ABORTED', 'MCP request was cancelled');
      throw new McpHttpTransportError('MCP_REQUEST_FAILED', 'MCP request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortExternal);
      activeControllers.delete(controller);
    }
  }

  async function notify(method, params = {}) {
    if (state !== 'ready') throw new McpHttpTransportError('MCP_NOT_STARTED', 'MCP HTTP transport is not started');
    if (typeof method !== 'string' || !method || method.length > 256 || /[\0\r\n]/.test(method)) throw new McpHttpTransportError('MCP_METHOD_INVALID', 'MCP method is invalid');
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (frameBytes(body) > maxFrameBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit');
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(target, { method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}) }, body, signal: controller.signal });
      if (!response || !response.ok) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP server returned an HTTP error');
      return Object.freeze({ status: response.status });
    } finally { clearTimeout(timer); activeControllers.delete(controller); }
  }

  async function initialize(params = {}) {
    const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'openclaw-workbench', version: '0.1.0' }, ...params });
    if (!result || typeof result !== 'object' || result.protocolVersion !== PROTOCOL_VERSION) throw new McpHttpTransportError('MCP_PROTOCOL_VERSION_MISMATCH', 'MCP server protocol version is not supported');
    protocolVersion = PROTOCOL_VERSION;
    await notify('notifications/initialized', {});
    return result;
  }

  function subscribe({ onMessage, onNotification, onRequest, onError, lastEventId: resumeId, signal } = {}) {
    if (state !== 'ready') throw new McpHttpTransportError('MCP_NOT_STARTED', 'MCP HTTP transport is not started');
    if (!sessionId) throw new McpHttpTransportError('MCP_SESSION_REQUIRED', 'MCP session is required before opening an SSE stream');
    for (const [name, fn] of [['onMessage', onMessage], ['onNotification', onNotification], ['onRequest', onRequest], ['onError', onError]]) if (fn !== undefined && typeof fn !== 'function') throw new McpHttpTransportError('MCP_CALLBACK_INVALID', `${name} must be a function`);
    const controller = new AbortController();
    const generation = lifecycleGeneration;
    let lastEventId = resumeId ?? null;
    let closed = false;
    let rejectClosed;
    let resolveClosed;
    const closedPromise = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    closedPromise.catch(() => {});
    const parser = createSseParser({
      maxBytes: maxFrameBytes,
      onFrame: ({ id, frame }) => {
        if (id !== null) lastEventId = id;
        if (frame && typeof frame.method === 'string' && frame.id !== undefined) {
          if (onRequest) {
            // Q28-3: a server-request reply is an outbound frame like any
            // other, so it gets the same maxFrameBytes check, and a reply
            // failure is never swallowed: it is reported to onError when
            // one is registered, and otherwise closes the subscription
            // with a rejected closedPromise so the failure is visible to
            // the caller instead of vanishing into a caught promise.
            Promise.resolve().then(() => onRequest(frame)).then(async (result) => {
              if (result === undefined) return;
              const body = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result });
              if (frameBytes(body) > maxFrameBytes) throw new McpHttpTransportError('MCP_FRAME_LIMIT', 'MCP response frame exceeded the configured limit');
              const reply = await fetchImpl(target, { method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}) }, body, signal: controller.signal });
              if (!reply || !reply.ok) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP server request reply failed');
            }).catch((error) => {
              const report = error instanceof McpHttpTransportError ? error : new McpHttpTransportError('MCP_REQUEST_FAILED', 'MCP server request reply failed');
              if (onError) {
                try { onError(report); } catch { controller.abort(); finish(report); }
              } else { controller.abort(); finish(report); }
            });
          }
          onMessage?.(frame);
          return;
        }
        if (frame && typeof frame.method === 'string') { onNotification?.(frame) ?? onMessage?.(frame); return; }
        onMessage?.(frame);
      },
    });
    // Q28-4: onError runs inside try/finally so a throwing error
    // callback can never strand closedPromise: the rejection (or the
    // clean resolution) always executes. The callback's own throw is
    // swallowed here -- finish is also called from a detached stream
    // task, where a rethrown callback error would surface as an
    // unhandled rejection instead of reaching any caller.
    const finish = (error) => {
      if (closed) return;
      closed = true;
      subscriptions.delete(handle);
      try { if (error) onError?.(error); } catch {}
      finally { if (error) rejectClosed(error); else resolveClosed(Object.freeze({ status: 'closed', lastEventId })); }
    };
    const handle = Object.freeze({
      close: () => { controller.abort(); finish(null); },
      get lastEventId() { return lastEventId; },
      get closed() { return closed; },
      closedPromise,
    });
    subscriptions.add(handle);
    if (signal?.aborted) { finish(null); return handle; }
    signal?.addEventListener('abort', () => { controller.abort(); finish(null); }, { once: true });
    void (async () => {
      try {
        const response = await fetchImpl(target, { method: 'GET', headers: { ...baseHeaders, accept: 'text/event-stream', 'mcp-session-id': sessionId, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: controller.signal });
        if (!response || !response.ok) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP SSE stream returned an HTTP error');
        const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
        if (!contentType.includes('text/event-stream')) throw new McpHttpTransportError('MCP_FRAME_INVALID', 'MCP SSE stream did not return an event stream');
        const decoder = new TextDecoder();
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              parser.push(decoder.decode(value, { stream: true }));
              lastEventId = parser.lastEventId ?? lastEventId;
            }
            parser.push(decoder.decode());
          } finally { reader.releaseLock?.(); }
        } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
          for await (const chunk of response.body) parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
          parser.push(decoder.decode());
        } else {
          parser.push(await response.text());
        }
        lastEventId = parser.lastEventId ?? lastEventId;
        if (generation !== lifecycleGeneration) throw new McpHttpTransportError('MCP_TRANSPORT_CLOSED', 'MCP transport was closed');
        finish(null);
      } catch (error) {
        if (controller.signal.aborted || generation !== lifecycleGeneration) { finish(null); return; }
        finish(error instanceof McpHttpTransportError ? error : new McpHttpTransportError('MCP_REQUEST_FAILED', 'MCP SSE stream failed'));
      }
    })();
    return handle;
  }

  async function terminateSession() {
    if (state !== 'ready') throw new McpHttpTransportError('MCP_NOT_STARTED', 'MCP HTTP transport is not started');
    if (!sessionId) return Object.freeze({ status: 'no-session' });
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(target, { method: 'DELETE', headers: { ...baseHeaders, accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId, ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}) }, signal: controller.signal });
      if (!response || !(response.ok || response.status === 404)) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP session termination failed');
      sessionId = null;
      protocolVersion = null;
      // Q28-4: terminating the session also closes its live SSE
      // subscriptions; previously a caller had to close the stream
      // manually first, and the DELETE-then-stream link was untested.
      // A failed DELETE leaves the session (and its streams) in place.
      for (const subscription of [...subscriptions]) subscription.close();
      return Object.freeze({ status: 'terminated' });
    } finally { clearTimeout(timer); activeControllers.delete(controller); }
  }

  async function close() {
    lifecycleGeneration += 1;
    state = 'disconnected';
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    for (const subscription of [...subscriptions]) subscription.close();
    subscriptions.clear();
    sessionId = null;
    protocolVersion = null;
  }

  return Object.freeze({ start, request, notify, initialize, subscribe, terminateSession, close, getState: () => state, getEndpoint: () => target, getSessionId: () => sessionId, getProtocolVersion: () => protocolVersion, protocolVersion: PROTOCOL_VERSION });
}
