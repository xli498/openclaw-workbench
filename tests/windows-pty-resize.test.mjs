import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowsPtyProvider, safeWindowsPtySize } from '../runtime/windows-pty-provider.mjs';

// Windows ConPTY resize tests.
//
// Platform split, by design:
// - The size-validation assertions run everywhere: safeWindowsPtySize
//   is pure, so Linux can prove the contract without a ConPTY.
// - The execution tests skip on non-Windows and RUN on Windows CI
//   (the Windows job's test-name-pattern includes "Windows"). They
//   spawn the real ConPTY helper through the real provider over the
//   named-pipe control channel, so a Windows CI failure here is a
//   real resize failure, not a mock gap. The observation test asserts
//   on $Host.UI.RawUI.WindowSize as printed by the child AFTER the
//   resize -- an ack alone is NOT sufficient evidence: only a new
//   WindowSize in the child's own output proves the console actually
//   resized.
// - POSIX resize behavior is untouched by this slice and stays
//   covered by tests/pty-resize.test.mjs (Linux CI, full suite).
const SKIP_OFF_WINDOWS = process.platform !== 'win32';

test('Windows PTY resize size validation rejects out-of-range sizes', () => {
  assert.deepEqual(safeWindowsPtySize(80, 24), { cols: 80, rows: 24 });
  assert.deepEqual(safeWindowsPtySize(1, 1), { cols: 1, rows: 1 });
  assert.deepEqual(safeWindowsPtySize(500, 200), { cols: 500, rows: 200 });
  const bad = [[0, 24], [501, 24], [80, 0], [80, 201], [-1, 24], [80.5, 24], ['80', 24], [Number.NaN, 24], [80, undefined], [null, 24]];
  for (const [cols, rows] of bad) {
    assert.throws(() => safeWindowsPtySize(cols, rows), (error) => error.code === 'PTY_SIZE_INVALID');
  }
});

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForOutput(outputs, pattern, timeoutMs, logDiagnostics) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(outputs.join(''))) {
    if (Date.now() > deadline) {
      logDiagnostics?.();
      throw new Error(`timed out waiting for output ${pattern}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Spawns a PowerShell child that prints its own console size every
// 200ms: SIZE:<WindowSize Width>x<WindowSize Height>/<BufferSize
// Width>x<BufferSize Height>. The test asserts on the WindowSize
// half; the BufferSize half is printed alongside so a CI failure
// still shows what the console actually did.
async function runSizeLoop(root) {
  const provider = createWindowsPtyProvider();
  const outputs = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const controller = new AbortController();
  const t0 = Date.now();
  const handle = await provider({
    root,
    argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "while ($true) { $w=$Host.UI.RawUI.WindowSize; $b=$Host.UI.RawUI.BufferSize; Write-Output ('SIZE:{0}x{1}/{2}x{3}' -f $w.Width,$w.Height,$b.Width,$b.Height); Start-Sleep -Milliseconds 200 }"],
    cwd: '.',
    signal: controller.signal,
    onOutput: (value) => { outputs.push(value.text); },
    onExit: (result) => resolveExit(result),
  });
  // Stage timings: the first Windows CI run showed ~26 s before the
  // resize stage with no breakdown. These lines split provider
  // (READY + pipe connect) from the child's first SIZE line.
  console.error(`PTY_RESIZE_TIMING: provider-ms=${Date.now() - t0}`);
  const logDiagnostics = () => {
    try {
      const d = handle.diagnostics?.();
      if (d) console.error(`PTY_RESIZE_DIAGNOSTIC: control=${d.control} childExitCode=${d.childExitCode ?? 'none'} settled=${d.settled} stderr=${d.stderr}`);
    } catch {}
  };
  // Initial SIZE match only: Windows CI measured 23-28 s before the
  // first SIZE line (powershell child startup under ConPTY), so a
  // 30 s bound leaves 2-7 s of margin -- a flake risk, not a
  // condition. 60 s keeps the same assertion (child observes
  // 80x24) with room for slow runners. Post-resize matches stay
  // 30 s: the child is already running and prints every 200 ms.
  await waitForOutput(outputs, /SIZE:80x24\//, 60_000, logDiagnostics);
  console.error(`PTY_RESIZE_TIMING: size-initial-ms=${Date.now() - t0}`);
  return { handle, outputs, exited, controller, logDiagnostics };
}

// Resize with diagnostics on failure: a bare resize timeout says
// nothing about whether the control channel was ever connected
// (helper stderr carries the PTY_CONTROL lines either way).
async function resizeOrDiagnose(session, cols, rows) {
  try {
    return await session.handle.resize(cols, rows);
  } catch (error) {
    session.logDiagnostics();
    throw error;
  }
}

test('Windows ConPTY resize changes RawUI WindowSize observed by the child', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-resize-'));
  let session;
  try {
    session = await runSizeLoop(root);
    const size = await resizeOrDiagnose(session, 120, 40);
    assert.deepEqual(size, { cols: 120, rows: 40 });
    // The ack above only proves the helper answered. This wait proves
    // the child itself observes the new console size afterwards.
    await waitForOutput(session.outputs, /SIZE:120x40\//, 30_000, session.logDiagnostics);
    const back = await resizeOrDiagnose(session, 80, 24);
    assert.deepEqual(back, { cols: 80, rows: 24 });
    await waitForOutput(session.outputs, /SIZE:80x24\//, 30_000, session.logDiagnostics);
    await session.handle.cancel();
    const result = await withTimeout(session.exited, 30_000, 'ConPTY child exit after cancel');
    assert.notEqual(result.status, 'exited');
  } finally {
    if (session) {
      try { session.controller.abort(); } catch {}
      try { await session.handle.cancel(); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows ConPTY resize rejects invalid sizes and the session survives', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-resize-bad-'));
  let session;
  try {
    session = await runSizeLoop(root);
    const bad = [[0, 24], [501, 24], [80, 0], [80, 201], [-1, 24], [80.5, 24], ['80', 24], [Number.NaN, 24], [80, undefined], [null, 24]];
    for (const [cols, rows] of bad) {
      await assert.rejects(session.handle.resize(cols, rows), (error) => error.code === 'PTY_SIZE_INVALID');
    }
    // Invalid resizes must not poison the channel: a valid resize
    // afterwards still acks and still takes effect observably.
    const size = await resizeOrDiagnose(session, 100, 30);
    assert.deepEqual(size, { cols: 100, rows: 30 });
    await waitForOutput(session.outputs, /SIZE:100x30\//, 30_000, session.logDiagnostics);
    await session.handle.cancel();
    const result = await withTimeout(session.exited, 30_000, 'ConPTY child exit after cancel');
    assert.notEqual(result.status, 'exited');
  } finally {
    if (session) {
      try { session.controller.abort(); } catch {}
      try { await session.handle.cancel(); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows ConPTY resize after cancel reports PTY_CLOSED', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-resize-closed-'));
  let session;
  try {
    session = await runSizeLoop(root);
    await session.handle.cancel();
    const result = await withTimeout(session.exited, 30_000, 'ConPTY child exit after cancel');
    assert.notEqual(result.status, 'exited');
    await assert.rejects(session.handle.resize(80, 24), (error) => error.code === 'PTY_CLOSED');
  } finally {
    if (session) {
      try { session.controller.abort(); } catch {}
      try { await session.handle.cancel(); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows ConPTY cancel via control close stops a long-running child without taskkill', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-resize-close-'));
  let session;
  try {
    session = await runSizeLoop(root);
    // No controller.abort() here on purpose: abort taskkills the
    // helper tree from the Node side, which would prove nothing
    // about the control channel. cancel() sends the close verb
    // first; only if the helper has not exited within a bounded
    // wait does it fall back to taskkill. diagnostics.kill stays
    // null exactly when the close verb did the teardown.
    await session.handle.cancel();
    const result = await withTimeout(session.exited, 30_000, 'ConPTY child exit after control close');
    assert.notEqual(result.status, 'exited');
    assert.match(session.outputs.join(''), /SIZE:80x24\//);
    const diag = session.handle.diagnostics?.();
    assert.equal(diag?.kill, null, `expected close-verb teardown without taskkill, got ${JSON.stringify(diag?.kill)}`);
    assert.equal(result.error?.childExitCode, 1, `expected helper-terminated child code 1, got ${JSON.stringify(result)}`);
  } finally {
    if (session) {
      try { session.controller.abort(); } catch {}
      try { await session.handle.cancel(); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
