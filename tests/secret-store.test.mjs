import test from 'node:test';
import assert from 'node:assert/strict';
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

test('memory backend is injectable and isolated per store', async () => {
  const backend = createMemorySecretBackend();
  const first = createWindowsCredentialStore({ service: 'a', backend });
  const second = createWindowsCredentialStore({ service: 'b', backend });
  await first.set('same', 'one');
  await second.set('same', 'two');
  assert.equal(await first.get('same'), 'one');
  assert.equal(await second.get('same'), 'two');
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
