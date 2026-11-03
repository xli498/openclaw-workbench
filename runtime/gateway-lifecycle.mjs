import { spawn } from 'node:child_process';

// Gateway lifecycle probe, not a Gateway implementation.
//
// Empirical state in this repo (2026-11-01): the OpenClaw CLI is not
// installed in the development or CI environments, and no stable,
// version-locked channel protocol has been verified against a real
// Gateway (docs/01-integration-boundary.md lists Gateway WebSocket,
// device pairing, and scope upgrade as unchecked items). This module
// therefore refuses to guess or hard-code any OpenClaw private protocol:
//
// - probe() only runs `<cli> --version` with shell:false, a timeout, and
//   a bounded, redacted first line. Missing CLI -> CLI_NOT_FOUND; an
//   internal probe timeout -> GATEWAY_PROBE_TIMEOUT; probe output over
//   the limit -> GATEWAY_PROBE_LIMIT; any other probe failure ->
//   GATEWAY_PROBE_FAILED. The four codes are deliberately distinct so
//   callers can tell "no CLI installed" apart from "probe itself
//   timed out / was capped / failed internally".
// - start() without an explicit, caller-injected channelAdapter throws
//   GATEWAY_LIFECYCLE_NOT_IMPLEMENTED. A caller that has independently
//   verified a channel adapter may inject it; the injection, not this
//   module, owns the protocol. Until such an adapter is verified in a
//   controlled environment, channel/Gateway lifecycle stays unclosed.
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const SECRET_VALUE_PATTERN = /(?:bearer\s+[^\s]+|(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+|:\/\/[^/\s:]+:[^@\s]+@)/gi;

export class GatewayLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GatewayLifecycleError';
    this.code = code;
    this.details = details;
  }
}

// Redact BEFORE taking the first line and truncating. Truncating
// first would cut a credential pattern at the truncation point (e.g.
// the '@' of a URL userinfo falling past the cut), so the pattern
// would no longer match and the credential fragment before the cut
// would leak. Redaction first guarantees no credential material
// survives regardless of where the cut lands.
function redactVersion(value) {
  return String(value ?? '').replace(SECRET_VALUE_PATTERN, '[redacted]').split('\n')[0].slice(0, 256);
}

function defaultSpawn({ command, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Node docs (child_process, "Spawning .bat and .cmd files on
      // Windows"): .bat/.cmd files are not executable on their own and
      // cannot be launched with spawn() and shell:false. They must be
      // run through cmd.exe explicitly (what shell:true/exec() do under
      // the hood). This branch keeps shell:false -- cmd.exe itself is a
      // real executable -- and only applies on Windows to .cmd/.bat
      // commands; every other command spawns exactly as before. The
      // constructor already rejects cmd metacharacters in the command,
      // so the path cannot smuggle extra cmd syntax through /c.
      const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
      child = isBatch
        ? spawn('cmd.exe', ['/d', '/c', command, '--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
        : spawn(command, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) { reject(error); return; }
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(Object.assign(new Error('probe timed out'), { code: 'GATEWAY_PROBE_TIMEOUT' }));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) {
        if (!settled) { settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} reject(Object.assign(new Error('probe output too large'), { code: 'GATEWAY_PROBE_LIMIT' })); }
      }
    });
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: output });
    });
  });
}

export function createGatewayLifecycle({
  cliCommand = 'openclaw',
  spawnFn,
  channelAdapter,
  probeTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (typeof cliCommand !== 'string' || !cliCommand || /[\0\r\n]/.test(cliCommand) || /[;&|<>`$()]/.test(cliCommand)) throw new GatewayLifecycleError('GATEWAY_CLI_INVALID', 'Gateway CLI command is invalid');
  if (spawnFn !== undefined && typeof spawnFn !== 'function') throw new GatewayLifecycleError('GATEWAY_SPAWN_INVALID', 'Gateway spawn function is invalid');
  // An injected adapter must provide BOTH start() and stop(). Checking
  // only start() used to let a stop-less adapter through, after which
  // stop() silently reported { status: 'stopped' } without stopping
  // anything. A null adapter is a config error, not a TypeError: it
  // must fail here with GATEWAY_ADAPTER_INVALID instead of throwing
  // when .start is read off null below.
  if (channelAdapter !== undefined && (channelAdapter === null || typeof channelAdapter !== 'object' || typeof channelAdapter.start !== 'function' || typeof channelAdapter.stop !== 'function')) throw new GatewayLifecycleError('GATEWAY_ADAPTER_INVALID', 'Gateway channel adapter must provide start() and stop()');
  for (const [name, value] of [['probeTimeoutMs', probeTimeoutMs], ['maxOutputBytes', maxOutputBytes]]) if (!Number.isSafeInteger(value) || value < 1) throw new GatewayLifecycleError('GATEWAY_CONFIG_INVALID', `${name} must be a positive safe integer`);

  let state = 'disconnected';
  let lastProbe = null;
  const runProbe = spawnFn ?? (({ command }) => defaultSpawn({ command, timeoutMs: probeTimeoutMs, maxOutputBytes }));

  async function probe() {
    try {
      const result = await runProbe({ command: cliCommand });
      if (!result || typeof result !== 'object' || result.code !== 0) {
        lastProbe = Object.freeze({ available: false, cli: cliCommand, code: 'GATEWAY_PROBE_FAILED' });
      } else {
        lastProbe = Object.freeze({ available: true, cli: cliCommand, version: redactVersion(result.stdout) });
      }
    } catch (error) {
      // Preserve the probe's own failure taxonomy instead of folding
      // everything non-ENOENT into GATEWAY_PROBE_FAILED: a timeout or
      // an output-limit kill is a probe-internal outcome, not evidence
      // about the CLI, and collapsing it hides which one happened.
      const code = error?.code;
      const probeCode = code === 'ENOENT' ? 'CLI_NOT_FOUND'
        : code === 'GATEWAY_PROBE_TIMEOUT' ? 'GATEWAY_PROBE_TIMEOUT'
        : code === 'GATEWAY_PROBE_LIMIT' ? 'GATEWAY_PROBE_LIMIT'
        : 'GATEWAY_PROBE_FAILED';
      lastProbe = Object.freeze({ available: false, cli: cliCommand, code: probeCode });
    }
    state = 'probed';
    return lastProbe;
  }

  async function start(...args) {
    if (!channelAdapter) throw new GatewayLifecycleError('GATEWAY_LIFECYCLE_NOT_IMPLEMENTED', 'OpenClaw channel/Gateway lifecycle is not implemented; no verified channel adapter was injected');
    const result = await channelAdapter.start(...args);
    state = 'ready';
    return result;
  }

  async function stop(...args) {
    // No adapter at all: nothing was ever started, so reporting
    // stopped is honest. With an adapter, the constructor already
    // guaranteed a stop() function, so this always performs a real
    // stop instead of silently reporting one.
    if (channelAdapter) await channelAdapter.stop(...args);
    state = 'disconnected';
    return Object.freeze({ status: 'stopped' });
  }

  return Object.freeze({
    probe, start, stop,
    getState: () => state,
    getLastProbe: () => lastProbe,
    getCli: () => cliCommand,
  });
}
