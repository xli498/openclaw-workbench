import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayLifecycle } from '../runtime/gateway-lifecycle.mjs';

test('Gateway lifecycle probe reports a fake CLI version and redacts secret-like output', async () => {
  const lifecycle = createGatewayLifecycle({
    cliCommand: 'openclaw',
    spawnFn: async () => ({ code: 0, stdout: 'openclaw 1.2.3 token=should-not-leak\nsecond line\n' }),
  });
  const probe = await lifecycle.probe();
  assert.equal(probe.available, true);
  assert.equal(probe.version.includes('should-not-leak'), false);
  assert.match(probe.version, /^openclaw 1\.2\.3/);
  assert.equal(lifecycle.getState(), 'probed');
});

test('Gateway lifecycle probe distinguishes a missing CLI from a failed probe', async () => {
  const missing = createGatewayLifecycle({ spawnFn: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } });
  assert.deepEqual(await missing.probe(), { available: false, cli: 'openclaw', code: 'CLI_NOT_FOUND' });
  const failed = createGatewayLifecycle({ spawnFn: async () => ({ code: 1, stdout: '' }) });
  assert.deepEqual(await failed.probe(), { available: false, cli: 'openclaw', code: 'GATEWAY_PROBE_FAILED' });
});

test('Gateway lifecycle start refuses without a verified injected adapter and delegates with one', async () => {
  const refused = createGatewayLifecycle({ spawnFn: async () => ({ code: 0, stdout: 'openclaw 1.0.0' }) });
  await assert.rejects(refused.start(), (error) => error.code === 'GATEWAY_LIFECYCLE_NOT_IMPLEMENTED');
  let started = 0;
  const injected = createGatewayLifecycle({
    channelAdapter: { start: async () => { started += 1; return { status: 'ready', injected: true }; }, stop: async () => {} },
  });
  assert.deepEqual(await injected.start(), { status: 'ready', injected: true });
  assert.equal(started, 1);
  assert.deepEqual(await injected.stop(), { status: 'stopped' });
});

test('Gateway lifecycle real probe never throws and never guesses a protocol', async () => {
  const lifecycle = createGatewayLifecycle();
  const probe = await lifecycle.probe();
  assert.equal(probe.cli, 'openclaw');
  assert.equal(typeof probe.available, 'boolean');
  if (!probe.available) assert.ok(['CLI_NOT_FOUND', 'GATEWAY_PROBE_FAILED'].includes(probe.code));
  await assert.rejects(lifecycle.start(), (error) => error.code === 'GATEWAY_LIFECYCLE_NOT_IMPLEMENTED');
});

import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeMockCli(body) {
  const dir = await mkdtemp(join(tmpdir(), 'wb3-gw-mock-cli-'));
  // POSIX: a shebang script spawned directly (shell:false) works. Windows
  // does not honor shebangs, and spawning an extensionless script fails,
  // which is exactly the regression this helper used to carry into
  // Windows CI (WB3-gw): the mock must be a .cmd shim that runs the same
  // Node body, because the lifecycle probe spawns one command path with
  // shell:false on every platform.
  if (process.platform === 'win32') {
    const scriptPath = join(dir, 'openclaw-mock.mjs');
    await writeFile(scriptPath, `${body}\n`, 'utf8');
    const cliPath = join(dir, 'openclaw.cmd');
    await writeFile(cliPath, `@echo off\r\nnode "%~dp0openclaw-mock.mjs" %*\r\n`, 'utf8');
    return { dir, cliPath };
  }
  const cliPath = join(dir, 'openclaw');
  await writeFile(cliPath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  await chmod(cliPath, 0o755);
  return { dir, cliPath };
}

test('Gateway lifecycle real spawn path probes a mock CLI script (shell:false, first line, redaction)', async () => {
  const { dir, cliPath } = await makeMockCli(
    `console.log('openclaw 2026.10.9'); console.log('token=should-not-leak');`,
  );
  try {
    const lifecycle = createGatewayLifecycle({ cliCommand: cliPath });
    const probe = await lifecycle.probe();
    assert.equal(probe.available, true);
    assert.equal(probe.version, 'openclaw 2026.10.9');
    assert.equal(probe.version.includes('should-not-leak'), false);
    assert.equal(lifecycle.getState(), 'probed');
    assert.equal(lifecycle.getCli(), cliPath);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gateway lifecycle real spawn path reports a non-zero mock CLI as a failed probe', async () => {
  const { dir, cliPath } = await makeMockCli(`console.error('boom'); process.exit(3);`);
  try {
    const lifecycle = createGatewayLifecycle({ cliCommand: cliPath });
    const probe = await lifecycle.probe();
    assert.deepEqual(probe, { available: false, cli: cliPath, code: 'GATEWAY_PROBE_FAILED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gateway lifecycle real spawn path times out a hanging mock CLI instead of hanging', async () => {
  const { dir, cliPath } = await makeMockCli(`setTimeout(() => {}, 10000);`);
  try {
    const lifecycle = createGatewayLifecycle({ cliCommand: cliPath, probeTimeoutMs: 300 });
    const probe = await lifecycle.probe();
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'GATEWAY_PROBE_FAILED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gateway lifecycle real spawn path caps mock CLI output instead of buffering it all', async () => {
  const { dir, cliPath } = await makeMockCli(`process.stdout.write('x'.repeat(10000));`);
  try {
    const lifecycle = createGatewayLifecycle({ cliCommand: cliPath, maxOutputBytes: 64 });
    const probe = await lifecycle.probe();
    assert.equal(probe.available, false);
    assert.equal(probe.code, 'GATEWAY_PROBE_FAILED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Gateway lifecycle rejects invalid CLI commands and adapters, and stop without an adapter still reports stopped', async () => {
  assert.throws(() => createGatewayLifecycle({ cliCommand: 'openclaw; rm -rf /' }), (error) => error.code === 'GATEWAY_CLI_INVALID');
  assert.throws(() => createGatewayLifecycle({ channelAdapter: {} }), (error) => error.code === 'GATEWAY_ADAPTER_INVALID');
  const lifecycle = createGatewayLifecycle({ spawnFn: async () => ({ code: 0, stdout: 'openclaw 1.0.0' }) });
  await lifecycle.probe();
  await assert.rejects(lifecycle.start(), (error) => error.code === 'GATEWAY_LIFECYCLE_NOT_IMPLEMENTED');
  assert.deepEqual(await lifecycle.stop(), { status: 'stopped' });
  assert.equal(lifecycle.getState(), 'disconnected');
  assert.equal(lifecycle.getLastProbe().available, true);
});

test('Gateway lifecycle start passes arguments through to an injected adapter and stop calls its stop', async () => {
  const seen = [];
  const adapter = {
    start: async (...args) => { seen.push(['start', ...args]); return { status: 'ready' }; },
    stop: async (...args) => { seen.push(['stop', ...args]); },
  };
  const lifecycle = createGatewayLifecycle({ channelAdapter: adapter });
  assert.deepEqual(await lifecycle.start('arg-a', { flag: true }), { status: 'ready' });
  assert.equal(lifecycle.getState(), 'ready');
  assert.deepEqual(await lifecycle.stop('arg-b'), { status: 'stopped' });
  assert.deepEqual(seen, [['start', 'arg-a', { flag: true }], ['stop', 'arg-b']]);
});
