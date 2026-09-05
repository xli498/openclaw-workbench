import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const SHELL_PATTERN = /[;&|<>`$()\r\n]/;
const SECRET_PATTERN = /(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]|:\/\/[^/\s:]+:[^@\s]+@/i;
const SECRET_FLAG_PATTERN = /(?:^|\s)(?:--?|\/)(?:token|password|secret|api[-_ ]?key)(?:\s|=|$)/i;

export class McpTransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpTransportError';
    this.code = code;
    this.details = details;
  }
}

function validateString(value, code, label, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) throw new McpTransportError(code, `${label} is invalid`);
  return value;
}

function validateExecutablePart(value, code, label) {
  validateString(value, code, label);
  if (SHELL_PATTERN.test(value) || SECRET_PATTERN.test(value) || SECRET_FLAG_PATTERN.test(value)) {
    throw new McpTransportError(code, `${label} contains unsafe shell or credential material`);
  }
}

function validateOptions({ command, args = [], requestTimeoutMs, maxFrameBytes }) {
  validateExecutablePart(command, 'MCP_COMMAND_INVALID', 'command');
  if (!Array.isArray(args) || args.length > 64) throw new McpTransportError('MCP_ARGS_INVALID', 'args are invalid');
  for (const arg of args) validateExecutablePart(arg, 'MCP_ARGS_INVALID', 'arg');
  for (const [name, value] of [['requestTimeoutMs', requestTimeoutMs], ['maxFrameBytes', maxFrameBytes]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new McpTransportError('MCP_CONFIG_INVALID', `${name} must be a positive safe integer`);
  }
}

export function createMcpStdioTransport({
  command,
  args = [],
  cwd,
  env = {},
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  spawnImpl = spawn,
} = {}) {
  validateOptions({ command, args, requestTimeoutMs, maxFrameBytes });
  if (cwd !== undefined) validateString(cwd, 'MCP_CWD_INVALID', 'cwd', 2048);
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof value !== 'string' || value.includes('\0')))) throw new McpTransportError('MCP_ENV_INVALID', 'env must contain named string values');
  if (typeof spawnImpl !== 'function') throw new McpTransportError('MCP_SPAWN_INVALID', 'spawn implementation is unavailable');

  let child = null;
  let state = 'disconnected';
  let startPromise = null;
  let lifecycleGeneration = 0;
  let inputBuffer = '';
  let stdoutDecoder = new StringDecoder('utf8');
  const pending = new Map();

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.reject(error);
    }
    pending.clear();
  }

  function terminate(error, nextState = 'failed') {
    state = nextState;
    rejectPending(error);
    const current = child;
    child = null;
    try { current?.kill?.(); } catch { /* process may already be gone */ }
  }

  function handleStdout(data) {
    inputBuffer += stdoutDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8'));
    let newline;
    while ((newline = inputBuffer.indexOf('\n')) >= 0) {
      const line = inputBuffer.slice(0, newline).replace(/\r$/, '');
      inputBuffer = inputBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        terminate(new McpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit'));
        return;
      }
      let frame;
      try { frame = JSON.parse(line); } catch { terminate(new McpTransportError('MCP_FRAME_INVALID', 'MCP frame is not valid JSON')); return; }
      if (!frame || typeof frame !== 'object' || (typeof frame.id !== 'string' && typeof frame.id !== 'number')) continue;
      const entry = pending.get(String(frame.id));
      if (!entry) continue;
      pending.delete(String(frame.id));
      clearTimeout(entry.timer);
      entry.cleanup?.();
      if (frame.error) entry.reject(new McpTransportError('MCP_REMOTE_ERROR', 'MCP server returned an error response'));
      else entry.resolve(frame.result);
    }
    if (Buffer.byteLength(inputBuffer, 'utf8') > maxFrameBytes) terminate(new McpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit'));
  }

  function handleClose(processRef) {
    if (state === 'disconnected' || child !== processRef) return;
    child = null;
    state = 'disconnected';
    rejectPending(new McpTransportError('MCP_PROCESS_CLOSED', 'MCP server process closed'));
  }

  async function start() {
    if (state === 'ready') return Object.freeze({ status: 'ready' });
    if (startPromise) return startPromise;
    const generation = ++lifecycleGeneration;
    state = 'starting';
    startPromise = Promise.resolve().then(() => {
      if (generation !== lifecycleGeneration || state !== 'starting') throw new McpTransportError('MCP_TRANSPORT_CLOSED', 'MCP transport was closed');
      inputBuffer = '';
      stdoutDecoder = new StringDecoder('utf8');
      try {
        child = spawnImpl(command, [...args], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch { state = 'failed'; throw new McpTransportError('MCP_START_FAILED', 'MCP server process could not be started'); }
      const processRef = child;
      child.stdout?.on?.('data', (data) => { if (child === processRef) handleStdout(data); });
      child.stderr?.on?.('data', () => {});
      child.stdin?.on?.('error', () => { if (child === processRef && state !== 'disconnected') terminate(new McpTransportError('MCP_STDIN_ERROR', 'MCP server stdin failed')); });
      child.on?.('error', () => {
        if (child === processRef && state !== 'disconnected') terminate(new McpTransportError(state === 'starting' ? 'MCP_START_FAILED' : 'MCP_PROCESS_ERROR', 'MCP server process failed'));
      });
      child.on?.('close', () => handleClose(processRef));
      if (generation !== lifecycleGeneration || state !== 'starting') {
        child = null;
        try { processRef.stdin?.end?.(); } catch { /* stdin may already be closed */ }
        try { processRef.kill?.(); } catch { /* process may already be gone */ }
        throw new McpTransportError('MCP_TRANSPORT_CLOSED', 'MCP transport was closed');
      }
      state = 'ready';
      return Object.freeze({ status: 'ready' });
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  function request(method, params = {}, { signal } = {}) {
    if (state !== 'ready' || !child) return Promise.reject(new McpTransportError('MCP_NOT_STARTED', 'MCP transport is not started'));
    validateString(method, 'MCP_METHOD_INVALID', 'method', 256);
    const id = randomUUID();
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (Buffer.byteLength(payload, 'utf8') > maxFrameBytes) return Promise.reject(new McpTransportError('MCP_FRAME_LIMIT', 'MCP frame exceeded the configured limit'));
    return new Promise((resolve, reject) => {
      const key = String(id);
      const abort = () => {
        pending.delete(key);
        clearTimeout(timer);
        reject(new McpTransportError('MCP_REQUEST_ABORTED', 'MCP request was cancelled'));
      };
      const timer = setTimeout(() => {
        pending.delete(key);
        signal?.removeEventListener('abort', abort);
        reject(new McpTransportError('MCP_REQUEST_TIMEOUT', 'MCP request timed out'));
      }, requestTimeoutMs);
      pending.set(key, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) });
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      try { child.stdin.write(`${payload}\n`); }
      catch { pending.delete(key); clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new McpTransportError('MCP_SEND_FAILED', 'MCP request could not be sent')); }
    });
  }

  async function close() {
    lifecycleGeneration += 1;
    const current = child;
    child = null;
    state = 'disconnected';
    rejectPending(new McpTransportError('MCP_TRANSPORT_CLOSED', 'MCP transport was closed'));
    try { current?.stdin?.end?.(); } catch { /* stdin may already be closed */ }
    try { current?.kill?.(); } catch { /* process may already be gone */ }
  }

  return Object.freeze({ start, request, close, getState: () => state });
}
