import { spawn } from 'node:child_process';
import path from 'node:path';

// First LSP slice: a read-only, workspace-bounded stdio client. It is NOT a
// full language-server integration. Only the methods below are ever sent;
// anything that could mutate a file, run a command, or install anything on
// the host is refused before it reaches the server process. The server is
// started with shell:false, a workspace cwd, and an explicitly allowlisted
// environment (names only in the public record; values are never logged,
// never stored in snapshots, and never included in error text).
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const SHELL_PATTERN = /[;&|<>`$()\r\n]/;
const SECRET_PATTERN = /(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]|:\/\/[^/\s:]+:[^@\s]+@/i;
const SECRET_FLAG_PATTERN = /(?:^|\s)(?:--?|\/)(?:token|password|secret|api[-_ ]?key)(?:\s|=|$)/i;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const LSP_READ_ONLY_METHODS = Object.freeze([
  'initialize',
  'shutdown',
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/references',
  'textDocument/documentSymbol',
  'textDocument/completion',
  'workspace/symbol',
]);

export class LspClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LspClientError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message) { throw new LspClientError(code, message); }

function safeCommand(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n]/.test(value)) fail('LSP_COMMAND_INVALID', 'LSP server command is invalid');
  if (SHELL_PATTERN.test(value) || SECRET_PATTERN.test(value) || SECRET_FLAG_PATTERN.test(value)) fail('LSP_COMMAND_INVALID', 'LSP server command contains unsafe shell or credential material');
  return value;
}

function safeArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail('LSP_ARGS_INVALID', 'LSP args must be an array of at most 64 strings');
  return value.map((item) => {
    if (typeof item !== 'string' || !item || item.length > 512 || /[\0\r\n]/.test(item)) fail('LSP_ARGS_INVALID', 'LSP arg is invalid');
    if (SHELL_PATTERN.test(item) || SECRET_PATTERN.test(item) || SECRET_FLAG_PATTERN.test(item)) fail('LSP_ARGS_INVALID', 'LSP arg contains unsafe shell or credential material');
    return item;
  });
}

function safeEnv(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LSP_ENV_INVALID', 'LSP env must be an object');
  const entries = Object.entries(value);
  if (entries.length > 128) fail('LSP_ENV_INVALID', 'LSP env has too many entries');
  const env = {};
  for (const [key, val] of entries) {
    if (!ENV_PATTERN.test(key) || typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)) fail('LSP_ENV_INVALID', 'LSP env entry is invalid');
    env[key] = val;
  }
  return env;
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export function createLspClient({
  command,
  args,
  root,
  env,
  allowedMethods = LSP_READ_ONLY_METHODS,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  onNotification,
  onServerRequest,
} = {}) {
  const serverCommand = safeCommand(command);
  const serverArgs = safeArgs(args);
  if (typeof root !== 'string' || !root) fail('LSP_ROOT_INVALID', 'LSP workspace root is required');
  const rootPath = path.resolve(root);
  const serverEnv = safeEnv(env);
  if (!Array.isArray(allowedMethods) || allowedMethods.length === 0 || allowedMethods.some((m) => typeof m !== 'string')) fail('LSP_METHODS_INVALID', 'LSP allowed methods are invalid');
  const allowed = new Set(allowedMethods);
  for (const [name, value] of [['requestTimeoutMs', requestTimeoutMs], ['maxFrameBytes', maxFrameBytes]]) if (!Number.isSafeInteger(value) || value < 1) fail('LSP_CONFIG_INVALID', `${name} must be a positive safe integer`);
  if (onNotification !== undefined && typeof onNotification !== 'function') fail('LSP_CALLBACK_INVALID', 'onNotification must be a function');
  if (onServerRequest !== undefined && typeof onServerRequest !== 'function') fail('LSP_CALLBACK_INVALID', 'onServerRequest must be a function');

  let child = null;
  let state = 'disconnected';
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  let initialized = false;
  let closing = false;

  function send(value) {
    if (!child || child.stdin.destroyed) fail('LSP_NOT_STARTED', 'LSP server is not started');
    child.stdin.write(encodeFrame(value));
  }

  function sendResponse(id, result, error) {
    try { send(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: result ?? null }); } catch {}
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const entry = pending.get(String(frame.id));
      if (!entry) return;
      pending.delete(String(frame.id));
      clearTimeout(entry.timer);
      if (frame.error) entry.reject(new LspClientError('LSP_REMOTE_ERROR', 'LSP server returned an error response'));
      else entry.resolve(frame.result);
      return;
    }
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      // Server-initiated requests are never auto-executed. An explicit
      // caller handler may answer with data it already holds; otherwise the
      // client answers with "method not found" so the server cannot drive
      // the host through this client.
      if (onServerRequest) {
        Promise.resolve().then(() => onServerRequest(frame)).then((result) => sendResponse(frame.id, result ?? null)).catch(() => sendResponse(frame.id, null, { code: -32603, message: 'Internal error' }));
      } else {
        sendResponse(frame.id, null, { code: -32601, message: 'Method not found' });
      }
      return;
    }
    if (typeof frame.method === 'string') onNotification?.(frame);
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > 64 * 1024) failFrame(new LspClientError('LSP_FRAME_LIMIT', 'LSP header exceeded the configured limit'));
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxFrameBytes) { failFrame(new LspClientError('LSP_FRAME_LIMIT', 'LSP frame exceeded the configured limit')); return; }
      if (buffer.length < headerEnd + 4 + length) return;
      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      buffer = buffer.subarray(headerEnd + 4 + length);
      let frame;
      try { frame = JSON.parse(body); } catch { continue; }
      handleFrame(frame);
    }
  }

  function failFrame(error) {
    buffer = Buffer.alloc(0);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    state = 'failed';
  }

  function onExit() {
    if (closing) return;
    state = 'failed';
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new LspClientError('LSP_SERVER_EXITED', 'LSP server exited unexpectedly')); }
    pending.clear();
  }

  async function start() {
    if (state === 'ready') return Object.freeze({ status: 'ready' });
    child = spawn(serverCommand, serverArgs, { cwd: rootPath, shell: false, env: { ...process.env, ...serverEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onExit);
    state = 'starting';
    try {
      const initializeResult = await request('initialize', {
        processId: null,
        rootUri: `file://${rootPath}`,
        capabilities: {},
        workspaceFolders: [{ uri: `file://${rootPath}`, name: path.basename(rootPath) || 'workspace' }],
      });
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      initialized = true;
      state = 'ready';
      return Object.freeze({ status: 'ready', capabilities: initializeResult?.capabilities ?? null });
    } catch (error) {
      await close().catch(() => {});
      state = 'failed';
      throw error;
    }
  }

  async function request(method, params = {}) {
    if (!allowed.has(method)) fail('LSP_METHOD_NOT_ALLOWED', 'LSP method is not in the read-only allowlist');
    if (method === 'initialize' && state !== 'starting') fail('LSP_STATE_INVALID', 'initialize is only valid during start');
    if (method !== 'initialize' && state !== 'ready' && !(method === 'shutdown' && initialized)) fail('LSP_NOT_STARTED', 'LSP client is not started');
    if (typeof params !== 'object' || params === null || Array.isArray(params)) fail('LSP_PARAMS_INVALID', 'LSP params must be an object');
    const id = nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) fail('LSP_FRAME_LIMIT', 'LSP frame exceeded the configured limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(String(id)); reject(new LspClientError('LSP_REQUEST_TIMEOUT', 'LSP request timed out')); }, requestTimeoutMs);
      pending.set(String(id), { resolve, reject, timer });
      try { send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(String(id)); reject(error); }
    });
  }

  async function shutdown() {
    if (state !== 'ready' && !initialized) return Object.freeze({ status: 'not-started' });
    try { await request('shutdown', {}); } catch {}
    send({ jsonrpc: '2.0', method: 'exit' });
    await close();
    return Object.freeze({ status: 'closed' });
  }

  async function close() {
    closing = true;
    const current = child;
    child = null;
    state = 'disconnected';
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new LspClientError('LSP_CLOSED', 'LSP client was closed')); }
    pending.clear();
    if (current && !current.killed) {
      current.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { current.kill('SIGKILL'); } catch {} resolve(); }, 2000);
        current.once('exit', () => { clearTimeout(timer); resolve(); });
      }).catch(() => {});
    }
  }

  return Object.freeze({
    start, request, shutdown, close,
    getState: () => state,
    getRoot: () => rootPath,
    getAllowedMethods: () => Object.freeze([...allowed]),
  });
}
