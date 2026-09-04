import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

const TOKEN = 'test-token-012345';
const APPROVAL = 'approve-token-012345';
async function request(address, pathname, options = {}) { const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) } }); return { status: response.status, body: await response.json() }; }
function input(overrides = {}) { return { sessionId: 'model-session', id: 'primary', provider: 'acme', protocol: 'openai-compatible', model: 'acme-large', endpoint: 'https://api.example.test/v1', capabilities: ['text'], secretRef: 'env:ACME_API_KEY', ...overrides }; }

test('模型注册先生成审批提案，正确审批后仍保持 disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-http-')); const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL }); const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input()) });
    assert.equal(created.status, 201); assert.equal(created.body.proposal.action.status, 'awaiting_approval'); assert.equal(created.body.proposal.profile.enabled, false); assert.deepEqual((await request(address, '/v1/models')).body.models, []);
    const approved = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200); assert.equal(approved.body.profile.enabled, false); assert.equal((await request(address, '/v1/models')).body.models[0].id, 'primary');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型审批拒绝 token 互换、actionHash 篡改和重复重放', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-replay-')); const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL }); const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'safe' })) });
    assert.equal((await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) })).status, 403);
    const tampered = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: '0'.repeat(64) }) }); assert.equal(tampered.status, 409);
    const approved = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) }); assert.equal(approved.status, 200);
    assert.equal((await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) })).status, 404);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型连接测试默认不联网，注入探针只收到安全 profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-health-')); let probeInput;
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, inspectModelProfileFn: async (input) => { probeInput = input; return { status: 'ready' }; } }); const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'health' })) });
    await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const health = await request(address, '/v1/models/health/health'); assert.equal(health.status, 200); assert.deepEqual(health.body.health, { status: 'ready' }); assert.equal(probeInput.profile.secretRef, 'env:ACME_API_KEY'); assert.equal('apiKey' in probeInput.profile, false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
