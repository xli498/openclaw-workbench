import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWindowsCredentialStore, createMemorySecretBackend, createPowerShellCredentialBackend } from '../runtime/secret-store.mjs';

test('secret store exposes set/get/delete/has without exposing values in metadata', async () => {
  const store = createWindowsCredentialStore({ service: 'openclaw-workbench-test', backend: createMemorySecretBackend() });
  await store.set('provider.primary', 'keychain-secret');
  assert.equal(await store.has('provider.primary'), true);
  assert.equal(await store.get('provider.primary'), 'keychain-secret');
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.delete('provider.primary'), true);
  assert.equal(await store.has('provider.primary'), false);
  assert.equal(await store.delete('provider.primary'), false);
  assert.doesNotMatch(JSON.stringify(store), /keychain-secret/);
});

test('secret store validates service, names, and values without echoing secret material', async () => {
  const store = createWindowsCredentialStore({ service: 'openclaw-workbench-test', backend: createMemorySecretBackend() });
  for (const [method, args] of [
    ['set', ['', 'secret']],
    ['set', ['bad\nname', 'secret']],
    ['set', ['name', '']],
    ['set', ['name', 'line\nbreak']],
    ['get', ['bad\0name']],
    ['has', ['bad/name']],
    ['delete', ['bad/name']],
  ]) {
    await assert.rejects(() => store[method](...args), (error) => {
      assert.equal(error.code, 'SECRET_STORE_INPUT_INVALID');
      assert.doesNotMatch(error.message, /secret|line|break/i);
      return true;
    });
  }
  assert.throws(() => createWindowsCredentialStore({ service: '' }), { code: 'SECRET_STORE_SERVICE_INVALID' });
});

test('secret store rejects values that exceed the Windows credential blob limit', async () => {
  const store = createWindowsCredentialStore({ service: 'openclaw-workbench-test', backend: createMemorySecretBackend() });
  await store.set('maximum', 'a'.repeat(1280));
  await assert.rejects(() => store.set('too-large', 'a'.repeat(1281)), { code: 'SECRET_STORE_INPUT_INVALID' });
  assert.equal(await store.has('too-large'), false);
});

test('memory backend is injectable and isolated per store', async () => {
  const backend = createMemorySecretBackend();
  const first = createWindowsCredentialStore({ service: 'a', backend });
  const second = createWindowsCredentialStore({ service: 'b', backend });
  await first.set('same', 'one');
  await second.set('same', 'two');
  assert.equal(await first.get('same'), 'one');
  assert.equal(await second.get('same'), 'two');
});

test('memory backend keeps service/name namespaces isolated and does not expose its map', async () => {
  const backend = createMemorySecretBackend();
  await backend.set('service-a', 'same', 'alpha-secret');
  await backend.set('service-b', 'same', 'beta-secret');
  assert.equal(await backend.get('service-a', 'same'), 'alpha-secret');
  assert.equal(await backend.get('service-b', 'same'), 'beta-secret');
  assert.equal(await backend.has('service-a', 'missing'), false);
  assert.equal(await backend.delete('service-a', 'same'), true);
  assert.equal(await backend.get('service-a', 'same'), null);
  assert.equal(await backend.get('service-b', 'same'), 'beta-secret');
  assert.doesNotMatch(String(backend), /alpha-secret|beta-secret/);
  assert.deepEqual(Object.keys(backend).sort(), ['delete', 'get', 'has', 'set']);
});

test('PowerShell backend uses fixed helper operations and never places secret in command arguments', async () => {
  const calls = [];
  const backend = createPowerShellCredentialBackend({
    platform: 'win32',
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      const payload = JSON.parse(options.input);
      return { stdout: JSON.stringify({ ok: true, found: payload.op === 'get', value: 'hidden-value' }), stderr: '' };
    },
  });
  const store = createWindowsCredentialStore({ service: 'svc', backend });
  await store.set('provider', 'hidden-value');
  assert.equal(await store.get('provider'), 'hidden-value');
  assert.equal(await store.delete('provider'), false);
  assert.equal(calls.length, 3);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.file.toLowerCase().endsWith('powershell.exe'), true);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.inputEncoding, 'utf8');
    assert.equal(call.args.includes('hidden-value'), false);
    assert.equal(call.args.includes('svc'), false);
    const payload = JSON.parse(call.options.input);
    assert.equal(payload.op, ['set', 'get', 'delete'][index]);
    assert.equal(payload.service, 'svc');
    assert.equal(payload.name, 'provider');
    assert.equal(payload.value, index === 0 ? 'hidden-value' : undefined);
  }
});

test('PowerShell backend transport supplies JSON through stdin and closes the stream', async () => {
  const calls = [];
  const backend = createPowerShellCredentialBackend({
    platform: 'win32',
    spawnImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  await backend.set('svc', 'provider', 'hidden-value');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file.toLowerCase().endsWith('powershell.exe'), true);
  assert.equal(calls[0].options.inputEncoding, 'utf8');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(JSON.parse(calls[0].options.input).value, 'hidden-value');
  assert.equal(calls[0].args.includes('hidden-value'), false);
});

test('PowerShell backend converts helper failures to a safe error without echoing secret material', async () => {
  const secret = 'windows-helper-secret-marker';
  const backend = createPowerShellCredentialBackend({
    platform: 'win32',
    execFileImpl: async (_file, _args, options) => {
      assert.equal(JSON.parse(options.input).value, secret);
      throw Object.assign(new Error(`native helper leaked ${secret}`), {
        stdout: `stdout ${secret}`,
        stderr: `stderr ${secret}`,
      });
    },
  });
  await assert.rejects(() => backend.set('svc', 'provider', secret), (error) => {
    assert.equal(error.code, 'SECRET_STORE_BACKEND_FAILED');
    assert.equal(error.message, 'secret store operation failed');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    return true;
  });
});

test('PowerShell backend rejects malformed helper output without exposing response values', async () => {
  const secret = 'malformed-output-secret-marker';
  const backend = createPowerShellCredentialBackend({
    platform: 'win32',
    execFileImpl: async () => ({ stdout: `not-json ${secret}`, stderr: `diagnostic ${secret}` }),
  });
  await assert.rejects(() => backend.get('svc', 'provider'), (error) => {
    assert.equal(error.code, 'SECRET_STORE_BACKEND_FAILED');
    assert.equal(error.message, 'secret store operation failed');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    return true;
  });
});

test('real Windows Credential Manager roundtrip persists Unicode values and cleans up', { skip: process.platform !== 'win32' }, async (t) => {
  const service = `openclaw-workbench-it-${randomUUID().slice(0, 12)}`;
  const name = 'unicode';
  const secret = `测试-${randomUUID()}-安全值`;
  const store = createWindowsCredentialStore({ service, platform: 'win32' });
  t.after(async () => { await store.delete(name); });
  await store.set(name, secret);
  assert.equal(await store.has(name), true);
  assert.equal(await store.get(name), secret);
  assert.equal(await store.delete(name), true);
  assert.equal(await store.get(name), null);
  assert.equal(await store.has(name), false);
});
