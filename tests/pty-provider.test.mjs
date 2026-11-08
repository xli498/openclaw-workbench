import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPosixPtyProvider, ptyAvailable } from '../runtime/pty-provider.mjs';
import { createTerminalSessionManager } from '../runtime/terminal-session.mjs';

const SKIP = !ptyAvailable();
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'pty-bridge.py');

function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (predicate() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error('timed out')) : setTimeout(tick, 10));
    tick();
  });
}

test('PTY provider echoes interactive input with pty capabilities', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-'));
  try {
    const provider = createPosixPtyProvider();
    const outputs = [];
    let exitResult;
    const handle = await provider({
      root, argv: ['cat'], cwd: '.', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: (result) => { exitResult = result; },
    });
    assert.deepEqual(handle.capabilities, { pty: true, input: true, incrementalOutput: true });
    await handle.write('hello-pty\n');
    await waitFor(() => outputs.join('').includes('hello-pty'));
    await handle.cancel();
    await waitFor(() => exitResult !== undefined);
    assert.ok(outputs.join('').includes('hello-pty'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PTY provider integrates with the session manager and reports pty:true for pwd', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-session-'));
  try {
    const manager = createTerminalSessionManager({ root, sessionProvider: createPosixPtyProvider() });
    const created = await manager.create({ argv: ['pwd'], approved: true });
    assert.equal(created.capabilities.pty, true);
    await waitFor(() => manager.get(created.id).status === 'exited');
    const read = await manager.read(created.id, {});
    assert.equal(read.session.status, 'exited');
    assert.equal(read.session.exitCode, 0);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PTY provider never stores its env in session records', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-env-'));
  const marker = 'pty-env-marker-abcdef';
  try {
    const manager = createTerminalSessionManager({ root, sessionProvider: createPosixPtyProvider({ env: { PTY_TEST_MARKER: marker } }) });
    const created = await manager.create({ argv: ['pwd'], approved: true });
    await waitFor(() => manager.get(created.id).status === 'exited');
    assert.equal(JSON.stringify(manager.list()).includes(marker), false);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PTY provider rejects an invalid command without leaking env', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-bad-'));
  try {
    const provider = createPosixPtyProvider({ env: { PTY_TEST_MARKER: 'pty-env-marker-abcdef' } });
    // Q31-3 behavior change: a non-allowlisted (here absolute-path)
    // executable is rejected before spawn instead of failing through
    // the exit channel, so there is no exit result to inspect; the
    // rejection itself must still carry no env material.
    await assert.rejects(provider({
      root, argv: ['/nonexistent-pty-binary-xyz'], cwd: '.',
      onOutput: () => {},
      onExit: () => {},
    }), (error) => error.code === 'PTY_EXECUTABLE_NOT_ALLOWED' && !String(error.message).includes('pty-env-marker-abcdef'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Q31-3 follow-ups: cwd used to be a pure text containment check (a
// workspace symlink pointing outside passed, and '..cache' was falsely
// rejected), and argv had no executable allowlist at all.
test('PTY provider resolves cwd symlinks and allows ..cache names', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-cwd-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-pty-outside-'));
  let handle;
  try {
    await mkdir(path.join(root, '..cache'));
    await symlink(outside, path.join(root, 'escape-link'));
    const provider = createPosixPtyProvider();
    await assert.rejects(provider({
      root, argv: ['pwd'], cwd: 'escape-link',
      onOutput: () => {}, onExit: () => {},
    }), (error) => error.code === 'PTY_CWD_ESCAPE');
    const outputs = [];
    let exitResult;
    handle = await provider({
      root, argv: ['pwd'], cwd: '..cache', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: (result) => { exitResult = result; },
    });
    await waitFor(() => outputs.join('').includes('..cache'));
    await handle.cancel();
    await waitFor(() => exitResult !== undefined);
  } finally {
    if (handle) await handle.cancel().catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('PTY provider allowlists executables by default', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-allowlist-'));
  try {
    const provider = createPosixPtyProvider();
    for (const argv of [['sh', '-c', 'echo hi'], ['rm', '-rf', 'x'], ['/bin/cat'], ['node', '--version'], ['../../bin/cat']]) {
      await assert.rejects(provider({
        root, argv, cwd: '.',
        onOutput: () => {}, onExit: () => {},
      }), (error) => error.code === 'PTY_EXECUTABLE_NOT_ALLOWED');
    }
    // The default allowlist still covers the repo's own PTY flows.
    const outputs = [];
    let exitResult;
    const handle = await provider({
      root, argv: ['cat'], cwd: '.', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: (result) => { exitResult = result; },
    });
    await handle.write('allowlisted-cat\n');
    await waitFor(() => outputs.join('').includes('allowlisted-cat'));
    await handle.cancel();
    await waitFor(() => exitResult !== undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Q31-4 follow-ups: cancel used to SIGTERM only the helper's process
// group (the pty child lives in a new session, so it never saw the
// signal), the 1s SIGKILL escalation was cleared by the helper's exit,
// and EOF waitpid blocked forever.
test('PTY provider cancel kills the child tree including descendants', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-cancel-tree-'));
  let handle;
  let descendantPid = null;
  try {
    // sh is opted into explicitly here: the test needs a shell to
    // background a descendant, and sh is not on the default allowlist.
    // The tree ignores SIGHUP on purpose: closing the pty master
    // already sends SIGHUP to the foreground group, so without the
    // trap a baseline helper that merely dies on SIGTERM would still
    // kill this tree by accident and the test could not tell the
    // forwarding fix apart from that side effect. Ignored dispositions
    // survive exec, so the descendant's death here proves the SIGTERM
    // group forward, not the master-close HUP.
    const provider = createPosixPtyProvider({ allowedExecutables: ['sh'] });
    const outputs = [];
    let exitResult;
    handle = await provider({
      root, argv: ['sh', '-c', 'trap "" HUP; sleep 60 & echo DESC:$!; wait'], cwd: '.', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: (result) => { exitResult = result; },
    });
    await waitFor(() => /DESC:(\d+)/.test(outputs.join('')), 8000);
    descendantPid = Number(outputs.join('').match(/DESC:(\d+)/)[1]);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    // The descendant is alive before cancel.
    process.kill(descendantPid, 0);
    await handle.cancel();
    await waitFor(() => exitResult !== undefined, 8000);
    // ...and dead after it, without waiting out sleep's 60s.
    await waitFor(() => {
      try { process.kill(descendantPid, 0); return false; } catch { return true; }
    }, 5000);
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
    if (handle) await handle.cancel().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY helper exits promptly when the child closes its pty but keeps running', { skip: SKIP }, async () => {
  // Direct helper spawn (like the fd3 test): the child execs sleep
  // with its std fds closed, so the master sees EOF while the child
  // is still alive. The old unbounded waitpid hung here forever.
  const child = spawn('python3', [HELPER, '--', 'sh', '-c', 'exec sleep 30 <&- >&- 2>&-'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await waitFor(() => child.exitCode !== null, 8000);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
});
