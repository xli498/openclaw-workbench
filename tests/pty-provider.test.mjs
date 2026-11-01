import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createPosixPtyProvider, ptyAvailable } from '../runtime/pty-provider.mjs';
import { createTerminalSessionManager } from '../runtime/terminal-session.mjs';

const SKIP = !ptyAvailable();

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
    let exitResult;
    await provider({
      root, argv: ['/nonexistent-pty-binary-xyz'], cwd: '.',
      onOutput: () => {},
      onExit: (result) => { exitResult = result; },
    });
    await waitFor(() => exitResult !== undefined);
    assert.equal(exitResult.status, 'failed');
    assert.equal(JSON.stringify(exitResult).includes('pty-env-marker-abcdef'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
