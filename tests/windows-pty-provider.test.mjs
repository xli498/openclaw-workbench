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
    const { handle, outputs, result } = await runConPty(root, ['cmd.exe', '/c', 'echo', 'hello-conpty']);
    assert.deepEqual(handle.capabilities, { pty: true, input: true, incrementalOutput: true });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.match(outputs.join(''), /hello-conpty/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY propagates a non-zero child exit as failed', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const { result } = await runConPty(root, ['cmd.exe', '/c', 'exit', '42']);
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
    const { outputs, result } = await runConPty(root, ['cmd.exe', '/v:on', '/c', 'echo pty-ready-232 & set /p v= && echo got-!v!'], { writeInput: 'hello-input\r\n', readyPattern: /pty-ready-232/ });
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
      root, argv: ['cmd.exe', '/c', 'echo pty-ready-233 & ping -n 60 127.0.0.1'], cwd: '.', signal: controller.signal,
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
    const { outputs, result } = await runConPty(root, ['cmd.exe', '/c', command]);
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.match(outputs.join(''), /pty-tail-marker-9f3/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
