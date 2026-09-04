import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_SINGLE_ARG_BYTES = 16 * 1024;
const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']);
const WINDOWS_ANCHOR_READY = 'OCW_WINDOWS_ANCHOR_READY';
const WINDOWS = process.platform === 'win32';
const WINDOWS_ANCHOR_RUNNER = fileURLToPath(new URL('./windows-anchor-runner.ps1', import.meta.url));
const TRUSTED_EXECUTABLE_DIRECTORIES = Object.freeze(WINDOWS
  ? [
      path.dirname(process.execPath),
      `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`,
      `${process.env.SystemRoot ?? 'C:\\Windows'}`,
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin'),
      path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'git', 'cmd'),
      path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'git', 'bin'),
      path.join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'git', 'cmd'),
    ]
  : ['/usr/bin', '/bin']);

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
    if (WINDOWS) {
      const fsPromises = await import('node:fs/promises');
      const info = await fsPromises.lstat(candidate);
      if (info.isSymbolicLink()) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd must not be a symbolic link');
      if (!info.isDirectory()) throw new TerminalError('CWD_UNAVAILABLE', 'command cwd is not a directory');
      handle = await fsPromises.open(candidate, fsConstants.O_RDONLY);
      const openedInfo = await handle.stat();
      if (!openedInfo.isDirectory()) throw new TerminalError('CWD_UNAVAILABLE', 'command cwd is not a directory');
      const cwdReal = await realpath(candidate);
      if (!inside(rootReal, cwdReal)) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd escapes workspace');
      const stable = Object.freeze({ handle, procPath: cwdReal, cwdReal, rootReal });
      __testHooks?.onCwdOpened?.(stable);
      return stable;
    }
    handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const procPath = `/proc/self/fd/${handle.fd}`;
    const cwdReal = await realpath(procPath);
    if (!inside(rootReal, cwdReal)) throw new TerminalError('SYMLINK_ESCAPE', 'command cwd escapes workspace');
    const info = await handle.stat();
    if (!info.isDirectory()) throw new TerminalError('CWD_UNAVAILABLE', 'command cwd is not a directory');
    const stable = Object.freeze({ handle, procPath, cwdReal, rootReal });
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
  const candidates = WINDOWS
    ? [...new Set((process.env.Path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean))].flatMap((directory) => {
        const extensions = path.extname(command) ? [''] : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
        return extensions.map((extension) => path.join(directory, `${command}${extension}`));
      })
    : TRUSTED_EXECUTABLE_DIRECTORIES.map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved && (resolved === process.execPath || TRUSTED_EXECUTABLE_DIRECTORIES.some((trusted) => {
      const normalized = path.resolve(trusted);
      return resolved === normalized || resolved.startsWith(`${normalized}${path.sep}`);
    }))) return resolved;
  }
  throw new TerminalError('EXECUTABLE_UNAVAILABLE', `trusted executable not found: ${command}`);
}

async function windowsAnchorInvocation({ root, cwd, executable, argv, timeoutMs }) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = await realpath(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    .catch((error) => { throw new TerminalError('WINDOWS_ANCHOR_UNAVAILABLE', error.message); });
  const payload = Buffer.from(JSON.stringify({ root, cwd: cwd ?? '.', executable, argv, timeoutMs }), 'utf8').toString('base64');
  return Object.freeze({ executable: powershell, argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_ANCHOR_RUNNER, '-Payload', payload] });
}

export async function runControlledCommand({ root, argv, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, signal, approved = false, __testHooks } = {}) {
  if (!approved) throw new TerminalError('APPROVAL_REQUIRED', 'terminal execution requires explicit approval');
  validateCommandLimits({ argv, timeoutMs, maxOutputBytes });
  const stableCwd = await openStableCwd(root, cwd, { __testHooks });
  const closeCwd = async (details) => {
    try { await stableCwd.handle.close(); }
    catch (error) { details.closeError = { code: error.code, message: error.message }; __testHooks?.onCloseError?.(error); }
  };
  let executable;
  let spawnArgs = argv.slice(1);
  try {
    if (WINDOWS && argv[0] === 'pwd') {
      executable = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
      spawnArgs = ['/d', '/c', 'cd'];
    } else executable = await resolveExecutable(argv[0]);
  }
  catch (error) { const details = {}; await closeCwd(details); if (Object.keys(details).length) error.details = { ...(error.details ?? {}), ...details }; throw error; }
  if (WINDOWS) {
    try {
      const invocation = await windowsAnchorInvocation({ root: stableCwd.rootReal, cwd: cwd ?? '.', executable, argv: spawnArgs, timeoutMs });
      executable = invocation.executable;
      spawnArgs = invocation.argv;
    } catch (error) { const details = {}; await closeCwd(details); if (Object.keys(details).length) error.details = { ...(error.details ?? {}), ...details }; throw error; }
  }
  if (signal?.aborted) { const details = {}; await closeCwd(details); throw new TerminalError('ABORTED', 'command aborted before start', details); }
  return new Promise((resolve, reject) => {
    let child;
    // Test-only seam: production always uses node:child_process spawn.
    const spawnImpl = __testHooks?.spawn ?? spawn;
    try { child = spawnImpl(executable, spawnArgs, { cwd: WINDOWS ? undefined : stableCwd.procPath, env: safeEnv(env), shell: false, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      const details = {};
      void closeCwd(details).then(() => reject(new TerminalError('SPAWN_FAILED', error.message, details)));
      return;
    }
    let stdout = ''; let stderr = ''; let outputBytes = 0; let settled = false; let timedOut = false; let outputLimited = false;
    const kill = () => {
      try {
        if (WINDOWS && child.pid) {
          const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
          spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true }).unref();
        } else if (WINDOWS) child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      } catch {}
    };
    const finish = async (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const details = value?.details ?? {};
      await closeCwd(details);
      if (details.closeError && value && !value.details) value = Object.freeze({ ...value, closeError: details.closeError });
      fn(value);
    };
    const abort = () => { kill(); void finish(reject, new TerminalError('ABORTED', 'command aborted')); };
    // The Windows runner compiles its small in-process anchor once before it can
    // begin the target timeout. Keep a bounded startup allowance so this outer
    // guard does not kill the runner and strand its child during compilation.
    let timer;
    const scheduleTimeout = (delay) => { timer = setTimeout(() => { timedOut = true; kill(); finish(reject, new TerminalError('TIMEOUT', `command exceeded ${timeoutMs}ms`)); }, delay); };
    scheduleTimeout(WINDOWS ? timeoutMs + 15_000 : timeoutMs);
    const collect = (target, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) { outputLimited = true; kill(); return target; }
      return target + chunk.toString();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => {
      if (WINDOWS) {
        const text = chunk.toString();
        if (text.includes(WINDOWS_ANCHOR_READY)) {
          clearTimeout(timer);
          scheduleTimeout(timeoutMs);
          chunk = Buffer.from(text.replaceAll(`${WINDOWS_ANCHOR_READY}\r\n`, '').replaceAll(`${WINDOWS_ANCHOR_READY}\n`, '').replaceAll(WINDOWS_ANCHOR_READY, ''), 'utf8');
        }
      }
      stderr = collect(stderr, chunk);
    });
    child.on('error', (error) => finish(reject, new TerminalError('SPAWN_FAILED', error.message)));
    child.on('close', (code, signalName) => {
      if (settled) return;
      if (outputLimited) return void finish(reject, new TerminalError('OUTPUT_LIMIT', `command output exceeded ${maxOutputBytes} bytes`, { code, signal: signalName }));
      if (timedOut) return void finish(reject, new TerminalError('TIMEOUT', `command exceeded ${timeoutMs}ms`));
      if (code !== 0) return void finish(reject, new TerminalError((WINDOWS && code === 124) ? 'TIMEOUT' : 'PROCESS_FAILED', (WINDOWS && code === 124) ? `command exceeded ${timeoutMs}ms` : `command exited with code ${code}`, { code, signal: signalName, stdout, stderr }));
      void finish(resolve, Object.freeze({ argv: [...argv], cwd: stableCwd.cwdReal, stdout, stderr, code }));
    });
  });
}

export { SAFE_ENV_KEYS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_ARG_COUNT, MAX_ARG_BYTES, MAX_SINGLE_ARG_BYTES };
