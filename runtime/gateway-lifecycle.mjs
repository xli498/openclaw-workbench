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
//   a bounded, redacted first line. Missing CLI -> CLI_NOT_FOUND.
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

function redactVersion(value) {
  return String(value ?? '').split('\n')[0].slice(0, 256).replace(SECRET_VALUE_PATTERN, '[redacted]');
}

function defaultSpawn({ command, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
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
  if (channelAdapter !== undefined && (typeof channelAdapter !== 'object' || typeof channelAdapter.start !== 'function')) throw new GatewayLifecycleError('GATEWAY_ADAPTER_INVALID', 'Gateway channel adapter must provide start()');
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
      lastProbe = Object.freeze({ available: false, cli: cliCommand, code: error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'GATEWAY_PROBE_FAILED' });
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
    if (channelAdapter && typeof channelAdapter.stop === 'function') await channelAdapter.stop(...args);
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
