import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowsPtyProvider, windowsPtyAvailable } from '../runtime/windows-pty-provider.mjs';

// Linux-only assertions: on non-Windows the provider must refuse with
// PTY_UNAVAILABLE and never fake a pty. The Windows branches (ConPTY
// spawn, write, cancel, resize-unsupported) are NOT covered here and
// must be validated by Windows CI; on Windows these tests skip.
const SKIP = process.platform === 'win32';

test('Windows PTY provider reports unavailable on Linux', { skip: SKIP }, () => {
  assert.equal(windowsPtyAvailable(), false);
});

test('Windows PTY provider refuses on Linux instead of faking a pty', { skip: SKIP }, async () => {
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

test('Windows PTY provider rejects invalid env without reaching the platform check', { skip: SKIP }, () => {
  assert.throws(() => createWindowsPtyProvider({ env: { 'bad key': 'x' } }), (error) => error.code === 'PTY_ENV_INVALID');
});
