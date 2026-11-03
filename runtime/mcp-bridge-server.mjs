import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createToolRegistry } from './tool-registry.mjs';
import { boundedJson, redactValue } from './redaction.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_REQUEST_IDS_PER_SESSION = 1024;
const DEFAULT_MAX_STREAMS_PER_SESSION = 16;
const DEFAULT_MAX_REPLAY_EVENTS = 100;
const DEFAULT_IDLE_SESSION_MS = 15 * 60 * 1000;
const EVENT_ID_PATTERN = /^evt-[1-9][0-9]{0,14}$/;
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
  maxRequestIdsPerSession = DEFAULT_MAX_REQUEST_IDS_PER_SESSION,
  maxStreamsPerSession = DEFAULT_MAX_STREAMS_PER_SESSION,
  maxReplayEvents = DEFAULT_MAX_REPLAY_EVENTS,
  idleSessionMs = DEFAULT_IDLE_SESSION_MS,
  allowedOrigins = [],
  clock = () => Date.now(),
  // Persistent replay (opt-in). When set, every broadcast is also
  // appended to an atomic JSON snapshot file, so the replay buffer
  // survives a bridge restart. A snapshot holds ONLY event content
  // (the broadcast notification JSON) and the cursor (next sequence);
  // it never holds the bridge Bearer <redacted> the session id itself is
  // stored only as its SHA-256 hash, so the file contains no usable
  // credential or session capability. Callers must not broadcast secret
  // material: broadcast params are persisted verbatim, exactly as they
  // were already buffered in memory. A relative path resolves against
  // the workspace root. The store is single-owner: two live bridges
  // sharing one path will overwrite each other (last writer wins).
  replayStorePath,
} = {}) {
  if (!root) throw new McpBridgeError('MCP_ROOT_REQUIRED', 'workspace root is required');
  if (typeof token !== 'string' || token.length < 16) throw new McpBridgeError('MCP_AUTH_CONFIG_INVALID', 'bridge bearer token must be at least 16 characters');
  if (!LOOPBACK_HOSTS.has(host)) throw new McpBridgeError('MCP_BIND_INVALID', 'bridge host must be loopback');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new McpBridgeError('MCP_PORT_INVALID', 'bridge port is invalid');
  for (const [name, value, maximum] of [['maxBodyBytes', maxBodyBytes, 4 * 1024 * 1024], ['maxResponseBytes', maxResponseBytes, 4 * 1024 * 1024], ['maxSessions', maxSessions, 256], ['maxRequestIdsPerSession', maxRequestIdsPerSession, 100_000], ['maxStreamsPerSession', maxStreamsPerSession, 256], ['maxReplayEvents', maxReplayEvents, 1000], ['idleSessionMs', idleSessionMs, 24 * 60 * 60 * 1000], ['pathTokenTtlMs', pathTokenTtlMs, 24 * 60 * 60 * 1000]]) {
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

  // --- Persistent replay snapshots (see option comment above) ---
  // In-memory index of the snapshot file, keyed by SHA-256(sessionId).
  // Live sessions are never seeded from it automatically: after a
  // restart, an old session id is expired (HTTP 404, exactly as an
  // unknown session), and only an explicit resumeSession(oldId) call —
  // by the embedding application, never by an HTTP request — seeds a
  // NEW session id with the persisted buffer. A session closed with
  // DELETE leaves a tombstone ({closed:true}, events dropped) so it can
  // never be silently revived by a later restart + resume.
  const replayStoreFile = replayStorePath === undefined ? null
    : path.isAbsolute(replayStorePath) ? replayStorePath : path.join(root, replayStorePath);
  if (replayStorePath !== undefined && typeof replayStorePath !== 'string') throw new McpBridgeError('MCP_CONFIG_INVALID', 'replay store path is invalid');
  const replaySnapshots = new Map();
  function snapshotKey(sessionId) {
    return createHash('sha256').update(sessionId).digest('hex');
  }
  function validSnapshotEntry(entry) {
    if (!plainObject(entry) || typeof entry.key !== 'string' || !/^[0-9a-f]{64}$/.test(entry.key)) return false;
    if (!Number.isSafeInteger(entry.nextEventSequence) || entry.nextEventSequence < 1) return false;
    if (!Number.isSafeInteger(entry.lastActivity) || entry.lastActivity < 0) return false;
    if (typeof entry.closed !== 'boolean' || !Array.isArray(entry.events) || entry.events.length > maxReplayEvents) return false;
    if (entry.closed && entry.events.length !== 0) return false;
    // A snapshot is only the writer's own shape, checked end to end:
    // event ids must match their sequence (evt-N <=> sequence N), the
    // buffer must be contiguous (a gap means a lost or forged event, and
    // resolveReplay would otherwise treat a never-buffered sequence as
    // a valid resume cursor), and the cursor must follow the last event
    // (or be 1 for an open session that never broadcast). A closed
    // tombstone keeps its cursor with an empty buffer, so it is exempt
    // from the open-session cursor rule, but never from the other rules.
    // The encoded frame must be exactly a broadcast notification:
    // jsonrpc 2.0, a method, an object params (when present), and no
    // id/result/error keys, so a corrupted snapshot cannot smuggle a
    // JSON-RPC response — or a request a client would answer — into a
    // replay stream. The encoded text must also be a single line: the
    // replay writer splices it verbatim into one SSE `data:` line, so
    // a raw CR or LF in it (for example pretty-printed JSON) would
    // split the frame. Its size limit is UTF-8 bytes, matching the
    // writer's boundedJson, not JS string length, so a multibyte frame
    // cannot slip past the limit. The method check rejects only
    // NUL/CR/LF — TAB, ESC, DEL still pass, exactly as broadcast
    // does — so it must not be described as "no control characters".
    // Anything failing any of these checks drops the
    // whole entry; a valid entry in the same file is unaffected.
    let previousSequence = null;
    for (const event of entry.events) {
      if (!plainObject(event) || typeof event.id !== 'string' || !EVENT_ID_PATTERN.test(event.id)
        || !Number.isSafeInteger(event.sequence) || event.sequence < 1
        || event.id !== `evt-${event.sequence}`
        || (previousSequence !== null && event.sequence !== previousSequence + 1)
        || typeof event.encoded !== 'string' || Buffer.byteLength(event.encoded, 'utf8') > maxResponseBytes
        || /[\r\n]/.test(event.encoded)) return false;
      previousSequence = event.sequence;
      try {
        const parsed = JSON.parse(event.encoded);
        if (!plainObject(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string' || !parsed.method || parsed.method.length > 128 || /[\0\r\n]/.test(parsed.method)
          || (parsed.params !== undefined && !plainObject(parsed.params))
          || parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) return false;
      } catch { return false; }
    }
    if (entry.events.length === 0) {
      if (!entry.closed && entry.nextEventSequence !== 1) return false;
    } else if (entry.nextEventSequence !== previousSequence + 1) {
      return false;
    }
    return true;
  }
  function loadReplaySnapshots() {
    if (!replayStoreFile) return;
    let parsed;
    try { parsed = JSON.parse(readFileSync(replayStoreFile, 'utf8')); } catch { return; }
    if (!plainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.snapshots)) return;
    for (const entry of parsed.snapshots) {
      // First valid entry for a key wins: a later duplicate must never
      // silently shadow an earlier snapshot for the same session hash.
      if (validSnapshotEntry(entry) && !replaySnapshots.has(entry.key)) replaySnapshots.set(entry.key, entry);
    }
  }
  // Best-effort by design: persistence must never break broadcasting or
  // shutdown. A failed write leaves the in-memory buffer intact, and the
  // next broadcast retries.
  function persistReplaySnapshots() {
    if (!replayStoreFile) return;
    try {
      mkdirSync(path.dirname(replayStoreFile), { recursive: true });
      const payload = JSON.stringify({ version: 1, snapshots: [...replaySnapshots.values()] });
      const tmp = `${replayStoreFile}.tmp-${process.pid}`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, replayStoreFile);
    } catch {}
  }
  function snapshotSession(session, closed) {
    if (!replayStoreFile) return;
    if (closed) {
      replaySnapshots.set(snapshotKey(session.id), { key: snapshotKey(session.id), nextEventSequence: session.nextEventSequence, lastActivity: clock(), closed: true, events: [] });
    } else {
      replaySnapshots.set(snapshotKey(session.id), { key: snapshotKey(session.id), nextEventSequence: session.nextEventSequence, lastActivity: session.lastActivity, closed: false, events: session.eventBuffer.map((event) => ({ ...event })) });
    }
    persistReplaySnapshots();
  }
  loadReplaySnapshots();

  function resumeSession(oldSessionId) {
    // Expiry is enforced here, not only on the HTTP path: without this,
    // a live-but-idle-expired session would answer ACTIVE (it is still
    // in the table until the timer runs) and could never be resumed,
    // while its snapshot quietly aged past the idle window.
    // expireSessions() reuses the HTTP path's full-session scan (it
    // walks every live session); this call adds scan frequency, it is
    // not a target-only or O(1) check.
    expireSessions();
    if (typeof oldSessionId !== 'string' || !oldSessionId) fail('MCP_SESSION_NOT_FOUND', 'MCP session was not found');
    if (sessions.has(oldSessionId)) fail('MCP_SESSION_ACTIVE', 'MCP session is still live; resume is only for dormant snapshots');
    const snapshot = replaySnapshots.get(snapshotKey(oldSessionId));
    if (!snapshot) fail('MCP_SESSION_NOT_FOUND', 'MCP session was not found');
    if (snapshot.closed) fail('MCP_SESSION_CLOSED', 'MCP session was closed and cannot be resumed');
    if (clock() - snapshot.lastActivity > idleSessionMs) {
      replaySnapshots.delete(snapshotKey(oldSessionId));
      persistReplaySnapshots();
      fail('MCP_SESSION_EXPIRED', 'MCP session snapshot is past the idle window');
    }
    const id = randomUUID();
    const session = { id, lastActivity: clock(), requestIds: new Set(), streams: new Set(), eventBuffer: snapshot.events.map((event) => ({ ...event })), nextEventSequence: snapshot.nextEventSequence };
    sessions.set(id, session);
    replaySnapshots.delete(snapshotKey(oldSessionId));
    persistReplaySnapshots();
    return Object.freeze({ sessionId: id, replayedEvents: snapshot.events.length, lastEventId: snapshot.events.length ? snapshot.events[snapshot.events.length - 1].id : null });
  }

  function expireSessions() {
    const now = clock();
    for (const session of [...sessions.values()]) if (now - session.lastActivity > idleSessionMs) closeSession(session.id);
  }

  function closeSession(id, { closed = false } = {}) {
    const session = sessions.get(id);
    if (!session) return;
    // Persist the buffer (or, for a client DELETE, a tombstone) before
    // dropping the live session, so a restart can tell a resumable
    // interruption apart from a deliberately closed session.
    snapshotSession(session, closed);
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
    // Bounded replay protection: the per-session claimed-id set is capped,
    // so the global requestOwners map is bounded by
    // maxSessions * maxRequestIdsPerSession and cannot grow without bound
    // on a long-lived session. Eviction is deliberately NOT used: dropping
    // a still-protected id would silently reopen replay for it.
    if (session.requestIds.size >= maxRequestIdsPerSession) fail('MCP_REQUEST_ID_LIMIT', 'MCP request id limit reached for this session');
    requestOwners.set(id, session.id);
    session.requestIds.add(id);
  }

  // GET SSE replay: resolve the buffered slice strictly after `rawId`.
  // Returns [] when the client is already at the latest event. Throws
  // MCP_EVENT_ID_INVALID for a malformed id and MCP_EVENT_EXPIRED when the
  // id is unknown, already truncated out of the buffer, or ahead of the
  // latest buffered event. Expiry is never papered over with a partial
  // replay: a 410 tells the client its continuity is broken and it must
  // resync (fresh GET without Last-Event-ID, plus tools/list or tools/call
  // if it needs current state). Event ids are scoped to one session, so a
  // lookup here can only ever return this session's own buffered events.
  function resolveReplay(session, rawId) {
    if (typeof rawId !== 'string' || !EVENT_ID_PATTERN.test(rawId)) fail('MCP_EVENT_ID_INVALID', 'MCP Last-Event-ID is invalid');
    const sequence = Number(rawId.slice(4));
    const buffer = session.eventBuffer;
    if (buffer.length === 0) fail('MCP_EVENT_EXPIRED', 'MCP event buffer has no event to resume from');
    const first = buffer[0].sequence;
    const last = buffer[buffer.length - 1].sequence;
    if (sequence < first || sequence > last) fail('MCP_EVENT_EXPIRED', 'MCP Last-Event-ID is expired or unknown');
    return buffer.filter((entry) => entry.sequence > sequence);
  }

  // HTTP routing decision table (MCP 2025-06-18, bridge boundary).
  // Pre-dispatch, in order (first match wins; earlier checks hide later
  // ones, e.g. a missing Bearer never reveals whether a session exists):
  //   wrong endpoint / expired path token -> 404 MCP_ENDPOINT_NOT_FOUND
  //   disallowed Origin                  -> 403 MCP_ORIGIN_FORBIDDEN
  //   missing/wrong Bearer               -> 401 MCP_UNAUTHORIZED
  //   non-POST/GET/DELETE method         -> 405 MCP_METHOD_NOT_ALLOWED
  //   POST without application/json      -> 415 MCP_CONTENT_TYPE_INVALID
  //   GET without text/event-stream      -> 406 MCP_ACCEPT_INVALID
  //   missing/malformed session header   -> 400 MCP_SESSION_REQUIRED
  //   unknown/expired session, or wrong
  //     mcp-protocol-version             -> 404 MCP_SESSION_NOT_FOUND /
  //                                         400 MCP_PROTOCOL_INVALID
  //   GET with malformed Last-Event-ID   -> 400 MCP_EVENT_ID_INVALID
  //   GET with expired/unknown
  //     Last-Event-ID                    -> 410 MCP_EVENT_EXPIRED (JSON,
  //                                         never a partial replay)
  // POST initialize (no session header allowed):
  //   header present                     -> 400 MCP_SESSION_FIXATION
  //   protocolVersion != 2025-06-18      -> 400 MCP_PROTOCOL_INVALID
  //   session table full                 -> 429 MCP_SESSION_LIMIT
  //   otherwise                          -> 200 + new mcp-session-id
  //   claimed request ids per session are capped
  //     (maxRequestIdsPerSession, default 1024) -> 429 MCP_REQUEST_ID_LIMIT
  //   live SSE streams per session are capped
  //     (maxStreamsPerSession, default 16) -> 429 MCP_STREAM_LIMIT
  // POST request (id present; id is claimed before dispatch and is NOT
  // released when dispatch fails, so a retry with the same id is a
  // replay, not a second execution):
  //   id already claimed, any session    -> 409 MCP_REQUEST_REPLAY
  //   notifications/initialized          -> null result, HTTP 200
  //   ping                               -> {} result, HTTP 200
  //   tools/list                         -> catalog, HTTP 200
  //   tools/call, unknown/aliased name
  //     or non-object arguments          -> tool result isError
  //                                         TOOL_INPUT_INVALID, HTTP 200
  //   tools/call, read tool              -> registry mode Ask executes
  //                                         the allowlisted read tool
  //   tools/call, workspace.patch /
  //     workspace.command                -> registry mode Code returns
  //                                         an awaiting_approval proposal
  //                                         ONLY; nothing is applied or
  //                                         executed by the bridge
  //   tools/call, registry failure       -> tool result isError with the
  //                                         registry's safe code, HTTP 200
  //   any other method                   -> JSON-RPC -32601, HTTP 200
  //   POST asking for SSE (Accept is
  //     exactly text/event-stream)       -> single SSE message frame,
  //                                         NOT a resumable stream and
  //                                         NOT added to the replay buffer
  // POST notification (no id):
  //   notifications/initialized          -> 202, no body
  //   anything else                      -> 400 MCP_NOTIFICATION_INVALID
  // GET (live SSE stream):
  //   no Last-Event-ID                   -> live events only, from now on
  //   Last-Event-ID at latest event      -> live events only, from now on
  //   Last-Event-ID inside the buffer    -> buffered events after it, in
  //                                         order, then live events
  //   (live and replayed frames are server notifications only; a POST
  //   response is never broadcast and never buffered)
  // DELETE                               -> close session, 204; the
  //                                         session's buffer and claimed
  //                                         request ids are dropped with it
  //                                         (with replayStorePath, a closed
  //                                         tombstone is persisted instead
  //                                         of the buffer, so resume can
  //                                         never revive it)
  // Persistent replay (replayStorePath only; otherwise buffers stay
  // in-memory and are lost on restart, as before):
  //   broadcast persists the buffer + cursor atomically; stop/expiry
  //     persist the buffer as-is; a restart loads snapshots as DORMANT
  //     only — the old session id still gets 404 SESSION_NOT_FOUND,
  //     exactly like an expired session, and is never silently revived
  //   resumeSession(oldId) (programmatic, not HTTP) seeds a NEW session
  //     id with the persisted buffer, one-shot; it fails for closed
  //     sessions (MCP_SESSION_CLOSED), idle-expired snapshots
  //     (MCP_SESSION_EXPIRED), and unknown ids (MCP_SESSION_NOT_FOUND)
  //   snapshots hold only event content + cursor; session ids appear
  //     only as SHA-256 hashes, and the Bearer <redacted> never persisted
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
        if (session.streams.size >= maxStreamsPerSession) return responseError(response, 429, 'MCP_STREAM_LIMIT');
        const replay = request.headers['last-event-id'] === undefined ? [] : resolveReplay(session, request.headers['last-event-id']);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        response.write(': connected\n\n');
        session.streams.add(response);
        response.once('close', () => session.streams.delete(response));
        try {
          for (const entry of replay) response.write(`id: ${entry.id}\nevent: message\ndata: ${entry.encoded}\n\n`);
        } catch {
          session.streams.delete(response);
          try { response.end(); } catch {}
        }
        return;
      }
      if (request.method === 'DELETE') {
        const session = requireSession(request);
        closeSession(session.id, { closed: true });
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
          const session = { id, lastActivity: clock(), requestIds: new Set(), streams: new Set(), eventBuffer: [], nextEventSequence: 1 };
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
        : code === 'MCP_EVENT_EXPIRED' ? 410
          : code === 'MCP_SESSION_NOT_FOUND' ? 404
            : code === 'MCP_REQUEST_REPLAY' ? 409
              : code === 'MCP_SESSION_LIMIT' || code === 'MCP_REQUEST_ID_LIMIT' || code === 'MCP_STREAM_LIMIT' ? 429
                : ['MCP_ORIGIN_FORBIDDEN'].includes(code) ? 403
                  : ['MCP_JSON_INVALID', 'MCP_JSONRPC_INVALID', 'MCP_PROTOCOL_INVALID', 'MCP_SESSION_REQUIRED', 'MCP_SESSION_FIXATION', 'MCP_NOTIFICATION_INVALID', 'MCP_EVENT_ID_INVALID'].includes(code) ? 400
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

  function broadcast(sessionId, notification) {
    // Same expiry rule as the HTTP path (requireSession): broadcasting
    // to an idle-expired session must fail, not silently refresh its
    // lastActivity and resurrect it. A live broadcast still refreshes
    // lastActivity, as before. As in resumeSession, expireSessions()
    // reuses the HTTP path's full-session scan; this call adds scan
    // frequency, it is not a target-only or O(1) check.
    expireSessions();
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) fail('MCP_SESSION_NOT_FOUND', 'MCP session was not found');
    if (!plainObject(notification) || typeof notification.method !== 'string' || !notification.method || notification.method.length > 128 || /[\0\r\n]/.test(notification.method) || (notification.params !== undefined && !plainObject(notification.params))) fail('MCP_NOTIFICATION_INVALID', 'MCP broadcast notification is invalid');
    const session = sessions.get(sessionId);
    const encoded = boundedJson({ jsonrpc: '2.0', method: notification.method, params: notification.params ?? {} }, maxResponseBytes, 'MCP_RESPONSE_LIMIT');
    // Buffer first, deliver second: an event broadcast while no stream is
    // open is still replayable until it is truncated out of the bounded
    // per-session buffer, the session expires, or the session closes.
    // Broadcast is the ONLY source of buffered events; tool execution
    // never auto-generates one, and a POST response is never buffered.
    const eventId = `evt-${session.nextEventSequence}`;
    session.eventBuffer.push({ id: eventId, sequence: session.nextEventSequence, encoded });
    session.nextEventSequence += 1;
    while (session.eventBuffer.length > maxReplayEvents) session.eventBuffer.shift();
    let delivered = 0;
    for (const response of [...session.streams]) {
      try { response.write(`id: ${eventId}\nevent: message\ndata: ${encoded}\n\n`); delivered += 1; }
      catch { session.streams.delete(response); }
    }
    session.lastActivity = clock();
    snapshotSession(session, false);
    return Object.freeze({ sessionId, delivered, eventId });
  }

  return Object.freeze({ start, stop, address, endpointPath: () => endpoint, protocolVersion: PROTOCOL_VERSION, broadcast, resumeSession, replaySnapshotCount: () => replaySnapshots.size, sessionCount: () => sessions.size, streamCount: (sessionId) => sessions.get(sessionId)?.streams.size ?? 0 });
}
