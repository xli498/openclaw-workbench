import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows ConPTY provider for terminal sessions.
//
// WINDOWS_PTY_STATUS: EXECUTION VERIFIED ON WINDOWS CI (PR #45,
// 2026-11-02) for spawn, output pumping, input pumping, cancel, and
// exit-code propagation (tests 229-236 in
// tests/windows-pty-provider.test.mjs). ConPTY RESIZE IS WIRED IN THIS
// SLICE via a named-pipe control channel (see below); its Windows CI
// execution verification lives in tests/windows-pty-resize.test.mjs
// and is reported per-PR, not claimed here ahead of that run.
//
// Resize channel (named pipe, per design
// ~/workspace/wb4-work/windows-pty-resize-design.md, not in repo):
// the provider generates a per-session pipe name
// `ocw-pty-<uuid>` and passes it in the helper payload. The helper
// creates a single-instance NamedPipeServerStream restricted to the
// current user (explicit PipeSecurity) BEFORE CreateProcess, starts a
// control runspace, and writes exactly one `READY <pipeName>` line to
// stdout before the child output pump starts. The provider SCANS the
// initial stdout for exactly that line instead of requiring it to be
// first: a fast child (cmd echo) can emit output before the helper's
// readiness write reaches the pipe even though the write precedes
// pump start in program order (PR #47 Windows CI rounds 1-2 proved
// the strict-first-line gate false; the exact .NET-side reorder
// mechanism is NOT established, so the protocol no longer depends
// on write order at all). Child lines seen before READY
// are queued and delivered in order once READY arrives, so no output
// is lost and no session is returned without the channel: if READY
// never arrives within a bounded 64 KB pre-READY window (or the 30 s
// overall control wait, or helper exit), spawn fails fast with
// PTY_FAILED -- never a silent no-resize session. The pipe name in
// the READY line is the provider's own per-session value, so a child
// cannot spoof readiness by printing a bare READY. After READY, the
// provider connects as a named-pipe client, and only then returns
// the handle: if the pipe cannot be created or connected
// within a bounded timeout, spawn fails fast with PTY_FAILED.
// resize() sends one JSON line
// {id, type: 'resize', cols, rows} and resolves with the acked size
// only when the helper's ack echoes the same cols/rows; any nack,
// malformed ack, or missing ack within 5 seconds rejects
// PTY_RESIZE_FAILED / PTY_RESIZE_TIMEOUT, never a faked size. The
// channel carries only resize/close verbs, never commands, argv,
// environment, or file content. The pipe name is never logged.
//
// What is guaranteed on every platform: on non-Windows, this provider
// refuses with PTY_UNAVAILABLE and never fakes a pty (no fallback
// disguised as pty:true). On Windows it attempts the real ConPTY helper
// and surfaces helper failure as PTY_FAILED, never as a silent fallback.
//
// The helper is spawned with shell:false, a workspace cwd, a minimal
// environment (PATH/SystemRoot plus caller-validated entries), and a
// single base64 JSON payload argument in the style of the existing
// Windows helpers (runtime/windows-path-lock.ps1). Argument values are
// never logged, stored, or included in errors.
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_PTY_COLS = 500;
const MAX_PTY_ROWS = 200;
const CONTROL_CONNECT_TIMEOUT_MS = 30_000;
const CONTROL_PIPE_CONNECT_TIMEOUT_MS = 10_000;
const RESIZE_ACK_TIMEOUT_MS = 5_000;
const CONTROL_LINE_MAX_BYTES = 4096;

// Same size contract as the POSIX provider (pty-provider.mjs) and the
// terminal-session passthrough: cols 1-500, rows 1-200, integers only.
// Exported so the contract is unit-testable on Linux, where the
// provider itself refuses with PTY_UNAVAILABLE before any handle
// exists. resize() validates with this BEFORE checking settlement,
// mirroring the POSIX order (an invalid size on a closed session is
// PTY_SIZE_INVALID, not PTY_CLOSED).
export function safeWindowsPtySize(cols, rows) {
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > MAX_PTY_COLS || !Number.isSafeInteger(rows) || rows < 1 || rows > MAX_PTY_ROWS) throw new WindowsPtyProviderError('PTY_SIZE_INVALID', 'PTY size is invalid');
  return Object.freeze({ cols, rows });
}

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

    // Per-session control pipe name. The helper validates it against
    // CONTROL_PIPE_PATTERN and fails the spawn on anything else --
    // never a fallback to a no-resize session.
    const controlPipe = `ocw-pty-${randomUUID()}`;
    const payload = Buffer.from(JSON.stringify({
      cwd: workdir,
      argv,
      cols: 80,
      rows: 24,
      controlPipe,
      env: mergeEnvCaseInsensitive({ PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, extraEnv),
    }), 'utf8').toString('base64');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Payload', payload], {
      cwd: workdir,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    // Named-pipe control channel state. 'pending' until READY + pipe
    // connect succeed, 'ready' while resizes may flow, 'closed' once
    // the pipe is gone (helper exit, abandonment, or cancel). The pipe
    // NAME is never stored in diagnostics, errors, or logs -- only
    // this boolean-ish state and a pending-request count are exposed.
    let controlSocket = null;
    let controlState = 'pending';
    let controlBuffer = '';
    const controlPending = new Map();
    let nextControlId = 1;
    // Pre-READY scan state (see the header comment): initial stdout is
    // scanned for exactly `READY <pipeName>`, the provider's own
    // per-session value. Complete child lines seen before it are
    // queued and delivered in order once it arrives; the pipe name
    // itself is never logged or placed in errors (only the fact that
    // the line was not found within the bound).
    let preReadyBuffer = '';
    let preReadyQueued = '';
    let preReadyFirstLine = true;
    let readyDone = false;
    const EXPECTED_READY = `READY ${controlPipe}`;
    const PRE_READY_MAX_BYTES = 65536;
    function scanPreReady(text) {
      // Returns 'found' when the readiness line was seen (queued
      // child lines already forwarded in order, remainder forwarded
      // verbatim), 'waiting' while still scanning. Throws PTY_FAILED
      // when pre-READY output exceeds the bound without READY.
      preReadyBuffer += text;
      for (;;) {
        const newline = preReadyBuffer.indexOf('\n');
        if (newline === -1) break;
        const rawLine = preReadyBuffer.slice(0, newline);
        preReadyBuffer = preReadyBuffer.slice(newline + 1);
        let line = rawLine;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        // A BOM can only prefix the stream's first line; strip it
        // there so a BOM-emitting writer cannot hide READY.
        if (preReadyFirstLine && line.startsWith('\uFEFF')) line = line.slice(1);
        preReadyFirstLine = false;
        if (line === EXPECTED_READY) {
          if (preReadyQueued) onOutput({ stream: 'stdout', text: preReadyQueued });
          if (preReadyBuffer) onOutput({ stream: 'stdout', text: preReadyBuffer });
          preReadyQueued = '';
          preReadyBuffer = '';
          return 'found';
        }
        preReadyQueued += rawLine + '\n';
      }
      // Bound applies only once this chunk is fully scanned without
      // READY: a chunk that carries READY past the bound still
      // succeeds, since READY was present on the wire. Without READY,
      // queued + partial bytes cannot grow past the bound + one chunk.
      if (preReadyQueued.length + preReadyBuffer.length > PRE_READY_MAX_BYTES) {
        throw new WindowsPtyProviderError('PTY_FAILED', `PTY control channel readiness line not found within ${PRE_READY_MAX_BYTES} bytes of child output (helper stderr: ${stderrText.trim().slice(0, 512) || 'none'})`);
      }
      return 'waiting';
    }
    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let helperExitResolve;
    const helperExitPromise = new Promise((resolve) => { helperExitResolve = resolve; });
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
      // Settlement also closes the control channel: an in-flight
      // resize must not linger until its 5s ack timer fires, and a
      // settled session's resize reports PTY_CLOSED (checked first in
      // controlResize), not a stale ack.
      failControl();
      // The abort listener must not survive settlement: a later
      // abort (e.g. a test timing out after the helper already
      // exited) must not taskkill an unrelated process reusing the
      // pid, and a retained listener keeps the session referenced.
      try { signal?.removeEventListener('abort', killTree); } catch {}
      onExit(result);
    };
    let lastKillResult = null;
    const killTree = () => {
      // Killing the helper tree also drops the control pipe: the
      // helper treats pipe disconnect as session abandonment and
      // terminates the child itself, so a taskkill never leaves an
      // orphaned ConPTY child behind the pipe close.
      try { controlSocket?.destroy(); } catch {}
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
    // Control-channel machinery (function declarations so finish()
    // above may call failControl before this point in source order;
    // all of them run only after these declarations have executed).
    function failControl() {
      if (controlState === 'closed') return;
      controlState = 'closed';
      for (const entry of controlPending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new WindowsPtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed'));
      }
      controlPending.clear();
      try { controlSocket?.destroy(); } catch {}
      controlSocket = null;
    }
    function attachControlHandlers(socket) {
      socket.on('data', (chunk) => {
        controlBuffer += chunk.toString('utf8');
        let newline;
        while ((newline = controlBuffer.indexOf('\n')) !== -1) {
          let line = controlBuffer.slice(0, newline);
          controlBuffer = controlBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          // Defensive: a writer that emits a UTF-8 BOM prefixes its
          // first frame with U+FEFF, which JSON.parse rejects. The
          // helper now writes no BOM (see windows-pty.ps1); strip
          // one here so a future writer regression degrades to a
          // working ack instead of a silent resize timeout.
          if (line.startsWith('\uFEFF')) line = line.slice(1);
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          const entry = controlPending.get(String(frame?.id));
          if (!entry) continue;
          controlPending.delete(String(frame.id));
          clearTimeout(entry.timer);
          // An ack is only believed when it echoes the requested
          // size exactly. A malformed or mismatched ack is a failed
          // resize, never a faked size.
          if (frame.ok === true && frame.cols === entry.cols && frame.rows === entry.rows) entry.resolve(Object.freeze({ cols: frame.cols, rows: frame.rows }));
          else entry.reject(new WindowsPtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed'));
        }
        // A partial line longer than the protocol cap is a protocol
        // violation, not a buffer to grow without bound.
        if (controlBuffer.length > CONTROL_LINE_MAX_BYTES) failControl();
      });
      socket.on('error', () => failControl());
      socket.on('close', () => failControl());
    }
    function connectControl() {
      return new Promise((resolve, reject) => {
        // Node named-pipe client path. The name itself is never
        // logged; only connect success/failure is observable.
        const pipePath = `\\\\.\\pipe\\${controlPipe}`;
        const socket = net.createConnection(pipePath);
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { socket.destroy(); } catch {}
          reject(new WindowsPtyProviderError('PTY_FAILED', 'PTY control channel connect timed out'));
        }, CONTROL_PIPE_CONNECT_TIMEOUT_MS);
        socket.once('connect', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          controlSocket = socket;
          controlState = 'ready';
          attachControlHandlers(socket);
          resolve();
        });
        socket.once('error', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new WindowsPtyProviderError('PTY_FAILED', 'PTY control channel connect failed'));
        });
      });
    }
    async function controlResize(cols, rows) {
      const size = safeWindowsPtySize(cols, rows);
      if (settled) throw new WindowsPtyProviderError('PTY_CLOSED', 'PTY session is closed');
      if (controlState !== 'ready' || !controlSocket || controlSocket.destroyed) throw new WindowsPtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed');
      const id = nextControlId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          controlPending.delete(String(id));
          reject(new WindowsPtyProviderError('PTY_RESIZE_TIMEOUT', 'PTY resize timed out'));
        }, RESIZE_ACK_TIMEOUT_MS);
        controlPending.set(String(id), { resolve, reject, timer, cols: size.cols, rows: size.rows });
        try {
          controlSocket.write(`${JSON.stringify({ id, type: 'resize', cols: size.cols, rows: size.rows })}\n`, (error) => {
            if (error) {
              clearTimeout(timer);
              controlPending.delete(String(id));
              reject(new WindowsPtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed'));
            }
          });
        } catch {
          clearTimeout(timer);
          controlPending.delete(String(id));
          reject(new WindowsPtyProviderError('PTY_RESIZE_FAILED', 'PTY resize failed'));
        }
      });
    }
    // Best-effort close verb for cancel(): fire the line, do not wait
    // for its ack -- cancel() waits for the helper's exit event
    // instead, and falls back to taskkill if that never arrives.
    function controlCloseBestEffort() {
      if (controlState !== 'ready' || !controlSocket || controlSocket.destroyed) return;
      try { controlSocket.write(`${JSON.stringify({ id: nextControlId++, type: 'close' })}\n`, () => {}); } catch {}
    }
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
      if (!text) return;
      if (!readyDone) {
        // Scan for READY (see scanPreReady): child output before it
        // is queued and delivered in order, never discarded and never
        // mistaken for a broken contract. Only a bound breach
        // rejects the spawn wait here; a missing READY with a live
        // helper is caught by the 30 s overall control wait, and a
        // missing READY with an exited helper by the exit race.
        let outcome;
        try {
          outcome = scanPreReady(text);
        } catch (error) {
          readyDone = true;
          readyReject(error);
          return;
        }
        if (outcome === 'found') {
          readyDone = true;
          readyResolve();
        }
        return;
      }
      onOutput({ stream: 'stdout', text });
    });
    child.once('error', () => {
      helperExitResolve('spawn-error');
      finish({ status: 'failed', error: { code: 'PTY_UNAVAILABLE' } });
    });
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
      helperExitResolve(code);
      const outTail = decoder.decode();
      if (outTail) {
        if (!readyDone) {
          // Helper exited with stdout still buffered: the tail may
          // hold queued child lines plus the READY line (or a READY
          // fragment split across the last chunk). Scan it the same
          // way; if READY is found, resolve (harmless if the exit
          // race already settled) and forward queued output plus
          // remainder. If not found, the exit race settles the
          // provider wait (helper-exited-0 / helper-failed); a
          // bound breach here must not overwrite the exit result.
          try {
            if (scanPreReady(outTail) === 'found') {
              readyDone = true;
              readyResolve();
            }
          } catch {}
        } else {
          onOutput({ stream: 'stdout', text: outTail });
        }
      }
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
    // Control-channel establishment gates the handle: READY, then
    // pipe connect, bounded overall. Three outcomes, no silent
    // fourth: 'ready' (normal session); 'helper-exited-0' (a
    // short-lived child that already finished cleanly -- the handle
    // is still returned so its exit result flows, and a later resize
    // honestly reports PTY_CLOSED because the session is settled);
    // anything else throws PTY_FAILED after killing the helper, so
    // the caller never holds a live session without a resize channel.
    // The ready chain gets a no-op catch so a late rejection after
    // the race has settled (helper exit winning mid-connect) cannot
    // surface as an unhandled rejection.
    {
      const readyChain = (async () => { await readyPromise; await connectControl(); })();
      readyChain.catch(() => {});
      let controlTimer;
      try {
        const outcome = await Promise.race([
          readyChain.then(() => 'ready'),
          helperExitPromise.then((code) => (code === 0 ? 'helper-exited-0' : 'helper-failed')),
          new Promise((_, reject) => { controlTimer = setTimeout(() => reject(new WindowsPtyProviderError('PTY_FAILED', 'PTY control channel timed out')), CONTROL_CONNECT_TIMEOUT_MS); }),
        ]);
        if (outcome === 'helper-failed') throw new WindowsPtyProviderError('PTY_FAILED', stderrText.trim() || 'PTY failed');
        if (outcome === 'helper-exited-0') controlState = 'closed';
      } catch (error) {
        if (error instanceof WindowsPtyProviderError && error.code === 'PTY_FAILED') {
          killTree();
          throw error;
        }
        killTree();
        throw new WindowsPtyProviderError('PTY_FAILED', 'PTY control channel failed');
      } finally {
        clearTimeout(controlTimer);
      }
    }
    return Object.freeze({
      capabilities: Object.freeze({ pty: true, input: true, incrementalOutput: true }),
      // Bounded diagnostic snapshot for a test that is about to
      // abort: the provider used to surface helper stderr only AFTER
      // helper exit, so a timed-out test could never show what the
      // helper had already printed (PTY_WAIT / PTY_CHILD_EXIT /
      // PTY_STAGE / PTY_PUMP_STATS). Callers log this before abort.
      // Control state is reported as a state word and a pending
      // count only -- the pipe name is never exposed here.
      diagnostics: () => ({ stderr: stderrText, childExitCode, exitCode, settled, kill: lastKillResult, stdinError: stdinError ? String(stdinError.code ?? stdinError) : null, control: controlState, controlPending: controlPending.size }),
      write: async (input) => {
        if (typeof input !== 'string' || !input) throw new WindowsPtyProviderError('PTY_INPUT_INVALID', 'PTY input is invalid');
        if (child.stdin.destroyed) throw new WindowsPtyProviderError('PTY_CLOSED', 'PTY session is closed');
        if (stdinError) throw new WindowsPtyProviderError('PTY_WRITE_FAILED', 'PTY write failed');
        await new Promise((resolve, reject) => child.stdin.write(input, (error) => (error ? reject(new WindowsPtyProviderError('PTY_WRITE_FAILED', 'PTY write failed')) : resolve())));
      },
      resize: (cols, rows) => controlResize(cols, rows),
      cancel: async () => {
        // Teardown order: the close verb first (the helper then
        // terminates the child itself and exits through its normal
        // cleanup, which is the path that proves the control channel
        // teardown works), taskkill only if the helper has not
        // exited within a bounded wait. A session that already
        // exited skips both waits. The pipe is closed last so the
        // helper cannot mistake an early pipe close for abandonment
        // while the close verb is still in flight.
        controlCloseBestEffort();
        if (exitCode === null) {
          // The close-verb wait must cover the helper's own bounded
          // cleanup (output pump up to 5 s, input pump up to 2 s,
          // plus margin): the previous 2 s bound mislabeled a
          // working close as a taskkill fallback whenever cleanup
          // ran long (PR #47 Windows CI, cancel test). 10 s still
          // bounds cancel; taskkill remains the fallback after it.
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 10000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        if (exitCode === null) {
          killTree();
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        }
        try { controlSocket?.destroy(); } catch {}
        controlState = 'closed';
      },
    });
  };
}
