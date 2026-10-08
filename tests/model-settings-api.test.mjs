import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('模型登记提案重启后可列出并明确取消，同时清理未被档案引用的密钥', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-proposal-recovery-'));
  const values = new Map();
  const secretStore = {
    async set(name, value) { values.set(name, value); },
    async get(name) { return values.get(name) ?? null; },
    async has(name) { return values.has(name); },
    async delete(name) { return values.delete(name); },
  };
  const options = { root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore };
  let app = createWorkbenchServer(options);
  let address = await app.listen();
  let proposal;
  try {
    assert.equal((await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.recovery', value: 'orphan-secret' }) })).status, 200);
    proposal = (await request(address, '/v1/models', { method: 'POST', body: JSON.stringify({ sessionId: 'recovery', id: 'recovery', provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text'], secretRef: 'keychain:workbench.model.recovery' }) })).body.proposal;
  } finally { await app.close(); }

  app = createWorkbenchServer(options);
  address = await app.listen();
  try {
    const listed = await request(address, '/v1/models/proposals');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.proposals.length, 1);
    assert.equal(listed.body.proposals[0].action.id, proposal.action.id);
    assert.equal(listed.body.proposals[0].action.status, 'manual_review');
    assert.equal(listed.body.proposals[0].recovery.reason, 'restarted_before_terminal');

    const replay = await request(address, `/v1/models/${proposal.action.id}/approve`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: proposal.action.actionHash }),
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, 'MODEL_PROPOSAL_MANUAL_REVIEW');

    const cancelled = await request(address, `/v1/models/${proposal.action.id}/cancel`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: proposal.action.actionHash }),
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.action.status, 'cancelled');
    assert.equal(cancelled.body.secretCleanup, 'deleted');
    assert.equal(values.has('workbench.model.recovery'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('重启后的模型启用和停用提案只能人工取消，取消不会改变当前档案状态', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-toggle-recovery-'));
  const options = { root, token: 'test-token-012345', approvalToken: 'approve-token-012345' };
  let app = createWorkbenchServer(options);
  let address = await app.listen();
  let profile;
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle', id: 'toggle', provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text'], secretRef: 'env:TOGGLE_MODEL_KEY' }) });
    const registered = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    profile = registered.body.profile;
    const enabled = await request(address, '/v1/models/toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle', configHash: profile.configHash }) });
    assert.equal(enabled.status, 201);
    await app.close();

    app = createWorkbenchServer(options);
    address = await app.listen();
    const pendingEnable = (await request(address, '/v1/models/proposals')).body.proposals.find((item) => item.action.id === enabled.body.proposal.action.id);
    assert.equal(pendingEnable.action.status, 'manual_review');
    const cancelEnable = await request(address, `/v1/models/${enabled.body.proposal.action.id}/cancel`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) });
    assert.equal(cancelEnable.status, 200);
    assert.equal((await request(address, '/v1/models')).body.models.find((item) => item.id === 'toggle').enabled, false);

    const enableAgain = await request(address, '/v1/models/toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle', configHash: profile.configHash }) });
    const enabledAgain = await request(address, `/v1/models/${enableAgain.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: enableAgain.body.proposal.action.actionHash }) });
    assert.equal(enabledAgain.body.profile.enabled, true);
    const disable = await request(address, '/v1/models/toggle/disable', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle', configHash: enabledAgain.body.profile.configHash }) });
    await app.close();

    app = createWorkbenchServer(options);
    address = await app.listen();
    const pendingDisable = (await request(address, '/v1/models/proposals')).body.proposals.find((item) => item.action.id === disable.body.proposal.action.id);
    assert.equal(pendingDisable.action.status, 'manual_review');
    const cancelDisable = await request(address, `/v1/models/${disable.body.proposal.action.id}/cancel`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: disable.body.proposal.action.actionHash }) });
    assert.equal(cancelDisable.status, 200);
    assert.equal((await request(address, '/v1/models')).body.models.find((item) => item.id === 'toggle').enabled, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('重启后的人工复核模型提案不占用 64 项可执行提案上限', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-proposal-limit-recovery-'));
  const options = { root, token: 'test-token-012345', approvalToken: 'approve-token-012345' };
  const workbenchDir = path.join(root, '.openclaw-workbench');
  await mkdir(workbenchDir, { recursive: true });
  await writeFile(path.join(workbenchDir, 'model-proposals.json'), JSON.stringify({
    version: 2,
    proposals: Array.from({ length: 64 }, (_, index) => ({
      proposal: {
        action: { id: `recovered-${index}`, type: 'model.register', sessionId: 'limit', status: 'awaiting_approval', actionHash: `hash-${index}`, createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' },
        profile: { id: `recovered-${index}`, secretRef: `env:PENDING_MODEL_${index}` },
      },
    })),
  }));
  const app = createWorkbenchServer(options);
  const address = await app.listen();
  try {
    const before = await request(address, '/v1/models/proposals');
    assert.equal(before.body.proposals.filter((item) => item.action.status === 'manual_review').length, 64);
    const next = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify({ sessionId: 'limit', id: 'pending-after-restart', provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text'], secretRef: 'env:PENDING_MODEL_AFTER_RESTART' }) });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    const listed = await request(address, '/v1/models/proposals');
    assert.equal(listed.body.proposals.length, 65);
    assert.equal(listed.body.proposals.filter((item) => item.action.status === 'manual_review').length, 64);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('共享同一 keychain 引用的待处理模型提案不会互相清理密钥', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-proposal-shared-secret-'));
  const values = new Map();
  const secretStore = {
    async set(name, value) { values.set(name, value); },
    async get(name) { return values.get(name) ?? null; },
    async has(name) { return values.has(name); },
    async delete(name) { return values.delete(name); },
  };
  const options = { root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore };
  const app = createWorkbenchServer(options);
  const address = await app.listen();
  const requestModel = (id) => request(address, '/v1/models', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'shared-secret', id, provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text'], secretRef: 'keychain:workbench.model.shared' }),
  });
  try {
    assert.equal((await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.shared', value: 'shared-secret' }) })).status, 200);
    const first = (await requestModel('shared-first')).body.proposal;
    const second = (await requestModel('shared-second')).body.proposal;

    const cancelledFirst = await request(address, `/v1/models/${first.action.id}/cancel`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: first.action.actionHash }),
    });
    assert.equal(cancelledFirst.status, 200);
    assert.equal(cancelledFirst.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.shared'), true);

    const cancelledSecond = await request(address, `/v1/models/${second.action.id}/cancel`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: second.action.actionHash }),
    });
    assert.equal(cancelledSecond.status, 200);
    assert.equal(cancelledSecond.body.secretCleanup, 'deleted');
    assert.equal(values.has('workbench.model.shared'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
