import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const SECRET_PATH_BYTES = 18;
const PROVIDERS = new Set(['cloudflare-quick', 'ngrok']);
const STATES = new Set(['idle', 'starting', 'ready', 'stopping', 'failed']);
const SAFE_NAME = /^[a-z][a-z0-9-]{1,31}$/;

export class BridgeTunnelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeTunnelError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new BridgeTunnelError(code, message, details); }
function validPositive(value, label, maximum = 120_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('TUNNEL_CONFIG_INVALID', `${label} is invalid`);
  return value;
}
function validCommand(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\0\r\n;&|<>`$()]/.test(value)) fail('TUNNEL_COMMAND_INVALID', 'tunnel command is invalid');
  return value;
}
function validArg(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\0\r\n]/.test(value)) fail('TUNNEL_ARGS_INVALID', 'tunnel argument is invalid');
  return value;
}
function randomSecretPath() { return randomBytes(SECRET_PATH_BYTES).toString('base64url'); }
function genericError(error) { return error instanceof BridgeTunnelError ? error : new BridgeTunnelError('TUNNEL_PROCESS_FAILED', 'tunnel process failed'); }

/**
 * Controls an explicitly injected tunnel CLI. It never starts a tunnel until
 * start() is called, never uses a shell, and never exposes the public URL.
 * The injected parser receives stdout lines and may return a URL; that URL is
 * retained only in memory for the caller's connector and is absent from all
 * public state and callbacks.
 */
export function createBridgeTunnelAdapter({
  provider,
  command,
  args = [],
  localPort,
  token,
  spawnImpl = spawn,
  clock = () => Date.now(),
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  parsePublicUrl,
  onStateChange,
} = {}) {
  if (!PROVIDERS.has(provider)) fail('TUNNEL_PROVIDER_INVALID', 'unsupported tunnel provider');
  validCommand(command);
  if (!Array.isArray(args) || args.length > 32) fail('TUNNEL_ARGS_INVALID', 'tunnel arguments are invalid');
  args.forEach(validArg);
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) fail('TUNNEL_PORT_INVALID', 'local port is invalid');
  if (typeof token !== 'string' || token.length < 16 || /[\0\r\n]/.test(token)) fail('TUNNEL_AUTH_INVALID', 'tunnel bearer token is invalid');
  if (typeof spawnImpl !== 'function') fail('TUNNEL_SPAWN_INVALID', 'spawn implementation is unavailable');
  if (typeof parsePublicUrl !== 'function') fail('TUNNEL_URL_PARSER_REQUIRED', 'public URL parser is required');
  validPositive(startTimeoutMs, 'startTimeoutMs');
  validPositive(stopTimeoutMs, 'stopTimeoutMs', 30_000);
  if (onStateChange !== undefined && typeof onStateChange !== 'function') fail('TUNNEL_CALLBACK_INVALID', 'onStateChange is invalid');

  let state = 'idle';
  let child = null;
  let publicUrl = null;
  let routePath = randomSecretPath();
  let generation = 0;
  let startedAt = null;
  let lastError = null;
  let outputBuffer = '';
  let startPromise = null;
  let urlWaiter = null;

  function publicState() {
    return Object.freeze({ provider, state, localPort, routePathConfigured: Boolean(routePath), startedAt, lastError: lastError?.code ?? null });
  }
  function emit() { try { onStateChange?.(publicState()); } catch { /* observer failures do not control lifecycle */ } }
  function setState(next, error) {
    if (!STATES.has(next)) fail('TUNNEL_STATE_INVALID', 'tunnel state is invalid');
    state = next;
    lastError = error ? genericError(error) : null;
    emit();
  }
  function currentArgs() {
    // The bearer is passed as an environment variable, never in argv or URL.
    return [...args, '--url', `http://127.0.0.1:${localPort}/${routePath}`];
  }
  function consumeOutput(data) {
    outputBuffer += Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
    if (outputBuffer.length > 128 * 1024) outputBuffer = outputBuffer.slice(-64 * 1024);
    let index;
    while ((index = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, index).replace(/\r$/, '');
      outputBuffer = outputBuffer.slice(index + 1);
      try {
        const parsed = parsePublicUrl(line);
        if (typeof parsed === 'string' && /^https:\/\//.test(parsed) && parsed.length <= 2048) {
          publicUrl = parsed;
          urlWaiter?.resolve(parsed);
          urlWaiter = null;
        }
      } catch { /* parser input is untrusted */ }
    }
  }
  function waitForUrl(timeoutMs, expectedGeneration) {
    return new Promise((resolve, reject) => {
      if (publicUrl) return resolve(publicUrl);
      const timer = setTimeout(() => { urlWaiter = null; reject(new BridgeTunnelError('TUNNEL_URL_TIMEOUT', 'tunnel URL was not reported')); }, timeoutMs);
      timer.unref?.();
      urlWaiter = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); }, generation: expectedGeneration };
    });
  }
  async function stopProcess() {
    const current = child;
    child = null;
    if (!current) return;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(done, stopTimeoutMs);
      current.once?.('exit', done);
      current.once?.('close', done);
      try { current.kill?.(); } catch { done(); }
    });
  }
  async function start() {
    if (state === 'ready') return Object.freeze({ ...publicState(), endpoint: publicUrl ? `${publicUrl}/${routePath}` : null });
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (state === 'starting' || state === 'stopping') fail('TUNNEL_BUSY', 'tunnel lifecycle is busy');
      publicUrl = null;
      outputBuffer = '';
      routePath = randomSecretPath();
      const thisGeneration = ++generation;
      setState('starting');
      try {
        child = spawnImpl(command, currentArgs(), {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', OCW_BRIDGE_BEARER: token },
        });
        child.stdout?.on?.('data', consumeOutput);
        child.stderr?.on?.('data', consumeOutput);
        child.once?.('error', (error) => { if (thisGeneration === generation) { lastError = genericError(error); setState('failed', error); } });
        await waitForUrl(startTimeoutMs, thisGeneration);
        if (thisGeneration !== generation || !child) fail('TUNNEL_RESET', 'tunnel was reset');
        startedAt = new Date(clock()).toISOString();
        setState('ready');
        return Object.freeze({ ...publicState(), endpoint: `${publicUrl}/${routePath}` });
      } catch (error) {
        await stopProcess();
        publicUrl = null;
        setState('failed', error);
        throw genericError(error);
      } finally { startPromise = null; }
    })();
    return startPromise;
  }
  async function stop() {
    ++generation;
    urlWaiter?.reject(new BridgeTunnelError('TUNNEL_RESET', 'tunnel was reset'));
    urlWaiter = null;
    if (state === 'idle') return publicState();
    setState('stopping');
    await stopProcess();
    publicUrl = null;
    startedAt = null;
    setState('idle');
    return publicState();
  }
  async function reset() {
    await stop();
    routePath = randomSecretPath();
    return publicState();
  }
  return Object.freeze({ start, stop, reset, status: publicState, provider, authHeaders: () => Object.freeze({ authorization: `Bearer ${token}` }), endpoint: () => publicUrl ? `${publicUrl}/${routePath}` : null });
}

export const BRIDGE_TUNNEL_PROVIDERS = Object.freeze([...PROVIDERS]);
