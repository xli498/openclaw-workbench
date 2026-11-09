import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowsPtyProvider, windowsPtyAvailable } from '../runtime/windows-pty-provider.mjs';

// Platform split, by design:
// - The Linux-only assertions below skip on Windows: on non-Windows the
//   provider must refuse with PTY_UNAVAILABLE and never fake a pty.
// - The ConPTY execution tests below skip on non-Windows and RUN on
//   Windows CI (the Windows job's test-name-pattern includes "Windows"):
//   they spawn the real ConPTY helper through the real provider, so a
//   Windows CI failure here is a real ConPTY failure, not a mock gap.
//   They were written on Linux and first verified by Windows CI; see
//   docs/05 and the WINDOWS_PTY_STATUS header in the provider for the
//   outcome of that verification.
const SKIP_ON_WINDOWS = process.platform === 'win32';
const SKIP_OFF_WINDOWS = process.platform !== 'win32';

test('Windows PTY provider reports unavailable on Linux', { skip: SKIP_ON_WINDOWS }, () => {
  assert.equal(windowsPtyAvailable(), false);
});

test('Windows PTY provider refuses on Linux instead of faking a pty', { skip: SKIP_ON_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const provider = createWindowsPtyProvider();
    await assert.rejects(provider({
      root, argv: ['cmd.exe'], cwd: '.', signal: new AbortController().signal,
      onOutput: () => {},
      onExit: () => {},
    }), (error) => error.code === 'PTY_UNAVAILABLE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY provider rejects invalid env without reaching the platform check', { skip: SKIP_ON_WINDOWS }, () => {
  assert.throws(() => createWindowsPtyProvider({ env: { 'bad key': 'x' } }), (error) => error.code === 'PTY_ENV_INVALID');
});

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runConPty(root, argv, { writeInput = null, readyPattern = null } = {}) {
  const provider = createWindowsPtyProvider();
  const outputs = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const controller = new AbortController();
  const handle = await provider({
    root, argv, cwd: '.', signal: controller.signal,
    onOutput: (value) => { outputs.push(value.text); },
    onExit: (result) => resolveExit(result),
  });
  // Log the helper's captured stderr BEFORE aborting: once the
  // helper is taskkilled, the chance to see whether it reached
  // PTY_WAIT / PTY_CHILD_EXIT / cleanup stages is gone.
  const logDiagnostics = () => {
    try {
      const d = handle.diagnostics?.();
      if (d) console.error(`PTY_DIAGNOSTIC: childExitCode=${d.childExitCode ?? 'none'} settled=${d.settled} stderr=${d.stderr}`);
    } catch {}
  };
  if (writeInput !== null) {
    if (readyPattern) {
      // A write-callback success only proves the bytes reached the
      // helper's stdin, not that the child consumed them. Wait for the
      // child's own ready marker first, so a missing echo cannot be
      // blamed on (or hidden by) write timing.
      const deadline = Date.now() + 30_000;
      while (!readyPattern.test(outputs.join(''))) {
        if (Date.now() > deadline) {
          logDiagnostics();
          controller.abort();
          throw new Error('timed out waiting for ConPTY child ready marker');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await handle.write(writeInput);
  }
  let result;
  try {
    result = await withTimeout(exited, 60_000, 'ConPTY child exit');
  } catch (error) {
    // A timed-out session must not orphan its helper: without the
    // abort, a helper stuck waiting on its child (or in cleanup) keeps
    // the test-file process alive through its piped stdio and hangs
    // the whole Windows run even though this test already failed.
    // Abort triggers the provider's taskkill of the helper tree.
    logDiagnostics();
    controller.abort();
    throw error;
  }
  return { handle, outputs, result, controller };
}

test('Windows PTY ConPTY reports PowerShell available', { skip: SKIP_OFF_WINDOWS }, () => {
  assert.equal(windowsPtyAvailable(), true);
});

test('Windows PTY ConPTY spawns cmd, pumps output, and exits zero', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const { handle, outputs, result } = await runConPty(root, ['cmd.exe', '/d', '/c', 'echo', 'hello-conpty']);
    assert.deepEqual(handle.capabilities, { pty: true, input: true, incrementalOutput: true });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.match(outputs.join(''), /hello-conpty/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY propagates a non-zero child exit as failed', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const { result } = await runConPty(root, ['cmd.exe', '/d', '/c', 'exit', '42']);
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.equal(result.error.code, 'PTY_FAILED');
    // The raw child code IS carried, as error.childExitCode, from the
    // helper's PTY_CHILD_EXIT diagnostic (42 here, before the
    // helper's own 0/1 normalization). Accepting any PTY_FAILED
    // would let a startup failure masquerade as the exit-42 path, so
    // the exact code is asserted. The top-level result.code stays
    // absent on failed results (the shared provider contract); only
    // the diagnostic field carries the number.
    assert.equal(result.error.childExitCode, 42);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY pumps input to a child reading a line', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const { outputs, result } = await runConPty(root, ['cmd.exe', '/d', '/v:on', '/c', 'echo pty-ready-232 & set /p v= && echo got-!v!'], { writeInput: 'hello-input\r\n', readyPattern: /pty-ready-232/ });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.match(outputs.join(''), /got-hello-input/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY cancel stops a long-running child', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const provider = createWindowsPtyProvider();
    const outputs = [];
    let resolveExit;
    let exitedFlag = false;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const controller = new AbortController();
    const handle = await provider({
      root, argv: ['cmd.exe', '/d', '/c', 'echo pty-ready-233 & ping -n 60 127.0.0.1'], cwd: '.', signal: controller.signal,
      onOutput: (value) => { outputs.push(value.text); },
      onExit: (result) => { exitedFlag = true; resolveExit(result); },
    });
    // Cancel must be tested against a child that has provably
    // STARTED, not one that merely has not exited yet: without the
    // ready marker, an initialization failure would also satisfy
    // "not exited" and the test would pass vacuously.
    const deadline = Date.now() + 30_000;
    while (!/pty-ready-233/.test(outputs.join(''))) {
      if (Date.now() > deadline) {
        controller.abort();
        throw new Error('timed out waiting for ConPTY child ready marker');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(exitedFlag, false, 'child must not have exited before cancel');
    controller.abort();
    await handle.cancel();
    const result = await withTimeout(exited, 30_000, 'ConPTY child exit after cancel');
    assert.notEqual(result.status, 'exited');
    assert.match(outputs.join(''), /pty-ready-233/);
    // CI-visible cancel accounting: the taskkill outcome and whether
    // the helper actually exited, not just "cancel returned".
    try {
      const diag = handle.diagnostics?.();
      if (diag) console.error(`PTY_CANCEL_DIAGNOSTIC: taskkill=${JSON.stringify(diag.kill)} helperExitCode=${diag.exitCode ?? 'none'}`);
    } catch {}
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY delivers trailing output before exit', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    // A large body plus a unique final marker: settling on helper
    // 'exit' instead of stdio 'close' risks losing exactly this tail.
    // The marker must already be in outputs when onExit resolves.
    const fills = Array.from({ length: 100 }, (_, i) => `echo fill-${i}`);
    const command = [...fills, 'echo pty-tail-marker-9f3'].join(' & ');
    const { outputs, result } = await runConPty(root, ['cmd.exe', '/d', '/c', command]);
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.match(outputs.join(''), /pty-tail-marker-9f3/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY write after helper ends fails in a controlled way', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    // The write and the wait are inside the same timeout/abort/
    // cleanup scope: a helper that already ended must produce a
    // controlled PTY rejection, never an unhandled stdin error and
    // never a leftover helper.
    const provider = createWindowsPtyProvider();
    const outputs = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const controller = new AbortController();
    const handle = await provider({
      root, argv: ['cmd.exe', '/d', '/c', 'echo done-early'], cwd: '.', signal: controller.signal,
      onOutput: (value) => { outputs.push(value.text); },
      onExit: (result) => resolveExit(result),
    });
    let result;
    try {
      result = await withTimeout(exited, 30_000, 'ConPTY child exit');
    } catch (error) {
      controller.abort();
      throw error;
    }
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.match(outputs.join(''), /done-early/);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(
      handle.write('late-input\r\n'),
      (error) => error.code === 'PTY_CLOSED' || error.code === 'PTY_WRITE_FAILED',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY normalizes case-variant env and reads caller value', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    // Caller 'Path' must collapse the base 'PATH' to exactly one
    // entry with the caller's value; with both present, cmd would
    // expand the base PATH instead. Keys are deliberately given out
    // of order (ZEBRA before ALPHA); the helper sorts the block, so
    // the block does not depend on insertion order (that sorting is
    // internal -- what the child can observe is the collapsed value).
    const provider = createWindowsPtyProvider({ env: { ZEBRA: 'z-9', Path: 'C:\\pty-custom-path-9', ALPHA: 'a-9' } });
    const outputs = [];
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const controller = new AbortController();
    await provider({
      root, argv: ['cmd.exe', '/d', '/c', 'echo %Path% & echo %ZEBRA% & echo %ALPHA%'], cwd: '.', signal: controller.signal,
      onOutput: (value) => { outputs.push(value.text); },
      onExit: (result) => resolveExit(result),
    });
    let result;
    try {
      result = await withTimeout(exited, 30_000, 'ConPTY child exit');
    } catch (error) {
      controller.abort();
      throw error;
    }
    assert.equal(result.status, 'exited', JSON.stringify(result));
    const joined = outputs.join('');
    assert.match(joined, /pty-custom-path-9/);
    assert.match(joined, /z-9/);
    assert.match(joined, /a-9/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows ConPTY resize on a live session succeeds over the control channel and the child observes the new size', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    // New contract (PR #47): the named-pipe control channel exists,
    // so resize on a live session is a real resize, not a
    // PTY_RESIZE_UNSUPPORTED rejection. The old expectation ("no
    // persistent control channel exists yet") died with the channel:
    // resize resolves with the acked size, and the child itself must
    // then observe the new console size -- an ack alone is not
    // sufficient evidence. The observation mechanism is the same one
    // the already-passing tests/windows-pty-resize.test.mjs uses:
    // a PowerShell child printing its own $Host.UI.RawUI.WindowSize
    // every 200 ms as SIZE:<WindowSize>/<BufferSize>.
    const provider = createWindowsPtyProvider();
    const outputs = [];
    let resolveExit;
    let exitedFlag = false;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const controller = new AbortController();
    const handle = await provider({
      root,
      argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "while ($true) { $w=$Host.UI.RawUI.WindowSize; $b=$Host.UI.RawUI.BufferSize; Write-Output ('SIZE:{0}x{1}/{2}x{3}' -f $w.Width,$w.Height,$b.Width,$b.Height); Start-Sleep -Milliseconds 200 }"],
      cwd: '.', signal: controller.signal,
      onOutput: (value) => { outputs.push(value.text); },
      onExit: (result) => { exitedFlag = true; resolveExit(result); },
    });
    const waitForOutput = async (pattern, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (!pattern.test(outputs.join(''))) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for output ${pattern}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    try {
      // Initial SIZE match only: Windows CI measured 23-28 s before
      // the first SIZE line (PowerShell child startup under ConPTY),
      // so 60 s keeps the same assertion with room for slow runners.
      await waitForOutput(/SIZE:80x24\//, 60_000);
      assert.equal(exitedFlag, false, 'child must not have exited before resize');
      // Ack: resize resolves with the size the helper echoed back.
      const size = await handle.resize(120, 40);
      assert.deepEqual(size, { cols: 120, rows: 40 });
      // Observation: the child itself prints the new WindowSize.
      await waitForOutput(/SIZE:120x40\//, 30_000);
      const back = await handle.resize(80, 24);
      assert.deepEqual(back, { cols: 80, rows: 24 });
      await waitForOutput(/SIZE:80x24\//, 30_000);
    } finally {
      controller.abort();
      await handle.cancel().catch(() => {});
      await withTimeout(exited, 30_000, 'ConPTY child exit after cancel').catch(() => {});
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
