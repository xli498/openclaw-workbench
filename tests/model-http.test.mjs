import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { createModelHealthProbe } from '../runtime/model-probe.mjs';
import { createSecretResolver } from '../runtime/secret-resolver.mjs';

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

test('模型启用和停用使用独立 configHash 审批，并拒绝旧 hash、token 互换和 replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-toggle-http-')); const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL }); const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'toggle' })) });
    const approved = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const disabled = approved.body.profile;
    const enable = await request(address, '/v1/models/toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle-session', configHash: disabled.configHash }) });
    assert.equal(enable.status, 201);
    const wrongToken = await request(address, `/v1/models/${enable.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: enable.body.proposal.action.actionHash }) });
    assert.equal(wrongToken.status, 403);
    const enabled = await request(address, `/v1/models/${enable.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enable.body.proposal.action.actionHash }) });
    assert.equal(enabled.status, 200);
    const replay = await request(address, `/v1/models/${enable.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enable.body.proposal.action.actionHash }) });
    assert.equal(replay.status, 404);
    const stale = await request(address, '/v1/models/toggle/disable', { method: 'POST', body: JSON.stringify({ sessionId: 'toggle-session', configHash: disabled.configHash }) });
    assert.equal(stale.status, 409);
    assert.equal((await request(address, '/v1/models')).body.models.find((model) => model.id === 'toggle').enabled, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型连接探针返回恶意 code 时，响应、审计和快照不回显原文', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-health-red-'));
  const secret = 'secret-value-must-not-leak';
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, modelHealthProbe: async () => ({ status: 'error', code: secret }) });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'health-red' })) });
    const approved = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const health = await request(address, '/v1/models/health-red/health', { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: approved.body.profile.configHash }) });
    const audit = await request(address, '/v1/audit');
    assert.equal(JSON.stringify(health.body).includes(secret), false);
    assert.equal(JSON.stringify(audit.body).includes(secret), false);
    assert.equal((await readFile(path.join(root, '.openclaw-workbench', 'model-registry.json'), 'utf8')).includes(secret), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP 连接测试通过注入的 SecretResolver 只把密钥放进请求头', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-health-probe-'));
  let seen;
  const probe = createModelHealthProbe({
    secretResolver: createSecretResolver({ env: { ACME_API_KEY: 'secret-header-only' } }),
    fetchImpl: async (url, options) => { seen = { url, options }; return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[]}')); controller.close(); } }) }; },
  });
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, modelHealthProbe: probe });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'probe-http' })) });
    const approved = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const result = await request(address, '/v1/models/probe-http/health', { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: approved.body.profile.configHash }) });
    assert.equal(result.status, 200);
    assert.equal(seen.url, 'https://api.example.test/v1/models');
    assert.equal(seen.options.headers.authorization, 'Bearer secret-header-only');
    assert.equal('body' in seen.options, false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP Chat 端到端执行已启用模型的只读 workspace tool loop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-chat-http-'));
  await writeFile(path.join(root, 'README.md'), 'HTTP workspace fixture');
  let calls = 0;
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, modelRunner: async (input) => {
    calls += 1;
    return calls === 1
      ? { text: '', toolCalls: [{ id: 'read', name: 'workspace.read_file', arguments: { path: 'README.md' } }], finishReason: 'tool_calls', model: input.model, protocol: 'openai-compatible' }
      : { text: 'HTTP 工具回路完成', toolCalls: [], finishReason: 'stop', model: input.model, protocol: 'openai-compatible' };
  } });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(input({ id: 'chat-http', model: 'chat-test' })) });
    const registered = await request(address, `/v1/models/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const toggle = await request(address, '/v1/models/chat-http/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'chat-http-session', configHash: registered.body.profile.configHash }) });
    await request(address, `/v1/models/${toggle.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: toggle.body.proposal.action.actionHash }) });
    const session = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const result = await request(address, `/v1/sessions/${session.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'chat-http', message: '读取 README' }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.message.content.text, 'HTTP 工具回路完成');
    assert.equal(calls, 2);
    assert.equal(result.body.session.messageCount, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：工具提案持久化失败时不留下可审批的内存幽灵', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-proposal-store-fail-'));
  const failingStore = {
    put() { throw new Error('simulated proposal persistence failure'); },
    get() { return null; },
    list() { return []; },
    recoverySummary() { return { total: 0, manualReview: 0, executing: 0, terminal: 0 }; },
  };
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, proposalStore: failingStore });
  const address = await app.listen();
  try {
    const session = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const created = await request(address, `/v1/sessions/${session.body.session.id}/tools/proposals`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'patch', input: { patch: '--- a.txt\n+++ a.txt\n@@ -0,0 +1 @@\n+new\n', declaredPaths: ['a.txt'] } }),
    });
    assert.equal(created.status, 500);
    assert.equal(created.body.error, 'INTERNAL_ERROR');
    const proposals = await request(address, '/v1/proposals');
    assert.deepEqual(proposals.body.proposals, []);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
