import { randomUUID } from 'node:crypto';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
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
  let lifecycleGeneration = 0;
  const activeControllers = new Set();

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
    const abortExternal = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
    if (signal?.aborted) abortExternal();
    else signal?.addEventListener('abort', abortExternal, { once: true });
    try {
      const response = await fetchImpl(target, { method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body, signal: controller.signal });
      if (!response || !response.ok) throw new McpHttpTransportError('MCP_HTTP_STATUS', 'MCP server returned an HTTP error');
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
      if (timedOut) throw new McpHttpTransportError('MCP_REQUEST_TIMEOUT', 'MCP request timed out');
      if (signal?.aborted) throw new McpHttpTransportError('MCP_REQUEST_ABORTED', 'MCP request was cancelled');
      throw new McpHttpTransportError('MCP_REQUEST_FAILED', 'MCP request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortExternal);
      activeControllers.delete(controller);
    }
  }

  async function close() {
    lifecycleGeneration += 1;
    state = 'disconnected';
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    sessionId = null;
  }

  return Object.freeze({ start, request, close, getState: () => state, getEndpoint: () => target });
}
