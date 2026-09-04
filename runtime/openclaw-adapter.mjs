import { spawn } from 'node:child_process';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 600_000;
const DIAGNOSTIC_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_MAX_OUTPUT_BYTES = 16 * 1024;
const MCP_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const MCP_DIAGNOSTIC_MAX_OUTPUT_BYTES = 64 * 1024;

export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.details = details;
  }
}

export function buildAgentArgv({ message, sessionKey, agent, model, thinking, timeoutSeconds, local = false }) {
  if (!message) throw new AdapterError('INVALID_INPUT', 'message is required');
  if (!sessionKey && !agent) throw new AdapterError('INVALID_INPUT', 'sessionKey or agent is required');
  const argv = ['agent', '--json', '--message', message];
  if (sessionKey) argv.push('--session-key', sessionKey);
  if (agent) argv.push('--agent', agent);
  if (model) argv.push('--model', model);
  if (thinking) argv.push('--thinking', thinking);
  if (timeoutSeconds !== undefined) argv.push('--timeout', String(timeoutSeconds));
  if (local) argv.push('--local');
  return argv;
}

export function parseAgentJson(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object') throw new Error('not_object');
    return value;
  } catch (error) {
    throw new AdapterError('INVALID_RESPONSE', 'OpenClaw returned invalid JSON', { cause: error.message });
  }
}

function safeCommandLabel(command) {
  if (typeof command !== 'string' || !command) return 'openclaw';
  const base = path.basename(command).replace(/[?&#].*$/, '');
  if (/(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]/i.test(base) || /:\/\/[^/]*:[^@]+@/i.test(base)) return '[redacted]';
  return base.length <= 128 ? base : `${base.slice(0, 125)}...`;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, '^$1').replace(/%/g, '^%').replace(/!/g, '^!')}"`;
}

function spawnInvocation(command, argv, { platform = process.platform, comSpec = process.env.ComSpec ?? 'cmd.exe' } = {}) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) return { command: comSpec, argv: ['/d', '/s', '/c', [command, ...argv].map(quoteCmdArg).join(' ')] };
  return { command, argv };
}

function runFixedCommand({ command, argv, timeoutMs, maxOutputBytes, spawnImpl, platform, comSpec }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const invocation = spawnInvocation(command, argv, { platform, comSpec });
      child = spawnImpl(invocation.command, invocation.argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: (platform ?? process.platform) !== 'win32' });
    } catch (error) {
      const wrapped = new AdapterError('SPAWN_FAILED', 'OpenClaw CLI could not be started');
      wrapped.cause = error;
      reject(wrapped);
      return;
    }
    let stdout = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill?.();
      } catch {}
    };
    const timer = setTimeout(() => { terminate(); finish(reject, new AdapterError('TIMEOUT', 'OpenClaw diagnostic timed out')); }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate();
        finish(reject, new AdapterError('OUTPUT_LIMIT', 'OpenClaw diagnostic output exceeded the limit'));
        return;
      }
      stdout += chunk.toString();
    });
    child.on('error', (error) => {
      const wrapped = new AdapterError(error.code === 'ENOENT' ? 'CLI_NOT_FOUND' : 'SPAWN_FAILED', 'OpenClaw CLI could not be started');
      wrapped.cause = error;
      finish(reject, wrapped);
    });
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new AdapterError('PROCESS_FAILED', 'OpenClaw diagnostic exited unsuccessfully'));
      finish(resolve, stdout);
    });
  });
}

export async function inspectOpenClaw({ command = 'openclaw', timeoutMs = DIAGNOSTIC_TIMEOUT_MS, maxOutputBytes = DIAGNOSTIC_MAX_OUTPUT_BYTES, spawnImpl = spawn, platform, comSpec } = {}) {
  try {
    const stdout = await runFixedCommand({ command, argv: ['--version'], timeoutMs, maxOutputBytes, spawnImpl, platform, comSpec });
    const version = stdout.trim().match(/\d+(?:\.\d+){1,3}/)?.[0] ?? null;
    const commandLabel = safeCommandLabel(command);
    if (!version) return Object.freeze({ status: 'unavailable', code: 'INVALID_VERSION', command: commandLabel });
    return Object.freeze({ status: 'ready', version, command: commandLabel });
  } catch (error) {
    const code = error.code === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : 'CLI_UNAVAILABLE';
    return Object.freeze({ status: 'unavailable', code, command: safeCommandLabel(command) });
  }
}

function redactMcpValue(value) {
  if (typeof value !== 'string') return '[redacted]';
  if (/(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]/i.test(value) || /:\/\/[^/]*:[^@]+@/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.includes('\\')) return '[redacted]';
  return value.length <= 128 ? value : `${value.slice(0, 125)}...`;
}

function normalizeMcpServers(value) {
  const candidates = Array.isArray(value) ? value : value?.servers ?? value?.server ?? value?.items;
  if (!Array.isArray(candidates)) return null;
  return candidates.slice(0, 256).map((item, index) => {
    const rawName = item?.name ?? item?.id ?? item?.server ?? `server-${index + 1}`;
    const rawStatus = item?.status ?? item?.state ?? item?.health ?? 'unknown';
    const name = typeof rawName === 'string' && rawName.trim() ? redactMcpValue(rawName.trim()) : `server-${index + 1}`;
    const status = typeof rawStatus === 'string' && rawStatus.trim() ? redactMcpValue(rawStatus.trim()) : 'unknown';
    return { name, status };
  });
}

export async function inspectOpenClawMcp({ command = 'openclaw', timeoutMs = MCP_DIAGNOSTIC_TIMEOUT_MS, maxOutputBytes = MCP_DIAGNOSTIC_MAX_OUTPUT_BYTES, spawnImpl = spawn, platform, comSpec } = {}) {
  try {
    const stdout = await runFixedCommand({ command, argv: ['mcp', 'status', '--json'], timeoutMs, maxOutputBytes, spawnImpl, platform, comSpec });
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { return Object.freeze({ status: 'unavailable', code: 'INVALID_RESPONSE', command: safeCommandLabel(command) }); }
    const servers = normalizeMcpServers(parsed);
    const commandLabel = safeCommandLabel(command);
    if (!servers) return Object.freeze({ status: 'unavailable', code: 'INVALID_RESPONSE', command: commandLabel });
    return Object.freeze({ status: 'ready', command: commandLabel, serverCount: servers.length, servers });
  } catch (error) {
    const code = error.code === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : 'CLI_UNAVAILABLE';
    return Object.freeze({ status: 'unavailable', code, command: safeCommandLabel(command) });
  }
}

export function runAgent(options, { command = 'openclaw', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = 1_048_576, signal, platform, comSpec, spawnImpl = spawn } = {}) {
  const argv = buildAgentArgv(options);
  const currentPlatform = platform ?? process.platform;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AdapterError('ABORTED', 'Agent run aborted'));
    const invocation = spawnInvocation(command, argv, { platform: currentPlatform, comSpec });
    const child = spawnImpl(invocation.command, invocation.argv, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: currentPlatform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let outputTruncated = false;
    const appendOutput = (target, chunk) => {
      if (outputTruncated) return target;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputTruncated = true;
        terminate();
        return target;
      }
      return target + chunk.toString();
    };
    let settled = false;
    const terminate = () => {
      try {
        if (currentPlatform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
    };
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); } };
    const timer = setTimeout(() => {
      terminate();
      finish(reject, new AdapterError('TIMEOUT', `OpenClaw agent exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => {
      terminate();
      finish(reject, new AdapterError('ABORTED', 'Agent run aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.on('error', (error) => {
      finish(reject, new AdapterError('SPAWN_FAILED', error.message));
    });
    child.on('close', (code, signalName) => {
      if (settled) return;
      if (outputTruncated) return finish(reject, new AdapterError('OUTPUT_LIMIT', `OpenClaw output exceeded ${maxOutputBytes} bytes`, { code, signal: signalName }));
      if (code !== 0) return finish(reject, new AdapterError('PROCESS_FAILED', `OpenClaw exited with code ${code}`, { code, signal: signalName, stderr }));
      try { finish(resolve, parseAgentJson(stdout)); }
      catch (error) { finish(reject, error); }
    });
  });
}

export function createOpenClawAgentRunner({ command = 'openclaw', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = 1_048_576, platform, comSpec, spawnImpl } = {}) {
  if (typeof command !== 'string' || !command) throw new AdapterError('INVALID_CONFIG', 'command is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new AdapterError('INVALID_CONFIG', 'timeoutMs must be a positive safe integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new AdapterError('INVALID_CONFIG', 'maxOutputBytes must be a positive safe integer');
  // The Workbench control plane is deliberately local-only. Do not accept an
  // adapter-level override: callers may supply only a request-local input.
  return Object.freeze((input = {}) => runAgent({ ...input, local: true }, { command, timeoutMs, maxOutputBytes, signal: input.signal, platform, comSpec, spawnImpl }));
}
