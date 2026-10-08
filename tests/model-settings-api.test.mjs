import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { SecretStoreError } from '../runtime/secret-store.mjs';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-012345', ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

test('模型设置 API 只保存 keychain 引用并支持连接测试', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-settings-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async delete(name) { values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore, modelHealthProbe: async () => ({ status: 'ready', checkedAt: '2026-10-07T00:00:00.000Z' }) });
  const address = await app.listen();
  try {
    const saved = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'api-secret-value' }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.configured, true);
    const proposal = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify({ sessionId: 'settings', id: 'primary', provider: 'local', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text', 'tool_calling'], secretRef: 'keychain:workbench.model.primary' }) });
    assert.equal(proposal.status, 201);
    assert.equal(JSON.stringify(proposal.body).includes('api-secret-value'), false);
    const approved = await request(address, `/v1/models/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.profile.secretRef, 'keychain:workbench.model.primary');
    const enabled = await request(address, `/v1/models/primary/enable`, { method: 'POST', body: JSON.stringify({ sessionId: 'settings', configHash: approved.body.profile.configHash }) });
    assert.equal(enabled.status, 201);
    await request(address, `/v1/models/${enabled.body.proposal.action.target}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) });
    const health = await request(address, '/v1/models/primary/health', { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: (await request(address, '/v1/models')).body.models[0].configHash }) });
    assert.equal(health.status, 200);
    assert.equal(health.body.health.status, 'ready');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('密钥同名写入默认拒绝覆盖，避免旧模型静默换 Key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-secret-conflict-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const first = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'first-secret' }) });
    assert.equal(first.status, 200);
    const second = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'replacement-secret' }) });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'SECRET_ALREADY_CONFIGURED');
    assert.equal(values.get('workbench.model.primary'), 'first-secret');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('密钥覆盖和删除必须使用独立审批凭据，并写入脱敏审计', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-secret-approval-'));
  const values = new Map();
  const auditEvents = [];
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore, audit: { async append(event) { auditEvents.push(event); }, async list() { return auditEvents; } } });
  const address = await app.listen();
  try {
    assert.equal((await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'first-secret' }) })).status, 200);
    const overwriteWithoutApproval = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'replacement-secret', overwrite: true }) });
    assert.equal(overwriteWithoutApproval.status, 403);
    assert.equal(overwriteWithoutApproval.body.error, 'APPROVAL_AUTH_REQUIRED');
    const overwrite = await request(address, '/v1/secrets', { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ name: 'workbench.model.primary', value: 'replacement-secret', overwrite: true }) });
    assert.equal(overwrite.status, 200);
    assert.equal(values.get('workbench.model.primary'), 'replacement-secret');
    const deleteWithoutApproval = await request(address, '/v1/secrets/workbench.model.primary', { method: 'DELETE' });
    assert.equal(deleteWithoutApproval.status, 403);
    const deleted = await request(address, '/v1/secrets/workbench.model.primary', { method: 'DELETE', headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(deleted.status, 200);
    assert.equal(values.has('workbench.model.primary'), false);
    assert.deepEqual(auditEvents.map((event) => event.type), ['secret.configured', 'secret.configured', 'secret.deleted']);
    assert.equal(JSON.stringify(auditEvents).includes('replacement-secret'), false);
    assert.equal(JSON.stringify(auditEvents).includes('first-secret'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('secret store validation errors return a structured client error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-secret-validation-'));
  const secretStore = { async set() { throw new SecretStoreError('SECRET_STORE_INPUT_INVALID', 'store input is invalid'); }, async get() { return null; }, async has() { return false; }, async delete() { return false; } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const result = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'bad-value' }) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'SECRET_STORE_INPUT_INVALID');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
