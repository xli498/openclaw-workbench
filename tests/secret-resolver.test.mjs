import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretResolver, SecretResolverError, parseSecretRef } from '../runtime/secret-resolver.mjs';

test('SecretRef 只解析受控 env 和抽象 keychain 引用', async () => {
  const resolver = createSecretResolver({ env: { OPENAI_KEY: 'secret-value' }, keychainProvider: async (name) => name === 'provider.primary' ? 'keychain-secret' : null });
  assert.equal(await resolver.resolve('env:OPENAI_KEY'), 'secret-value');
  assert.equal(await resolver.resolve('keychain:provider.primary'), 'keychain-secret');
  assert.deepEqual(parseSecretRef('env:OPENAI_KEY'), { kind: 'env', name: 'OPENAI_KEY' });
  assert.deepEqual(parseSecretRef('keychain:provider.primary'), { kind: 'keychain', name: 'provider.primary' });
});

test('SecretRef 缺失和格式错误返回结构化错误且不泄露值', async () => {
  const secret = 'ultra-secret-should-not-appear';
  const resolver = createSecretResolver({ env: {}, keychainProvider: async () => null });
  for (const ref of ['env:MISSING_KEY', 'keychain:missing', 'actual-secret-value', 'env:BAD-NAME', 'env:']) {
    await assert.rejects(() => resolver.resolve(ref), (error) => {
      assert.ok(error instanceof SecretResolverError);
      assert.equal(typeof error.code, 'string');
      assert.equal(JSON.stringify(error), JSON.stringify(error).replace(secret, '[redacted]'));
      assert.doesNotMatch(error.message, /MISSING_KEY|actual-secret-value|ultra-secret-should-not-appear/i);
      return true;
    });
  }
});

test('SecretRef 阻断控制字符、空值和超长解析结果', async () => {
  const resolver = createSecretResolver({ env: { EMPTY: '', NEWLINE: 'a\nb', HUGE: 'x'.repeat(8193) } });
  for (const ref of ['env:EMPTY', 'env:NEWLINE', 'env:HUGE', 'env:bad\nname']) {
    await assert.rejects(() => resolver.resolve(ref), { name: 'SecretResolverError' });
  }
  assert.throws(() => createSecretResolver({ keychainProvider: 'not-a-function' }), { code: 'SECRET_PROVIDER_INVALID' });
  assert.throws(() => parseSecretRef('env:BAD-NAME'), { code: 'SECRET_REF_INVALID' });
});
