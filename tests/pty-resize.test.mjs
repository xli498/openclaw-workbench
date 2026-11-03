import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPosixPtyProvider, ptyAvailable } from '../runtime/pty-provider.mjs';
import { createTerminalSessionManager } from '../runtime/terminal-session.mjs';

const SKIP = !ptyAvailable();
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'pty-bridge.py');

function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => (predicate() ? resolve() : Date.now() - start > timeoutMs ? reject(new Error('timed out')) : setTimeout(tick, 20));
    tick();
  });
}

test('PTY resize changes stty size through the provider handle', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-resize-'));
  let handle;
  try {
    // sh is not on the provider's default executable allowlist (Q31-3):
    // this resize-mechanics test opts into it explicitly. The default
    // allowlist is covered by the PTY allowlist test in pty-provider.
    const provider = createPosixPtyProvider({ allowedExecutables: ['sh'] });
    const outputs = [];
    let exitResult;
    handle = await provider({
      root, argv: ['sh', '-c', 'while true; do stty size; sleep 0.2; done'], cwd: '.', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: (result) => { exitResult = result; },
    });
    await waitFor(() => /\d+ \d+/.test(outputs.join('')));
    const size = await handle.resize(120, 40);
    assert.deepEqual(size, { cols: 120, rows: 40 });
    await waitFor(() => outputs.join('').includes('40 120'));
    await handle.resize(80, 24);
    await waitFor(() => outputs.join('').includes('24 80'));
    await handle.cancel();
    await waitFor(() => exitResult !== undefined);
  } finally {
    // A failed wait must not orphan the looping child: its open stdout
    // pipe would keep this test file's process alive and hang the run.
    if (handle) await handle.cancel().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY resize rejects invalid sizes and the session survives', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-resize-bad-'));
  let handle;
  try {
    const provider = createPosixPtyProvider();
    const outputs = [];
    handle = await provider({
      root, argv: ['cat'], cwd: '.', signal: new AbortController().signal,
      onOutput: (value) => outputs.push(value.text),
      onExit: () => {},
    });
    const bad = [[0, 24], [501, 24], [80, 0], [80, 201], [-1, 24], [80.5, 24], ['80', 24], [Number.NaN, 24], [80, undefined], [null, 24]];
    for (const [cols, rows] of bad) {
      await assert.rejects(handle.resize(cols, rows), (error) => error.code === 'PTY_SIZE_INVALID');
    }
    await handle.resize(100, 30);
    await handle.write('still-alive\n');
    await waitFor(() => outputs.join('').includes('still-alive'));
    await handle.cancel();
  } finally {
    if (handle) await handle.cancel().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY resize after close reports PTY_CLOSED', { skip: SKIP }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-resize-closed-'));
  try {
    const provider = createPosixPtyProvider();
    let exitResult;
    const handle = await provider({
      root, argv: ['cat'], cwd: '.', signal: new AbortController().signal,
      onOutput: () => {},
      onExit: (result) => { exitResult = result; },
    });
    await handle.cancel();
    await waitFor(() => exitResult !== undefined);
    await assert.rejects(handle.resize(80, 24), (error) => error.code === 'PTY_CLOSED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PTY helper ignores garbage on fd3 and runs without fd3', { skip: SKIP }, async () => {
  const garbage = spawn('python3', [HELPER, '--', 'cat'], { shell: false, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
  let garbageOut = '';
  garbage.stdout.on('data', (chunk) => { garbageOut += chunk.toString('utf8'); });
  try {
    garbage.stdio[3].write('0 0\n');
    garbage.stdio[3].write('abc\n');
    garbage.stdio[3].write('99999 99999\n');
    garbage.stdio[3].write('-5 10\n');
    garbage.stdio[3].write('80\n');
    garbage.stdio[3].write('80 24 extra\n');
    garbage.stdio[3].write(`${'x'.repeat(200)}\n`);
    garbage.stdio[3].write('80 24\n');
    garbage.stdin.write('alive-after-garbage\n');
    await waitFor(() => garbageOut.includes('alive-after-garbage'));
    assert.equal(garbage.exitCode, null);
  } finally { garbage.kill('SIGKILL'); }

  const noFd3 = spawn('python3', [HELPER, '--', 'cat'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  let noFd3Out = '';
  noFd3.stdout.on('data', (chunk) => { noFd3Out += chunk.toString('utf8'); });
  try {
    noFd3.stdin.write('alive-without-fd3\n');
    await waitFor(() => noFd3Out.includes('alive-without-fd3'));
    assert.equal(noFd3.exitCode, null);
  } finally { noFd3.kill('SIGKILL'); }
});

test('terminal session manager passes resize through to the provider handle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-resize-session-'));
  try {
    // The manager allowlists commands, so a stty loop cannot run through
    // it; real size changes are proven at the provider level above. Here
    // a stub handle proves the passthrough wiring: manager.resize calls
    // handle.resize and returns its size, and provider output still flows.
    let emit;
    const stubProvider = async ({ onOutput }) => {
      emit = onOutput;
      return Object.freeze({
        capabilities: Object.freeze({ pty: true, input: true, incrementalOutput: true }),
        resize: async (cols, rows) => {
          emit({ stream: 'stdout', text: `resized-to ${rows} ${cols}\n` });
          return Object.freeze({ cols, rows });
        },
        cancel: async () => {},
      });
    };
    const manager = createTerminalSessionManager({ root, sessionProvider: stubProvider });
    const created = await manager.create({ argv: ['pwd'], approved: true });
    assert.equal(created.capabilities.pty, true);
    const resized = await manager.resize(created.id, 100, 30);
    assert.deepEqual(resized, { id: created.id, cols: 100, rows: 30 });
    const read = await manager.read(created.id, {});
    assert.ok(read.chunks.map((chunk) => chunk.text).join('').includes('resized-to 30 100'));
    await assert.rejects(manager.resize(created.id, 0, 30), (error) => error.code === 'SIZE_INVALID');
    await manager.cancel(created.id);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('terminal session manager reports resize unavailable without a resize handle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-pty-resize-noprovider-'));
  try {
    const stubProvider = async () => Object.freeze({ capabilities: Object.freeze({ pty: false, input: false, incrementalOutput: false }), cancel: async () => {} });
    const manager = createTerminalSessionManager({ root, sessionProvider: stubProvider });
    const created = await manager.create({ argv: ['pwd'], approved: true });
    await assert.rejects(manager.resize(created.id, 80, 24), (error) => error.code === 'PTY_UNAVAILABLE');
    await assert.rejects(manager.resize(created.id, 0, 24), (error) => error.code === 'SIZE_INVALID');
    await assert.rejects(manager.resize('00000000-0000-0000-0000-000000000000', 80, 24), (error) => error.code === 'SESSION_NOT_FOUND');
    await manager.cancel(created.id);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
