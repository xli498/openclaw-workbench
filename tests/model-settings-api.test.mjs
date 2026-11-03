import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { SecretStoreError } from '../runtime/secret-store.mjs';
import { secretActionHash } from '../runtime/secret-action.mjs';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-012345', ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}


// Q24-2 helpers: every secret change carries the actionHash for its
// operation, target, and current existence version (see
// runtime/secret-action.mjs). `version` is what the caller observed
// via GET /v1/secrets/<name> (`configured`): 'absent' before the first
// write, 'present' once the backend reports the secret.
async function saveSecret(address, name, value, { overwrite = false, version = 'absent', approval = false } = {}) {
  return request(address, '/v1/secrets', {
    method: 'POST',
    ...(approval ? { headers: { 'x-approval-token': 'approve-token-012345' } } : {}),
    body: JSON.stringify({ name, value, ...(overwrite ? { overwrite: true } : {}), actionHash: secretActionHash({ operation: overwrite ? 'overwrite' : 'create', name, version }) }),
  });
}
async function deleteSecret(address, name, { version = 'present', approval = true } = {}) {
  return request(address, `/v1/secrets/${name}`, {
    method: 'DELETE',
    ...(approval ? { headers: { 'x-approval-token': 'approve-token-012345' } } : {}),
    body: JSON.stringify({ actionHash: secretActionHash({ operation: 'delete', name, version }) }),
  });
}
async function createModelProposal(address, sessionId, id, secretName) {
  return request(address, '/v1/models', {
    method: 'POST',
    body: JSON.stringify({ sessionId, id, provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text'], secretRef: `keychain:${secretName}` }),
  });
}
async function cancelModelProposal(address, proposal) {
  return request(address, `/v1/models/${proposal.action.id}/cancel`, {
    method: 'POST',
    headers: { 'x-approval-token': 'approve-token-012345' },
    body: JSON.stringify({ actionHash: proposal.action.actionHash }),
  });
}

test('模型设置 API 只保存 keychain 引用并支持连接测试', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-settings-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async delete(name) { values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore, modelHealthProbe: async () => ({ status: 'ready', checkedAt: '2026-10-07T00:00:00.000Z' }) });
  const address = await app.listen();
  try {
    const saved = await saveSecret(address, 'workbench.model.primary', 'api-secret-value');
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
    const enableApproved = await request(address, `/v1/models/${enabled.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) });
    assert.equal(enableApproved.status, 200);
    assert.equal(enableApproved.body.profile.enabled, true);
    assert.equal((await request(address, '/v1/models')).body.models.find((item) => item.id === 'primary').enabled, true);
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
    const first = await saveSecret(address, 'workbench.model.primary', 'first-secret');
    assert.equal(first.status, 200);
    const second = await saveSecret(address, 'workbench.model.primary', 'replacement-secret', { version: 'present' });
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
    assert.equal((await saveSecret(address, 'workbench.model.primary', 'first-secret')).status, 200);
    const overwriteWithoutApproval = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.primary', value: 'replacement-secret', overwrite: true }) });
    assert.equal(overwriteWithoutApproval.status, 403);
    assert.equal(overwriteWithoutApproval.body.error, 'APPROVAL_AUTH_REQUIRED');
    // Q24-2: approval alone is not enough; a change without a valid
    // actionHash for its operation/target/version is rejected.
    const overwriteWithApprovalNoHash = await request(address, '/v1/secrets', { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ name: 'workbench.model.primary', value: 'replacement-secret', overwrite: true }) });
    assert.equal(overwriteWithApprovalNoHash.status, 409);
    assert.equal(overwriteWithApprovalNoHash.body.error, 'SECRET_ACTION_HASH_MISMATCH');
    assert.equal(values.get('workbench.model.primary'), 'first-secret');
    const overwrite = await saveSecret(address, 'workbench.model.primary', 'replacement-secret', { overwrite: true, version: 'present', approval: true });
    assert.equal(overwrite.status, 200);
    assert.equal(values.get('workbench.model.primary'), 'replacement-secret');
    const deleteWithoutApproval = await request(address, '/v1/secrets/workbench.model.primary', { method: 'DELETE' });
    assert.equal(deleteWithoutApproval.status, 403);
    const deleteWithApprovalNoHash = await request(address, '/v1/secrets/workbench.model.primary', { method: 'DELETE', headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(deleteWithApprovalNoHash.status, 409);
    assert.equal(deleteWithApprovalNoHash.body.error, 'SECRET_ACTION_HASH_MISMATCH');
    assert.equal(values.has('workbench.model.primary'), true);
    const deleted = await deleteSecret(address, 'workbench.model.primary');
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
    const result = await saveSecret(address, 'workbench.model.primary', 'bad-value');
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'SECRET_STORE_INPUT_INVALID');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型登记提案重启后可列出并明确取消，但重启后归属版本未知故保留密钥', async () => {
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
    assert.equal((await saveSecret(address, 'workbench.model.recovery', 'orphan-secret')).status, 200);
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
    // Q24-5: the proposal carries attribution, but the restart wiped
    // this server's in-memory version counter, so the current version
    // is unknown and cleanup retains instead of claiming the secret
    // is orphaned. Manual deletion via DELETE /v1/secrets remains.
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.recovery'), true);
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
    assert.equal((await saveSecret(address, 'workbench.model.shared', 'shared-secret')).status, 200);
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

    // wb10 #56 Q3 ("unknown -> retained" convergence): even the last
    // same-server referrer no longer auto-deletes, because same-server
    // gates cannot prove exclusive creation across workspaces (another
    // workspace's reference is invisible here). Manual deletion via
    // DELETE /v1/secrets remains the deletion path.
    const cancelledSecond = await request(address, `/v1/models/${second.action.id}/cancel`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: second.action.actionHash }),
    });
    assert.equal(cancelledSecond.status, 200);
    assert.equal(cancelledSecond.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.shared'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-2: 不带或带错误 actionHash 的密钥创建、覆盖、删除均被拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-hash-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const noHash = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.hash', value: 'v1' }) });
    assert.equal(noHash.status, 409);
    assert.equal(noHash.body.error, 'SECRET_ACTION_HASH_MISMATCH');
    assert.equal(values.has('workbench.model.hash'), false);
    const wrongOp = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.hash', value: 'v1', actionHash: secretActionHash({ operation: 'overwrite', name: 'workbench.model.hash', version: 'absent' }) }) });
    assert.equal(wrongOp.status, 409);
    const wrongTarget = await saveSecret(address, 'workbench.model.other', 'v1');
    assert.equal(wrongTarget.status, 200);
    const staleVersion = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.other', value: 'v2', overwrite: true, actionHash: secretActionHash({ operation: 'overwrite', name: 'workbench.model.other', version: 'absent' }) }), headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(staleVersion.status, 409);
    assert.equal(values.get('workbench.model.other'), 'v1');
    const deleteWrongVersion = await deleteSecret(address, 'workbench.model.other', { version: 'absent' });
    assert.equal(deleteWrongVersion.status, 409);
    assert.equal(values.has('workbench.model.other'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-2: 并发创建同一密钥时恰好一个成功，另一个因版本变化被拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-concurrent-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const [first, second] = await Promise.all([
      saveSecret(address, 'workbench.model.race', 'race-first'),
      saveSecret(address, 'workbench.model.race', 'race-second'),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(['race-first', 'race-second'].includes(values.get('workbench.model.race')), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-2: 密钥后端 503 时创建失败且不产生可用的归属版本', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-503-'));
  const secretStore = {
    async set() { throw new SecretStoreError('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); },
    async get() { return null; },
    async has() { return false; },
    async delete() { return false; },
  };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const result = await saveSecret(address, 'workbench.model.backend', 'backend-secret');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'SECRET_STORE_BACKEND_FAILED');
    const configured = await request(address, '/v1/secrets/workbench.model.backend');
    assert.equal(configured.body.configured, false);
    assert.equal(JSON.stringify(result.body).includes('backend-secret'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-5: 已登记档案引用的密钥在另一提案取消时保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-registry-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    assert.equal((await saveSecret(address, 'workbench.model.registered', 'registered-secret')).status, 200);
    const first = (await createModelProposal(address, 'registry', 'registered', 'workbench.model.registered')).body.proposal;
    const approved = await request(address, `/v1/models/${first.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: first.action.actionHash }) });
    assert.equal(approved.status, 200);
    const second = (await createModelProposal(address, 'registry', 'registered-second', 'workbench.model.registered')).body.proposal;
    const cancelled = await cancelModelProposal(address, second);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.registered'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-5: 跨工作区共享的密钥在本工作区提案取消时保留', async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'ocw-secret-xws-a-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'ocw-secret-xws-b-'));
  // One shared backend, as when two workspaces share the default
  // credential service: workspace A created the secret, workspace B
  // only references it and therefore has no attribution for it.
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const appA = createWorkbenchServer({ root: rootA, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const appB = createWorkbenchServer({ root: rootB, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const addressA = await appA.listen();
  const addressB = await appB.listen();
  try {
    assert.equal((await saveSecret(addressA, 'workbench.model.cross', 'cross-secret')).status, 200);
    const proposal = (await createModelProposal(addressB, 'cross', 'cross', 'workbench.model.cross')).body.proposal;
    const cancelled = await cancelModelProposal(addressB, proposal);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.cross'), true);
  } finally { await appA.close(); await appB.close(); await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); }
});

test('Q24-5: 并发新引用在清理检查前登记时清理保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-concurrent-ref-'));
  const values = new Map();
  // wb10 #56 Q3: the old version of this test only fired one HTTP
  // request before the other, which does not guarantee which request
  // takes the server's secret lock first. This version fixes the lock
  // order with a barrier: the second proposal's attribution snapshot
  // (which runs inside the secret lock and calls backend `has`) blocks
  // until the test releases it, so the cancel provably queues behind
  // the snapshot instead of racing it.
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  let snapshotEntered;
  const snapshotEnteredPromise = new Promise((resolve) => { snapshotEntered = resolve; });
  let gateArmed = false;
  let gateUsed = false;
  const secretStore = {
    async set(name, value) { values.set(name, value); },
    async get(name) { return values.get(name) ?? null; },
    async has(name) {
      if (gateArmed && !gateUsed && name === 'workbench.model.concurrent') {
        gateUsed = true;
        snapshotEntered();
        await snapshotGate;
      }
      return values.has(name);
    },
    async delete(name) { return values.delete(name); },
  };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    assert.equal((await saveSecret(address, 'workbench.model.concurrent', 'concurrent-secret')).status, 200);
    const first = (await createModelProposal(address, 'concurrent', 'concurrent-first', 'workbench.model.concurrent')).body.proposal;
    gateArmed = true;
    const createdPromise = createModelProposal(address, 'concurrent', 'concurrent-second', 'workbench.model.concurrent');
    await snapshotEnteredPromise;
    const cancelledPromise = cancelModelProposal(address, first);
    // The cancel cannot resolve while the snapshot holds the lock:
    // it must still be waiting after a scheduling delay, proving the
    // order is snapshot-before-cleanup rather than fire-order luck.
    let cancelState = 'waiting';
    cancelledPromise.then(() => { cancelState = 'resolved'; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancelState, 'waiting');
    releaseSnapshot();
    const [created, cancelled] = await Promise.all([createdPromise, cancelledPromise]);
    assert.equal(created.status, 201);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.concurrent'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-5: 自动清理停用后取消提案保留密钥且不调用后端删除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-cleanup-fail-'));
  const values = new Map();
  let deleteCalled = false;
  const secretStore = {
    async set(name, value) { values.set(name, value); },
    async get(name) { return values.get(name) ?? null; },
    async has(name) { return values.has(name); },
    async delete() { deleteCalled = true; throw new SecretStoreError('SECRET_STORE_BACKEND_FAILED', 'secret store operation failed'); },
  };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    assert.equal((await saveSecret(address, 'workbench.model.cleanfail', 'cleanfail-secret')).status, 200);
    const proposal = (await createModelProposal(address, 'cleanfail', 'cleanfail', 'workbench.model.cleanfail')).body.proposal;
    const cancelled = await cancelModelProposal(address, proposal);
    assert.equal(cancelled.status, 200);
    // wb10 #56 Q3: automatic cleanup is disabled ("unknown ->
    // retained"), so cancel never attempts a backend delete at all --
    // a throwing backend is irrelevant, and the secret stays.
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(deleteCalled, false);
    assert.equal(values.has('workbench.model.cleanfail'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Q24-5: 无归属字段的旧提案取消时保留密钥', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-legacy-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const workbenchDir = path.join(root, '.openclaw-workbench');
  await mkdir(workbenchDir, { recursive: true });
  await writeFile(path.join(workbenchDir, 'model-proposals.json'), JSON.stringify({
    version: 2,
    proposals: [{
      proposal: {
        action: { id: 'legacy-proposal', type: 'model.register', sessionId: 'legacy', status: 'awaiting_approval', actionHash: 'legacy-hash', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z' },
        profile: { id: 'legacy', secretRef: 'keychain:workbench.model.legacy' },
      },
    }],
  }));
  values.set('workbench.model.legacy', 'legacy-secret');
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    const listed = await request(address, '/v1/models/proposals');
    assert.equal(listed.body.proposals[0].action.status, 'manual_review');
    const cancelled = await request(address, '/v1/models/legacy-proposal/cancel', {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: 'legacy-hash' }),
    });
    assert.equal(cancelled.status, 200);
    // No secretAttribution field on the persisted old proposal:
    // attribution unknown -> retained, never deleted on a guess.
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.has('workbench.model.legacy'), true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型提案取消时删除后重建的密钥保留新值', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-delete-recreate-'));
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const address = await app.listen();
  try {
    assert.equal((await saveSecret(address, 'workbench.model.recreated', 'old-value')).status, 200);
    const proposal = (await createModelProposal(address, 'recreated', 'recreated', 'workbench.model.recreated')).body.proposal;
    // wb10 #56 Q3, version-reuse path: DELETE used to clear the
    // version counter, so the recreate minted version 1 again and
    // cancelling the old proposal deleted the NEW value. The
    // never-reused generation token breaks that equality.
    assert.equal((await deleteSecret(address, 'workbench.model.recreated')).status, 200);
    assert.equal((await saveSecret(address, 'workbench.model.recreated', 'new-value')).status, 200);
    const cancelled = await cancelModelProposal(address, proposal);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.get('workbench.model.recreated'), 'new-value');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型提案重启后重写密钥时取消旧提案保留新值', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-secret-restart-rewrite-'));
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
    assert.equal((await saveSecret(address, 'workbench.model.rewritten', 'pre-restart-value')).status, 200);
    proposal = (await createModelProposal(address, 'rewritten', 'rewritten', 'workbench.model.rewritten')).body.proposal;
  } finally { await app.close(); }

  // wb10 #56 Q3, restart-rewrite path: the restart wipes the
  // in-memory write record, so a rewrite used to mint version 1
  // again and cancelling the pre-restart proposal deleted the
  // rewritten value (the old code only checked that createdAt was a
  // string, never that it matched). The generation token of the
  // rewrite can never equal the pre-restart attribution's token.
  app = createWorkbenchServer(options);
  address = await app.listen();
  try {
    assert.equal((await saveSecret(address, 'workbench.model.rewritten', 'rewritten-value', { overwrite: true, version: 'present', approval: true })).status, 200);
    const cancelled = await cancelModelProposal(address, proposal);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.get('workbench.model.rewritten'), 'rewritten-value');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型提案创建方取消时另一工作区仍引用则保留共享密钥', async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'ocw-secret-xws-creator-a-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'ocw-secret-xws-creator-b-'));
  // One shared backend, as when two workspaces share the default
  // credential service. Workspace A wrote the secret and created the
  // attributed proposal; workspace B only references the same secret.
  // wb10 #56 Q3, cross-workspace path: cleanup in A only sees A's own
  // registry and proposals, so B's live reference is invisible to it.
  // Since exclusive creation across workspaces can never be proven
  // from A's view, cancelling A's proposal must retain the shared
  // secret ("unknown -> retained" convergence) instead of deleting
  // it out from under B.
  const values = new Map();
  const secretStore = { async set(name, value) { values.set(name, value); }, async get(name) { return values.get(name) ?? null; }, async has(name) { return values.has(name); }, async delete(name) { return values.delete(name); } };
  const appA = createWorkbenchServer({ root: rootA, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const appB = createWorkbenchServer({ root: rootB, token: 'test-token-012345', approvalToken: 'approve-token-012345', secretStore });
  const addressA = await appA.listen();
  const addressB = await appB.listen();
  try {
    assert.equal((await saveSecret(addressA, 'workbench.model.creator', 'creator-secret')).status, 200);
    const proposalA = (await createModelProposal(addressA, 'creator', 'creator', 'workbench.model.creator')).body.proposal;
    const proposalB = (await createModelProposal(addressB, 'creator', 'creator-ref', 'workbench.model.creator')).body.proposal;
    assert.equal(proposalB.action.status, 'awaiting_approval');
    const cancelled = await cancelModelProposal(addressA, proposalA);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.secretCleanup, 'retained');
    assert.equal(values.get('workbench.model.creator'), 'creator-secret');
    const stillListed = await request(addressB, '/v1/models/proposals');
    assert.equal(stillListed.body.proposals.some((item) => item.action.id === proposalB.action.id), true);
  } finally { await appA.close(); await appB.close(); await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }); }
});
