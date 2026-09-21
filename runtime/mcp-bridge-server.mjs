import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createToolRegistry } from './tool-registry.mjs';
import { boundedJson, redactValue } from './redaction.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_IDLE_SESSION_MS = 15 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const JSON_RPC_ID = /^(?:[A-Za-z0-9._:-]{1,128}|0|[1-9][0-9]{0,15})$/;
const PATH_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

export class McpBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpBridgeError';
    this.code = code;
  }
}

function fail(code, message) { throw new McpBridgeError(code, message); }

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function responseError(response, status, code) {
  responseJson(response, status, { error: code, message: 'MCP bridge request was rejected' });
}

function hasBearer(request, token) {
  const received = createHash('sha256').update(request.headers.authorization ?? '').digest();
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(expected, received);
}

function safeCode(error, fallback = 'MCP_BRIDGE_ERROR') {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : fallback;
}

function originAllowed(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return typeof origin === 'string' && allowedOrigins.has(origin);
}

function requestSignal(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  return Object.freeze({ signal: controller.signal, cleanup() { request.removeListener('aborted', abort); response.removeListener('close', abort); } });
}

async function bodyOf(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) fail('MCP_BODY_LIMIT', 'MCP request exceeded the configured body limit');
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail('MCP_JSON_INVALID', 'MCP request body is required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('MCP_JSON_INVALID', 'MCP request body is invalid'); }
}

function requestId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && JSON_RPC_ID.test(value) ? value : null;
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function parseRpc(value) {
  if (!plainObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method || value.method.length > 128 || /[\0\r\n]/.test(value.method)) fail('MCP_JSONRPC_INVALID', 'MCP request is not a valid JSON-RPC request');
  if (value.params !== undefined && !plainObject(value.params)) fail('MCP_JSONRPC_INVALID', 'MCP request params must be an object');
  const id = value.id === undefined ? null : requestId(value.id);
  if (value.id !== undefined && id === null) fail('MCP_JSONRPC_INVALID', 'MCP request id is invalid');
  return Object.freeze({ id, method: value.method, params: value.params ?? {} });
}

function wantsSse(request) {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

function streamResponse(response, value, maxBytes) {
  const encoded = boundedJson(value, maxBytes, 'MCP_RESPONSE_LIMIT');
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  response.end(`event: message\ndata: ${encoded}\n\n`);
}

function toolCatalog(registry) {
  if (!registry || typeof registry.definitions !== 'function' || typeof registry.call !== 'function') fail('MCP_REGISTRY_REQUIRED', 'workspace tool registry is required');
  const definitions = registry.definitions({ mode: 'Code' });
  if (!Array.isArray(definitions)) fail('MCP_REGISTRY_INVALID', 'workspace tool registry is invalid');
  const tools = definitions.map((definition) => {
    const fn = definition?.function;
    if (!fn || typeof fn.name !== 'string' || typeof fn.description !== 'string' || !plainObject(fn.parameters)) fail('MCP_REGISTRY_INVALID', 'workspace tool registry has an invalid definition');
    const readOnly = !['workspace.patch', 'workspace.command'].includes(fn.name);
    return Object.freeze({ name: fn.name, description: fn.description, inputSchema: fn.parameters, annotations: Object.freeze({ readOnlyHint: readOnly, destructiveHint: false, idempotentHint: false, openWorldHint: false }) });
  });
  return Object.freeze(tools);
}

function toolResult(value, maxBytes) {
  const structuredContent = redactValue(value, { maxStringLength: 64 * 1024 });
  const text = boundedJson(structuredContent, maxBytes, 'MCP_RESPONSE_LIMIT');
  return Object.freeze({ content: Object.freeze([{ type: 'text', text }]), structuredContent });
}

function toolFailure(error, maxBytes) {
  const code = safeCode(error, 'TOOL_EXECUTION_FAILED');
  return Object.freeze({ ...toolResult({ error: { code } }, maxBytes), isError: true });
}

export function createMcpBridgeServer({
  root,
  token,
  registry = root ? createToolRegistry({ root }) : undefined,
  host = '127.0.0.1',
  port = 0,
  pathToken,
  pathTokenTtlMs = 5 * 60 * 1000,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxSessions = DEFAULT_MAX_SESSIONS,
  idleSessionMs = DEFAULT_IDLE_SESSION_MS,
  allowedOrigins = [],
  clock = () => Date.now(),
} = {}) {
  if (!root) throw new McpBridgeError('MCP_ROOT_REQUIRED', 'workspace root is required');
  if (typeof token !== 'string' || token.length < 16) throw new McpBridgeError('MCP_AUTH_CONFIG_INVALID', 'bridge bearer token must be at least 16 characters');
  if (!LOOPBACK_HOSTS.has(host)) throw new McpBridgeError('MCP_BIND_INVALID', 'bridge host must be loopback');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new McpBridgeError('MCP_PORT_INVALID', 'bridge port is invalid');
  for (const [name, value, maximum] of [['maxBodyBytes', maxBodyBytes, 4 * 1024 * 1024], ['maxResponseBytes', maxResponseBytes, 4 * 1024 * 1024], ['maxSessions', maxSessions, 256], ['idleSessionMs', idleSessionMs, 24 * 60 * 60 * 1000], ['pathTokenTtlMs', pathTokenTtlMs, 24 * 60 * 60 * 1000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new McpBridgeError('MCP_CONFIG_INVALID', `${name} is invalid`);
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => typeof origin !== 'string' || !origin || origin.length > 512)) throw new McpBridgeError('MCP_ORIGIN_CONFIG_INVALID', 'allowed origins are invalid');
  if (pathToken !== undefined && (typeof pathToken !== 'string' || !PATH_TOKEN.test(pathToken))) throw new McpBridgeError('MCP_PATH_TOKEN_INVALID', 'bridge path token is invalid');
  const endpoint = pathToken ? `/mcp/${pathToken}` : '/mcp';
  const expiresPathTokenAt = pathToken ? clock() + pathTokenTtlMs : null;
  const origins = new Set(allowedOrigins);
  const tools = toolCatalog(registry);
  const toolsByName = new Set(tools.map((tool) => tool.name));
  const sessions = new Map();
  const requestOwners = new Map();
  let server;
  let stopping = false;
  let sessionExpiryTimer;

  function expireSessions() {
    const now = clock();
    for (const session of [...sessions.values()]) if (now - session.lastActivity > idleSessionMs) closeSession(session.id);
  }

  function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    for (const requestIdValue of session.requestIds) requestOwners.delete(requestIdValue);
    for (const response of session.streams) {
      try { response.end(); } catch {}
    }
    session.streams.clear();
  }

  function requireSession(request) {
    expireSessions();
    const id = request.headers['mcp-session-id'];
    if (typeof id !== 'string' || !id || id.length > 128 || /[^!-~]/.test(id)) fail('MCP_SESSION_REQUIRED', 'MCP session header is required');
    const session = sessions.get(id);
    if (!session) fail('MCP_SESSION_NOT_FOUND', 'MCP session was not found');
    if (request.headers['mcp-protocol-version'] !== PROTOCOL_VERSION) fail('MCP_PROTOCOL_INVALID', 'MCP protocol version is invalid');
    session.lastActivity = clock();
    return session;
  }

  function claimRequest(session, id) {
    if (id === null) return;
    const owner = requestOwners.get(id);
    if (owner !== undefined) fail('MCP_REQUEST_REPLAY', 'MCP request id was already used');
    requestOwners.set(id, session.id);
    session.requestIds.add(id);
  }

  async function dispatch(session, rpc, signal) {
    if (rpc.method === 'notifications/initialized') return null;
    if (rpc.method === 'ping') return {};
    if (rpc.method === 'tools/list') return { tools };
    if (rpc.method !== 'tools/call') fail('MCP_METHOD_NOT_FOUND', 'MCP method is not supported');
    const name = rpc.params.name;
    const input = rpc.params.arguments ?? {};
    if (typeof name !== 'string' || !toolsByName.has(name) || !plainObject(input)) return toolFailure(Object.assign(new Error('tool input is invalid'), { code: 'TOOL_INPUT_INVALID' }), maxResponseBytes);
    try {
      const mode = name === 'workspace.patch' || name === 'workspace.command' ? 'Code' : 'Ask';
      return toolResult(await registry.call({ mode, name, input, sessionId: session.id, signal }), maxResponseBytes);
    } catch (error) {
      return toolFailure(error, maxResponseBytes);
    }
  }

  async function handle(request, response) {
    const pathname = new URL(request.url, `http://${host}`).pathname;
    try {
      if (pathname !== endpoint || (expiresPathTokenAt !== null && clock() >= expiresPathTokenAt)) return responseError(response, 404, 'MCP_ENDPOINT_NOT_FOUND');
      if (!originAllowed(request, origins)) return responseError(response, 403, 'MCP_ORIGIN_FORBIDDEN');
      if (!hasBearer(request, token)) return responseError(response, 401, 'MCP_UNAUTHORIZED');
      if (request.method === 'GET') {
        const session = requireSession(request);
        const accept = String(request.headers.accept ?? '').toLowerCase();
        if (!accept.includes('text/event-stream')) return responseError(response, 406, 'MCP_ACCEPT_INVALID');
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        response.write(': connected\n\n');
        session.streams.add(response);
        response.once('close', () => session.streams.delete(response));
        return;
      }
      if (request.method === 'DELETE') {
        const session = requireSession(request);
        closeSession(session.id);
        response.writeHead(204, { 'cache-control': 'no-store' });
        return response.end();
      }
      if (request.method !== 'POST') return responseError(response, 405, 'MCP_METHOD_NOT_ALLOWED');
      if (!String(request.headers['content-type'] ?? '').toLowerCase().includes('application/json')) return responseError(response, 415, 'MCP_CONTENT_TYPE_INVALID');
      const rpc = parseRpc(await bodyOf(request, maxBodyBytes));
      const lifecycle = requestSignal(request, response);
      try {
        if (rpc.method === 'initialize') {
          if (request.headers['mcp-session-id'] !== undefined) return responseError(response, 400, 'MCP_SESSION_FIXATION');
          if (rpc.params.protocolVersion !== PROTOCOL_VERSION) return responseError(response, 400, 'MCP_PROTOCOL_INVALID');
          expireSessions();
          if (sessions.size >= maxSessions) return responseError(response, 429, 'MCP_SESSION_LIMIT');
          const id = randomUUID();
          const session = { id, lastActivity: clock(), requestIds: new Set(), streams: new Set() };
          sessions.set(id, session);
          const result = rpcResult(rpc.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'openclaw-workbench', version: '0.1.0' } });
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'mcp-session-id': id });
          return response.end(boundedJson(result, maxResponseBytes, 'MCP_RESPONSE_LIMIT'));
        }
        const session = requireSession(request);
        if (rpc.id === null) {
          if (rpc.method !== 'notifications/initialized') return responseError(response, 400, 'MCP_NOTIFICATION_INVALID');
          await dispatch(session, rpc, lifecycle.signal);
          response.writeHead(202, { 'cache-control': 'no-store' });
          return response.end();
        }
        claimRequest(session, rpc.id);
        let result;
        try { result = await dispatch(session, rpc, lifecycle.signal); }
        catch (error) {
          if (error instanceof McpBridgeError && error.code === 'MCP_METHOD_NOT_FOUND') result = rpcError(rpc.id, -32601, 'Method not found');
          else result = rpcError(rpc.id, -32603, 'Internal error');
        }
        const envelope = result?.jsonrpc === '2.0' ? result : rpcResult(rpc.id, result);
        if (wantsSse(request)) return streamResponse(response, envelope, maxResponseBytes);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(boundedJson(envelope, maxResponseBytes, 'MCP_RESPONSE_LIMIT'));
      } finally {
        lifecycle.cleanup();
      }
    } catch (error) {
      const code = safeCode(error);
      const status = code === 'MCP_BODY_LIMIT' || code === 'MCP_RESPONSE_LIMIT' ? 413
        : code === 'MCP_SESSION_NOT_FOUND' ? 404
          : code === 'MCP_REQUEST_REPLAY' ? 409
            : code === 'MCP_SESSION_LIMIT' ? 429
              : ['MCP_ORIGIN_FORBIDDEN'].includes(code) ? 403
                : ['MCP_JSON_INVALID', 'MCP_JSONRPC_INVALID', 'MCP_PROTOCOL_INVALID', 'MCP_SESSION_REQUIRED', 'MCP_SESSION_FIXATION', 'MCP_NOTIFICATION_INVALID'].includes(code) ? 400
                  : 500;
      if (!response.headersSent) responseError(response, status, code);
      else response.end();
    }
  }

  server = http.createServer((request, response) => { void handle(request, response); });

  async function start() {
    if (server.listening) return address();
    if (stopping) fail('MCP_BRIDGE_STOPPING', 'MCP bridge is stopping');
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    sessionExpiryTimer = setInterval(expireSessions, Math.min(idleSessionMs, 60_000));
    sessionExpiryTimer.unref?.();
    return address();
  }

  function address() {
    return server.listening ? server.address() : null;
  }

  async function stop() {
    if (sessionExpiryTimer) {
      clearInterval(sessionExpiryTimer);
      sessionExpiryTimer = undefined;
    }
    if (!server.listening) return;
    stopping = true;
    for (const session of [...sessions.values()]) closeSession(session.id);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  return Object.freeze({ start, stop, address, endpointPath: () => endpoint, protocolVersion: PROTOCOL_VERSION });
}
