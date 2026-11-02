import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows ConPTY provider for terminal sessions.
//
// WINDOWS_PTY_STATUS: UNVERIFIED. This file and runtime/windows-pty.ps1
// were written and reviewed on Linux and have never run on Windows:
// the ConPTY path (CreatePseudoConsole + CreateProcess with a
// pseudoconsole attribute) is a real implementation attempt, not a
// verified one. Windows CI (owned by the parent agent) must validate
// spawn/write/cancel/exit-code propagation before this provider is used
// for real sessions. Until then, treat every Windows success claim as
// unproven.
//
// What is guaranteed on every platform: on non-Windows, this provider
// refuses with PTY_UNAVAILABLE and never fakes a pty (no fallback
// disguised as pty:true). On Windows it attempts the real ConPTY helper
// and surfaces helper failure as PTY_FAILED, never as a silent fallback.
// Resize is NOT wired for ConPTY in this slice: the helper is a one-shot
// process with no persistent control channel to call ResizePseudoConsole
// on, so handle.resize() throws PTY_RESIZE_UNSUPPORTED honestly instead
// of pretending the size changed. Wiring a ConPTY resize channel (for
// example a named-pipe control channel owned by a persistent host) is
// deferred to a follow-up slice.
//
// The helper is spawned with shell:false, a workspace cwd, a minimal
// environment (PATH/SystemRoot plus caller-validated entries), and a
// single base64 JSON payload argument in the style of the existing
// Windows helpers (runtime/windows-path-lock.ps1). Argument values are
// never logged, stored, or included in errors.
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class WindowsPtyProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WindowsPtyProviderError';
    this.code = code;
  }
}

function powershellPath() {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function mergeEnvCaseInsensitive(base, extra) {
  // Windows environment names are case-insensitive: merging a
  // caller 'Path' over a base 'PATH' must leave exactly one entry,
  // or the child sees a duplicated name and the winner depends on
  // block order. The caller's entry wins and keeps its own casing;
  // a second case-variant inside extra itself is resolved the same
  // way, in insertion order.
  const merged = { ...base };
  for (const [key, val] of Object.entries(extra)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
    merged[key] = val;
  }
  return merged;
}

function safeEnv(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WindowsPtyProviderError('PTY_ENV_INVALID', 'PTY env must be an object');
  const env = {};
  for (const [key, val] of Object.entries(value)) {
    if (!ENV_PATTERN.test(key) || typeof val !== 'string' || val.length > 4096 || /[\0\r\n]/.test(val)) throw new WindowsPtyProviderError('PTY_ENV_INVALID', 'PTY env entry is invalid');
    env[key] = val;
  }
  return env;
}

// Prerequisite check only: on Windows, is PowerShell present? This says
// nothing about whether the ConPTY path itself works (see
// WINDOWS_PTY_STATUS above). On non-Windows it is always false.
export function windowsPtyAvailable() {
  if (process.platform !== 'win32') return false;
  try {
    const result = spawnSync(powershellPath(), ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return result.status === 0;
  } catch { return false; }
}

export function createWindowsPtyProvider({ env, helperPath, powershellCommand } = {}) {
  const extraEnv = safeEnv(env);
  const helper = helperPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-pty.ps1');
  const powershell = powershellCommand ?? powershellPath();
  if (typeof powershell !== 'string' || !powershell || /[\0\r\n]/.test(powershell)) throw new WindowsPtyProviderError('PTY_COMMAND_INVALID', 'PTY PowerShell command is invalid');

  return async function windowsPtyProvider({ root, argv, cwd = '.', signal, onOutput, onExit } = {}) {
    if (process.platform !== 'win32') throw new WindowsPtyProviderError('PTY_UNAVAILABLE', 'Windows PTY provider is unavailable on this platform');
    if (typeof root !== 'string' || !root) throw new WindowsPtyProviderError('PTY_ROOT_INVALID', 'PTY workspace root is required');
    if (!Array.isArray(argv) || !argv.length || argv.some((item) => typeof item !== 'string' || !item || /[\0\r\n]/.test(item))) throw new WindowsPtyProviderError('PTY_ARGV_INVALID', 'PTY argv is invalid');
    const rootPath = path.resolve(root);
    const workdir = path.resolve(rootPath, cwd === '.' ? '' : cwd);
    const relative = path.relative(rootPath, workdir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new WindowsPtyProviderError('PTY_CWD_ESCAPE', 'PTY cwd escapes the workspace');
    if (typeof onOutput !== 'function' || typeof onExit !== 'function') throw new WindowsPtyProviderError('PTY_CALLBACK_INVALID', 'PTY callbacks are required');

    const payload = Buffer.from(JSON.stringify({
      cwd: workdir,
      argv,
      cols: 80,
      rows: 24,
      env: mergeEnvCaseInsensitive({ PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, extraEnv),
    }), 'utf8').toString('base64');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Payload', payload], {
      cwd: workdir,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const decoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    // The helper prints only child output on stdout; its own failures
    // print a single PTY_FAILED line on stderr with no argv values, so
    // capturing bounded stderr here is safe and makes the next Windows
    // CI failure self-diagnosing instead of a bare PTY_FAILED code.
    let stderrText = '';
    // Raw child exit code reported by the helper on stderr as
    // PTY_CHILD_EXIT (before its own cleanup, so it is the child's
    // code, not a cleanup artefact). Carried on the failed result as
    // error.childExitCode ONLY when actually received; the top-level
    // result.code contract is unchanged (0 on exited, absent on
    // failed) and the helper's own exit stays normalized to 0/1.
    let childExitCode = null;
    let stderrParseBuffer = '';
    child.stderr.on('data', (chunk) => {
      const text = stderrDecoder.decode(chunk, { stream: true });
      stderrText += text;
      if (stderrText.length > 4096) stderrText = stderrText.slice(0, 4096);
      stderrParseBuffer += text;
      const match = /PTY_CHILD_EXIT: decimal=(\d+); hex=0x[0-9A-Fa-f]+/.exec(stderrParseBuffer);
      if (match) childExitCode = Number(match[1]);
      if (stderrParseBuffer.length > 512) stderrParseBuffer = stderrParseBuffer.slice(-512);
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      // The abort listener must not survive settlement: a later
      // abort (e.g. a test timing out after the helper already
      // exited) must not taskkill an unrelated process reusing the
      // pid, and a retained listener keeps the session referenced.
      try { signal?.removeEventListener('abort', killTree); } catch {}
      onExit(result);
    };
    let lastKillResult = null;
    const killTree = () => {
      if (!child.pid) return;
      try {
        // Bounded: an unbounded synchronous taskkill could itself
        // hang the event loop past every JS-side timeout, so it gets
        // a finite timeout and its result is saved for diagnostics
        // instead of being discarded.
        const kill = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true, timeout: 5000 });
        lastKillResult = { status: kill.status, error: kill.error ? String(kill.error.code ?? kill.error) : null, signal: kill.signal ?? null };
      } catch (error) { lastKillResult = { status: null, error: String(error), signal: null }; }
    };
    // A write callback alone is not an error listener: if the helper
    // ends early, a later write can surface as an unhandled stdin
    // 'error' event instead of a controlled rejection. Record it and
    // fail the session in a controlled way (only while the helper
    // has not already exited -- after exit, close settlement owns
    // the result and a stray stdin error must not overwrite it).
    let stdinError = null;
    child.stdin.on('error', (error) => {
      stdinError = error;
      if (!settled && exitCode === null) finish({ status: 'failed', error: { code: 'PTY_WRITE_FAILED', message: 'PTY stdin error' } });
    });
    child.stdout.on('data', (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) onOutput({ stream: 'stdout', text });
    });
    child.once('error', () => finish({ status: 'failed', error: { code: 'PTY_UNAVAILABLE' } }));
    // Settle on 'close', not on 'exit': 'exit' fires when the helper
    // process ends, but stdio data can still be in flight after it.
    // Settling on 'exit' used to flush only the stdout decoder and
    // call onExit while trailing output or diagnostics were still
    // undelivered. 'close' fires after all stdio is closed, so both
    // decoders are flushed there and settlement sees everything.
    // (The 'error' path above keeps its immediate finish: a spawn
    // error has no stdio to wait for.)
    let exitCode = null;
    child.once('exit', (code) => { exitCode = code; });
    child.once('close', (code) => {
      const outTail = decoder.decode();
      if (outTail) onOutput({ stream: 'stdout', text: outTail });
      const errTail = stderrDecoder.decode();
      if (errTail) {
        stderrText += errTail;
        if (stderrText.length > 4096) stderrText = stderrText.slice(0, 4096);
        const tailMatch = /PTY_CHILD_EXIT: decimal=(\d+); hex=0x[0-9A-Fa-f]+/.exec(errTail);
        if (tailMatch) childExitCode = Number(tailMatch[1]);
      }
      if (code === 0) finish({ status: 'exited', code: 0 });
      else finish({ status: 'failed', error: { code: 'PTY_FAILED', message: stderrText.trim() || 'PTY failed', ...(childExitCode !== null ? { childExitCode } : {}) } });
    });
    if (signal?.aborted) killTree();
    else signal?.addEventListener('abort', killTree, { once: true });
    return Object.freeze({
      capabilities: Object.freeze({ pty: true, input: true, incrementalOutput: true }),
      // Bounded diagnostic snapshot for a test that is about to
      // abort: the provider used to surface helper stderr only AFTER
      // helper exit, so a timed-out test could never show what the
      // helper had already printed (PTY_WAIT / PTY_CHILD_EXIT /
      // PTY_STAGE / PTY_PUMP_STATS). Callers log this before abort.
      diagnostics: () => ({ stderr: stderrText, childExitCode, exitCode, settled, kill: lastKillResult, stdinError: stdinError ? String(stdinError.code ?? stdinError) : null }),
      write: async (input) => {
        if (typeof input !== 'string' || !input) throw new WindowsPtyProviderError('PTY_INPUT_INVALID', 'PTY input is invalid');
        if (child.stdin.destroyed) throw new WindowsPtyProviderError('PTY_CLOSED', 'PTY session is closed');
        if (stdinError) throw new WindowsPtyProviderError('PTY_WRITE_FAILED', 'PTY write failed');
        await new Promise((resolve, reject) => child.stdin.write(input, (error) => (error ? reject(new WindowsPtyProviderError('PTY_WRITE_FAILED', 'PTY write failed')) : resolve())));
      },
      // Honest gap: no ConPTY resize channel exists in this slice.
      resize: async () => { throw new WindowsPtyProviderError('PTY_RESIZE_UNSUPPORTED', 'PTY resize is not supported by the Windows ConPTY provider'); },
      cancel: async () => {
        killTree();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      },
    });
  };
}
