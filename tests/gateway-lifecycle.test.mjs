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
