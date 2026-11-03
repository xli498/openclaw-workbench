import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const SECRET_PATH_BYTES = 18;
const PROVIDERS = new Set(['cloudflare-quick', 'cloudflare-named', 'ngrok', 'ngrok-fixed']);
const STATES = new Set(['idle', 'starting', 'ready', 'stopping', 'failed']);
const SAFE_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const SAFE_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

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
function validTunnelName(value) {
  if (value === undefined) fail('TUNNEL_NAME_REQUIRED', 'named tunnel name is required');
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) fail('TUNNEL_NAME_INVALID', 'named tunnel name is invalid');
  return value;
}
function validHostname(value) {
  if (value === undefined) fail('TUNNEL_HOSTNAME_REQUIRED', 'fixed tunnel hostname is required');
  if (typeof value !== 'string' || !SAFE_HOSTNAME.test(value)) fail('TUNNEL_HOSTNAME_INVALID', 'fixed tunnel hostname is invalid');
  return value.toLowerCase();
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
  tunnelName,
  hostname,
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
  const namedTunnel = provider === 'cloudflare-named' ? validTunnelName(tunnelName) : undefined;
  const fixedHostname = provider === 'ngrok-fixed' ? validHostname(hostname) : undefined;
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
  let stopPromise = null;
  let resetPromise = null;
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
    const target = `http://127.0.0.1:${localPort}/${routePath}`;
    if (provider === 'cloudflare-named') return ['tunnel', 'run', namedTunnel, ...args];
    if (provider === 'ngrok-fixed') return ['http', '--domain', fixedHostname, `127.0.0.1:${localPort}`, ...args];
    if (provider === 'ngrok') return ['http', `127.0.0.1:${localPort}`, ...args];
    return [...args, '--url', target];
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
          const candidate = new URL(parsed);
          if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.search || candidate.hash || (fixedHostname && candidate.hostname.toLowerCase() !== fixedHostname)) continue;
          publicUrl = candidate.origin;
          urlWaiter?.resolve(publicUrl);
          urlWaiter = null;
        }
      } catch { /* parser input is untrusted */ }
    }
  }
  function waitForUrl(timeoutMs, expectedGeneration) {
    return new Promise((resolve, reject) => {
      if (publicUrl) return resolve(publicUrl);
      const timer = setTimeout(() => { urlWaiter = null; reject(new BridgeTunnelError('TUNNEL_URL_TIMEOUT', 'tunnel URL was not reported')); }, timeoutMs);
      urlWaiter = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); }, generation: expectedGeneration };
    });
  }
  async function stopProcess() {
    const current = child;
    if (!current) return;
    // Already exited (real child processes report exitCode); drop the
    // handle without waiting on an exit event that will never re-fire.
    if (current.exitCode !== null && current.exitCode !== undefined) { child = null; return; }
    await new Promise((resolve, reject) => {
      let settled = false;
      const clearCurrent = () => { if (child === current) child = null; };
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); clearCurrent(); resolve(); } };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Timeout is a failure, not a completed stop: keep the handle so
        // a later stop() can retry the kill, and drop it only if the
        // process exits on its own afterwards.
        current.once?.('exit', clearCurrent);
        current.once?.('close', clearCurrent);
        reject(new BridgeTunnelError('TUNNEL_STOP_TIMEOUT', 'tunnel process did not exit within the stop timeout'));
      }, stopTimeoutMs);
      current.once?.('exit', done);
      current.once?.('close', done);
      try { current.kill?.(); }
      catch (error) {
        if (!settled) { settled = true; clearTimeout(timer); reject(genericError(error)); }
      }
    });
  }
  async function start() {
    if (state === 'ready') return Object.freeze({ ...publicState(), endpoint: publicUrl ? `${publicUrl}/${routePath}` : null });
    // Busy is decided BEFORE any promise is stored: a busy rejection
    // must never linger in startPromise and poison later starts. A
    // reset in flight also holds the lifecycle busy for its whole
    // duration, including the stop-completion to route-rotation window.
    if (state === 'starting' || state === 'stopping' || stopPromise || startPromise || resetPromise) fail('TUNNEL_BUSY', 'tunnel lifecycle is busy');
    startPromise = (async () => {
      try {
        // A previous stop that timed out leaves its child handle behind
        // for a retry; never start a second process over it.
        if (child) fail('TUNNEL_BUSY', 'previous tunnel process has not exited');
        publicUrl = null;
        outputBuffer = '';
        routePath = randomSecretPath();
        const thisGeneration = ++generation;
        setState('starting');
        child = spawnImpl(command, currentArgs(), {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', OCW_BRIDGE_BEARER: token },
        });
        const startedChild = child;
        child.stdout?.on?.('data', consumeOutput);
        child.stderr?.on?.('data', consumeOutput);
        child.once?.('error', (error) => { if (thisGeneration === generation) { lastError = genericError(error); setState('failed', error); } });
        // Continuous monitoring after ready: an unexpected exit withdraws
        // the endpoint and fails the adapter instead of leaving a stale
        // ready state. An exit while starting fails fast instead of
        // waiting out the full URL timeout.
        child.once?.('exit', () => {
          if (thisGeneration !== generation) return;
          if (state === 'ready') {
            if (child === startedChild) child = null;
            publicUrl = null;
            setState('failed', new BridgeTunnelError('TUNNEL_PROCESS_EXITED', 'tunnel process exited unexpectedly'));
          } else if (state === 'starting') {
            urlWaiter?.reject(new BridgeTunnelError('TUNNEL_PROCESS_FAILED', 'tunnel process exited before reporting a URL'));
            urlWaiter = null;
          }
        });
        await waitForUrl(startTimeoutMs, thisGeneration);
        if (thisGeneration !== generation || !child) fail('TUNNEL_RESET', 'tunnel was reset');
        startedAt = new Date(clock()).toISOString();
        setState('ready');
        return Object.freeze({ ...publicState(), endpoint: `${publicUrl}/${routePath}` });
      } catch (error) {
        try { await stopProcess(); }
        catch (stopError) { publicUrl = null; setState('failed', stopError); throw genericError(stopError); }
        publicUrl = null;
        setState('failed', error);
        throw genericError(error);
      } finally { startPromise = null; }
    })();
    return startPromise;
  }
  async function stop() {
    if (stopPromise) return stopPromise;
    // Idle fast path BEFORE any promise is stored: the IIFE below runs
    // synchronously up to its first await, so an idle shortcut inside it
    // would complete (and run its finally clearing stopPromise) before
    // the outer assignment, leaving the already-resolved promise stored
    // forever and every later start() reporting TUNNEL_BUSY. Handling
    // the idle case here, without creating a promise, removes that
    // ordering hazard entirely. The remaining IIFE paths always hit an
    // await before completing, so their finally clears correctly.
    if (state === 'idle' && !child) {
      ++generation;
      urlWaiter?.reject(new BridgeTunnelError('TUNNEL_RESET', 'tunnel was reset'));
      urlWaiter = null;
      return publicState();
    }
    stopPromise = (async () => {
      try {
        ++generation;
        urlWaiter?.reject(new BridgeTunnelError('TUNNEL_RESET', 'tunnel was reset'));
        urlWaiter = null;
        // Serialize with an in-flight start: stop runs synchronously
        // into 'stopping' first, so a concurrent start() sees busy
        // instead of racing the start's failure handling.
        const pendingStart = startPromise;
        if (pendingStart) {
          setState('stopping');
          try { await pendingStart; } catch { /* a stop-induced start failure is expected */ }
        }
        if (state === 'idle' && !child) return publicState();
        setState('stopping');
        await stopProcess();
        publicUrl = null;
        startedAt = null;
        setState('idle');
        return publicState();
      } catch (error) {
        setState('failed', error);
        throw genericError(error);
      } finally { stopPromise = null; }
    })();
    return stopPromise;
  }
  async function reset() {
    if (resetPromise) return resetPromise;
    // Reset holds busy for its whole duration: without resetPromise, a
    // start continuation queued ahead of reset's post-stop continuation
    // could spawn with the old routePath before reset rotates it,
    // leaving the spawned tunnel and the reported endpoint on different
    // routes. start() checks resetPromise, so such a start is rejected
    // with TUNNEL_BUSY instead. Concurrent reset() calls share the one
    // in-flight reset, mirroring stop().
    resetPromise = (async () => {
      try {
        await stop();
        routePath = randomSecretPath();
        return publicState();
      } finally { resetPromise = null; }
    })();
    return resetPromise;
  }
  return Object.freeze({ start, stop, reset, status: publicState, provider, authHeaders: () => Object.freeze({ authorization: `Bearer ${token}` }), endpoint: () => publicUrl ? `${publicUrl}/${routePath}` : null });
}

export const BRIDGE_TUNNEL_PROVIDERS = Object.freeze([...PROVIDERS]);
