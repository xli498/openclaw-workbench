import { spawn, spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Host-injected POSIX PTY provider for terminal sessions. This is the only
// PTY implementation in the repo: it is explicitly opt-in (a session
// manager must be constructed with it), it only runs on POSIX, and it
// delegates pty allocation to a small audited Python helper
// (runtime/pty-bridge.py) because Node's standard library cannot allocate
// a pty. The helper is spawned with shell:false, a symlink-resolved
// workspace cwd, a minimal environment (PATH/TERM plus caller-validated
// entries), and a detached process group. argv[0] must be on the
// provider's executable allowlist (default: cat, pwd) and is resolved to
// a trusted system directory, never via PATH search. cancel() sends
// SIGTERM to the helper's group; the helper forwards it to the child's
// own process group (pty.fork puts the child in a new session, so the
// helper's group alone cannot reach it) and escalates to SIGKILL after
// 1s if the tree is still alive. Environment values are never logged,
// stored, or included in errors. On Windows, or without python3, the provider refuses with
// PTY_UNAVAILABLE instead of silently falling back to a non-pty runner
// (that fallback is the session manager's default, and it reports
// pty:false honestly).
//
// Resize channel: the helper is spawned with one extra pipe as its fd3.
// resize(cols, rows) validates cols 1-500 and rows 1-200 (PTY_SIZE_INVALID
// otherwise) and writes one "<cols> <rows>\n" line to that pipe; the
// helper applies it with TIOCSWINSZ and signals the child with SIGWINCH.
// The initial pty size is the kernel default until the first resize.
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_PTY_COLS = 500;
const MAX_PTY_ROWS = 200;

// Q31-3: provider-level executable allowlist, minimal by design. The
// default covers only what this repo's own PTY tests and session flows
// need (cat for echo/interactive tests, pwd for session tests). A
// provider instance that needs more must opt in explicitly via
// allowedExecutables -- the default never widens silently. Names are
// bare only (no slashes, no PATH search): each is resolved against the
// trusted system directories below and spawned by absolute path, so a
// poisoned PATH or a workspace-local binary can never be substituted.
export const PTY_ALLOWED_EXECUTABLES = Object.freeze(['cat', 'pwd']);
const PTY_TRUSTED_EXECUTABLE_DIRECTORIES = Object.freeze(['/usr/bin', '/bin']);

async function resolvePtyExecutable(name, allowed) {
  if (!allowed.includes(name) || name.includes('/') || name.includes('\\')) throw new PtyProviderError('PTY_EXECUTABLE_NOT_ALLOWED', 'PTY executable is not allowlisted');
  for (const directory of PTY_TRUSTED_EXECUTABLE_DIRECTORIES) {
    const resolved = await realpath(path.join(directory, name)).catch(() => null);
    if (resolved) return resolved;
  }
  throw new PtyProviderError('PTY_EXECUTABLE_NOT_ALLOWED', 'PTY executable is not allowlisted');
}

export function safePtySize(cols, rows) {
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > MAX_PTY_COLS || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_PTY_ROWS) throw new PtyProviderError('PTY_SIZE_INVALID', 'PTY size is invalid');
  return Object.freeze({ cols, rows });
}

export class PtyProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PtyProviderError';
    this.code = code;
  }
}

function safeEnv(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PtyProviderError('PTY_ENV_INVALID', 'PTY env must be an object');
  const env = {};
  for (const [key, val] of Object.entries(value)) {
    if (!ENV_PATTERN.test(key) || typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)) throw new PtyProviderError('PTY_ENV_INVALID', 'PTY env entry is invalid');
    env[key] = val;
  }
  return env;
}

export function ptyAvailable() {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0;
  } catch { return false; }
}

export function createPosixPtyProvider({ pythonCommand = 'python3', env, helperPath, allowedExecutables = PTY_ALLOWED_EXECUTABLES } = {}) {
  const extraEnv = safeEnv(env);
  const helper = helperPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-bridge.py');
  if (typeof pythonCommand !== 'string' || !pythonCommand || /[\0\r\n]/.test(pythonCommand) || /[;&|<>`$()]/.test(pythonCommand)) throw new PtyProviderError('PTY_COMMAND_INVALID', 'PTY python command is invalid');
  if (!Array.isArray(allowedExecutables) || allowedExecutables.some((item) => typeof item !== 'string' || !item || item.includes('/') || item.includes('\\'))) throw new PtyProviderError('PTY_EXECUTABLE_NOT_ALLOWED', 'PTY allowed executables are invalid');

  return async function posixPtyProvider({ root, argv, cwd = '.', signal, onOutput, onExit } = {}) {
    if (process.platform === 'win32') throw new PtyProviderError('PTY_UNAVAILABLE', 'PTY provider is unavailable on Windows');
    if (typeof root !== 'string' || !root) throw new PtyProviderError('PTY_ROOT_INVALID', 'PTY workspace root is required');
    if (!Array.isArray(argv) || !argv.length || argv.some((item) => typeof item !== 'string' || !item || /[\0\r\n]/.test(item))) throw new PtyProviderError('PTY_ARGV_INVALID', 'PTY argv is invalid');
    if (typeof onOutput !== 'function' || typeof onExit !== 'function') throw new PtyProviderError('PTY_CALLBACK_INVALID', 'PTY callbacks are required');
    // Q31-3: resolve symlinks before the containment check, and check
    // containment segment-wise. The old relative.startsWith('..') test
    // both missed a workspace symlink pointing outside AND falsely
    // rejected legitimate names such as '..cache' (which merely starts
    // with '..' but is a single segment inside the root).
    const rootReal = await realpath(path.resolve(root)).catch(() => { throw new PtyProviderError('PTY_ROOT_INVALID', 'PTY workspace root is unavailable'); });
    const candidate = path.resolve(rootReal, cwd === '.' ? '' : cwd);
    const workdir = await realpath(candidate).catch(() => { throw new PtyProviderError('PTY_CWD_UNAVAILABLE', 'PTY cwd is unavailable'); });
    const relative = path.relative(rootReal, workdir);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new PtyProviderError('PTY_CWD_ESCAPE', 'PTY cwd escapes the workspace');
    const executable = await resolvePtyExecutable(argv[0], allowedExecutables);

    const child = spawn(pythonCommand, [helper, '--', executable, ...argv.slice(1)], {
      cwd: workdir,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color', ...extraEnv },
    });
    let settled = false;
    const control = child.stdio[3];
    const decoder = new TextDecoder();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { control?.destroy(); } catch {}
      onExit(result);
    };
    child.stdout.on('data', (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) onOutput({ stream: 'stdout', text });
    });
    child.once('error', () => finish({ status: 'failed', error: { code: 'PTY_UNAVAILABLE' } }));
    child.once('exit', (code) => {
      const tail = decoder.decode();
      if (tail) onOutput({ stream: 'stdout', text: tail });
      if (code === 0) finish({ status: 'exited', code: 0 });
      else finish({ status: 'failed', error: { code: 'PTY_FAILED' } });
    });
    if (signal?.aborted) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    } else {
      signal?.addEventListener('abort', () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, { once: true });
    }
    return Object.freeze({
      capabilities: Object.freeze({ pty: true, input: true, incrementalOutput: true }),
      write: async (input) => {
        if (typeof input !== 'string' || !input) throw new PtyProviderError('PTY_INPUT_INVALID', 'PTY input is invalid');
        if (child.stdin.destroyed) throw new PtyProviderError('PTY_CLOSED', 'PTY session is closed');
        await new Promise((resolve, reject) => child.stdin.write(input, (error) => (error ? reject(new PtyProviderError('PTY_WRITE_FAILED', 'PTY write failed')) : resolve())));
      },
      resize: async (cols, rows) => {
        const size = safePtySize(cols, rows);
        if (settled || control?.destroyed) throw new PtyProviderError('PTY_CLOSED', 'PTY session is closed');
        await new Promise((resolve, reject) => control.write(`${size.cols} ${size.rows}\n`, (error) => (error ? reject(new PtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed')) : resolve())));
        return size;
      },
      cancel: async () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        // Q31-4: the SIGKILL escalation timer is deliberately NOT
        // cleared by the helper's exit event. The old code cleared it,
        // so a helper that exited on SIGTERM without forwarding it
        // orphaned the whole child tree. Tiering matters here: the
        // helper's own watchdog SIGKILLs the child group 1s after a
        // forwarded SIGTERM, so this provider-side fallback runs at 2s
        // -- late enough for the helper to kill the tree first, and
        // only a last resort for a stuck helper (SIGKILLing the helper
        // itself can never reach the child's session). The callback
        // first checks the group still exists, so a late firing after
        // a clean exit is a harmless no-op instead of a kill against a
        // possibly reused process group.
        await new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch {}
            if (!done) { done = true; resolve(); }
          }, 2000);
          child.once('exit', () => { if (!done) { done = true; resolve(); } });
        });
      },
    });
  };
}
