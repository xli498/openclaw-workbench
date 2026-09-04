import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createModelRegistry, ModelRegistryError } from '../runtime/model-registry.mjs';

function profile(overrides = {}) {
  return { id: 'primary', provider: 'acme', protocol: 'openai-compatible', model: 'acme-large', endpoint: 'https://api.example.test/v1', capabilities: ['text', 'tool_calling'], secretRef: 'env:ACME_API_KEY', ...overrides };
}

test('模型档案只保存元数据且默认禁用，重启可恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-registry-'));
  try {
    const registry = createModelRegistry({ root });
    const created = registry.register(profile());
    assert.equal(created.enabled, false);
    assert.equal(created.secretRef, 'env:ACME_API_KEY');
    assert.equal('apiKey' in created, false);
    assert.equal(created.health.status, 'unknown');
    assert.deepEqual(createModelRegistry({ root }).get('primary'), created);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('模型档案拒绝凭据 endpoint、敏感 query、协议注入和 secret 值', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-invalid-'));
  try {
    const registry = createModelRegistry({ root });
    for (const endpoint of ['https://user:pass@example.test/v1', 'https://example.test/v1?apikey=secret', 'https://example.test/v1?clientsecret=secret']) assert.throws(() => registry.validate(profile({ endpoint })), { code: 'MODEL_ENDPOINT_INVALID' });
    assert.throws(() => registry.validate(profile({ protocol: 'javascript:alert(1)' })), { code: 'MODEL_PROTOCOL_INVALID' });
    assert.throws(() => registry.validate(profile({ secretRef: 'actual-secret-value' })), { code: 'MODEL_SECRET_REF_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('模型档案拒绝重复 ID、未知能力和重复能力', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-duplicate-'));
  try {
    const registry = createModelRegistry({ root });
    registry.register(profile());
    assert.throws(() => registry.register(profile()), { code: 'MODEL_DUPLICATE' });
    assert.throws(() => registry.validate(profile({ capabilities: ['text', 'unknown'] })), { code: 'MODEL_CAPABILITIES_INVALID' });
    assert.throws(() => registry.validate(profile({ capabilities: ['text', 'text'] })), { code: 'MODEL_CAPABILITIES_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
