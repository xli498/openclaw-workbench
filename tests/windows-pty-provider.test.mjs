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

async function runConPty(root, argv, { writeInput = null } = {}) {
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
  if (writeInput !== null) await handle.write(writeInput);
  const result = await withTimeout(exited, 60_000, 'ConPTY child exit');
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
    // Known contract gap, shared with the POSIX provider: the child's
    // numeric exit code is not carried on the failed result (only the
    // PTY_FAILED code is). Asserting the current contract, not the
    // wished-for one; see docs/05.
    assert.equal(result.code, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY pumps input to a child reading a line', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const { outputs, result } = await runConPty(root, ['cmd.exe', '/v:on', '/c', 'set /p v= && echo got-!v!'], { writeInput: 'hello-input\r\n' });
    assert.equal(result.status, 'exited', JSON.stringify(result));
    assert.match(outputs.join(''), /got-hello-input/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PTY ConPTY cancel stops a long-running child', { skip: SKIP_OFF_WINDOWS }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-winpty-'));
  try {
    const provider = createWindowsPtyProvider();
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const controller = new AbortController();
    const handle = await provider({
      root, argv: ['cmd.exe', '/c', 'ping', '-n', '60', '127.0.0.1'], cwd: '.', signal: controller.signal,
      onOutput: () => {},
      onExit: (result) => resolveExit(result),
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    controller.abort();
    await handle.cancel();
    const result = await withTimeout(exited, 30_000, 'ConPTY child exit after cancel');
    assert.notEqual(result.status, 'exited');
  } finally { await rm(root, { recursive: true, force: true }); }
});
