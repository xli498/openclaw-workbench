import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_SINGLE_ARG_BYTES = 16 * 1024;
const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);

export class TerminalError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TerminalError'; this.code = code; this.details = details; }
}

export function validateCommandLimits({ argv, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((item) => typeof item !== 'string' || !item)) throw new TerminalError('INVALID_COMMAND', 'argv must be a non-empty string array');
  const argBytes = argv.reduce((total, item) => total + Buffer.byteLength(item), 0);
  if (argv.length > MAX_ARG_COUNT || argBytes > MAX_ARG_BYTES || argv.some((item) => Buffer.byteLength(item) > MAX_SINGLE_ARG_BYTES)) throw new TerminalError('INVALID_COMMAND_SIZE', 'argv exceeds controlled command size limits', { maxArgCount: MAX_ARG_COUNT, maxArgBytes: MAX_ARG_BYTES, maxSingleArgBytes: MAX_SINGLE_ARG_BYTES });
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new TerminalError('INVALID_TIMEOUT', `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_OUTPUT_BYTES) throw new TerminalError('INVALID_OUTPUT_LIMIT', `maxOutputBytes must be between 1 and ${MAX_OUTPUT_BYTES}`);
  return true;
}

function safeEnv(env) {
  const source = env ?? process.env;
  return Object.fromEntries(Object.entries(source)
    .filter(([key]) => SAFE_ENV_KEYS.has(key))
    .map(([key, value]) => [key, ['PATH', 'HOME', 'TMPDIR'].includes(key) ? process.env[key] : value]));
}

async function safeCwd(root, cwd) {
  const rootReal = await realpath(root).catch((error) => { throw new TerminalError('ROOT_UNAVAILABLE', error.message); });
  const candidate = path.resolve(rootReal, cwd ?? '.');
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${path.sep}`)) throw new TerminalError('PATH_ESCAPE', 'command cwd escapes workspace');
  const cwdReal = await realpath(candidate).catch((error) => { throw new TerminalError('CWD_UNAVAILABLE', error.message); });
  if (cwdReal !== rootReal && !cwdReal.startsWith(`${rootReal}${path.sep}`)) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd escapes workspace');
  return cwdReal;
}

export async function runControlledCommand({ root, argv, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, approved = false } = {}) {
  if (!approved) throw new TerminalError('APPROVAL_REQUIRED', 'terminal execution requires explicit approval');
  validateCommandLimits({ argv, timeoutMs, maxOutputBytes });
  const commandCwd = await safeCwd(root, cwd);
  if (signal?.aborted) throw new TerminalError('ABORTED', 'command aborted before start');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: commandCwd, env: safeEnv(env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let outputBytes = 0; let settled = false; let timedOut = false; let outputLimited = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); } };
    const abort = () => { kill(); finish(reject, new TerminalError('ABORTED', 'command aborted')); };
    const timer = setTimeout(() => { timedOut = true; kill(); finish(reject, new TerminalError('TIMEOUT', `command exceeded ${timeoutMs}ms`)); }, timeoutMs);
    const collect = (target, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) { outputLimited = true; kill(); return target; }
      return target + chunk.toString();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.on('error', (error) => finish(reject, new TerminalError('SPAWN_FAILED', error.message)));
    child.on('close', (code, signalName) => {
      if (settled) return;
      if (outputLimited) return finish(reject, new TerminalError('OUTPUT_LIMIT', `command output exceeded ${maxOutputBytes} bytes`, { code, signal: signalName }));
      if (timedOut) return finish(reject, new TerminalError('TIMEOUT', `command exceeded ${timeoutMs}ms`));
      if (code !== 0) return finish(reject, new TerminalError('PROCESS_FAILED', `command exited with code ${code}`, { code, signal: signalName, stdout, stderr }));
      finish(resolve, Object.freeze({ argv: [...argv], cwd: commandCwd, stdout, stderr, code }));
    });
  });
}

export { SAFE_ENV_KEYS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_ARG_COUNT, MAX_ARG_BYTES, MAX_SINGLE_ARG_BYTES };
