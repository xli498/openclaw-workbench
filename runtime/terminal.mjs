import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_SINGLE_ARG_BYTES = 16 * 1024;
const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);
const TRUSTED_EXECUTABLE_DIRECTORIES = Object.freeze(['/usr/bin', '/bin']);

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

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function openStableCwd(root, cwd, { __testHooks } = {}) {
  const rootReal = await realpath(root).catch((error) => { throw new TerminalError('ROOT_UNAVAILABLE', error.message); });
  const candidate = path.resolve(rootReal, cwd ?? '.');
  if (!inside(rootReal, candidate)) throw new TerminalError('PATH_ESCAPE', 'command cwd escapes workspace');
  let handle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const procPath = `/proc/self/fd/${handle.fd}`;
    const cwdReal = await realpath(procPath);
    if (!inside(rootReal, cwdReal)) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd escapes workspace');
    const info = await handle.stat();
    if (!info.isDirectory()) throw new TerminalError('CWD_UNAVAILABLE', 'command cwd is not a directory');
    const stable = Object.freeze({ handle, procPath, cwdReal });
    __testHooks?.onCwdOpened?.(stable);
    return stable;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof TerminalError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd must not be a symbolic link');
    if (error.code === 'ENOENT' && String(error.path ?? '').startsWith('/proc/self/fd/')) throw new TerminalError('STABLE_CWD_UNAVAILABLE', 'stable cwd requires Linux procfs');
    throw new TerminalError('CWD_UNAVAILABLE', error.message);
  }
}

async function resolveExecutable(command) {
  if (command === 'node') return process.execPath;
  if (path.isAbsolute(command)) {
    const resolved = await realpath(command).catch((error) => { throw new TerminalError('EXECUTABLE_UNAVAILABLE', error.message); });
    if (resolved === process.execPath || TRUSTED_EXECUTABLE_DIRECTORIES.some((directory) => resolved.startsWith(`${directory}${path.sep}`))) return resolved;
    throw new TerminalError('EXECUTABLE_UNTRUSTED', 'executable must be in a trusted system directory');
  }
  if (command.includes('/') || command.includes('\\')) throw new TerminalError('EXECUTABLE_UNTRUSTED', 'executable path must not be relative');
  for (const directory of TRUSTED_EXECUTABLE_DIRECTORIES) {
    const resolved = await realpath(path.join(directory, command)).catch(() => null);
    if (resolved && (resolved === process.execPath || TRUSTED_EXECUTABLE_DIRECTORIES.some((trusted) => resolved.startsWith(`${trusted}${path.sep}`)))) return resolved;
  }
  throw new TerminalError('EXECUTABLE_UNAVAILABLE', `trusted executable not found: ${command}`);
}

export async function runControlledCommand({ root, argv, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, approved = false, __testHooks } = {}) {
  if (!approved) throw new TerminalError('APPROVAL_REQUIRED', 'terminal execution requires explicit approval');
  validateCommandLimits({ argv, timeoutMs, maxOutputBytes });
  const stableCwd = await openStableCwd(root, cwd, { __testHooks });
  const executable = await resolveExecutable(argv[0]);
  if (signal?.aborted) { await stableCwd.handle.close(); throw new TerminalError('ABORTED', 'command aborted before start'); }
  return new Promise((resolve, reject) => {
    let child;
    // Test-only seam: production always uses node:child_process spawn.
    const spawnImpl = __testHooks?.spawn ?? spawn;
    try { child = spawnImpl(executable, argv.slice(1), { cwd: stableCwd.procPath, env: safeEnv(env), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { stableCwd.handle.close().catch(() => {}); reject(new TerminalError('SPAWN_FAILED', error.message)); return; }
    stableCwd.handle.close().catch(() => {});
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
      finish(resolve, Object.freeze({ argv: [...argv], cwd: stableCwd.cwdReal, stdout, stderr, code }));
    });
  });
}

export { SAFE_ENV_KEYS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_ARG_COUNT, MAX_ARG_BYTES, MAX_SINGLE_ARG_BYTES };
