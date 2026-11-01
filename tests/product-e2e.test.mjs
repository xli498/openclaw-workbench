import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { createModelRunner } from '../runtime/model-runner.mjs';
import { createSecretResolver } from '../runtime/secret-resolver.mjs';
import { createMockOpenAIProvider } from './mock-provider.mjs';

const TOKEN = 'product-e2e-token-012345';
const APPROVAL = 'product-e2e-approval-012345';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function approveModel(address, proposal) {
  return request(address, `/v1/models/${proposal.action.id}/approve`, {
    method: 'POST',
    headers: { 'x-approval-token': APPROVAL },
    body: JSON.stringify({ actionHash: proposal.action.actionHash }),
  });
}

function profile(overrides = {}) {
  return {
    sessionId: 'setup',
    id: 'mock-primary',
    provider: 'local-mock',
    protocol: 'openai-compatible',
    model: 'mock-model',
    endpoint: 'https://mock.provider.test/v1',
    capabilities: ['text', 'tool_calling'],
    secretRef: 'env:MOCK_PROVIDER_KEY',
    ...overrides,
  };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-product-e2e-'));
  await writeFile(path.join(root, 'README.md'), 'WORKBENCH_FIXTURE\n');
  const provider = await createMockOpenAIProvider();
  const secretResolver = createSecretResolver({ env: { MOCK_PROVIDER_KEY: 'mock-secret-value' } });
  const modelRunner = createModelRunner({
    secretResolver,
    fetchImpl: provider.fetch,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const runAgentFn = provider.createAgentRunner();
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, modelRunner, runAgentFn });
  const address = await app.listen();
  const registered = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify(profile()) });
  assert.equal(registered.status, 201);
  const enabled = await approveModel(address, registered.body.proposal);
  assert.equal(enabled.status, 200);
  const toggle = await request(address, '/v1/models/mock-primary/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'setup', configHash: enabled.body.profile.configHash }) });
  assert.equal(toggle.status, 201);
  const active = await approveModel(address, toggle.body.proposal);
  assert.equal(active.status, 200);
  return { root, provider, app, address, async close() { await app.close(); await provider.close(); await rm(root, { recursive: true, force: true }); } };
}

test('single-model product loop keeps Ask and Plan read-only and gates Code writes behind approval', async () => {
  const context = await setup();
  try {
    const askSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    assert.equal(askSession.status, 201);
    const ask = await request(context.address, `/v1/sessions/${askSession.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'mock-primary', message: '读取 README.md 并搜索 WORKBENCH_FIXTURE' }) });
    assert.equal(ask.status, 200);
    assert.match(ask.body.message.content.text, /WORKBENCH_FIXTURE/);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');

    const planSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const plan = await request(context.address, `/v1/sessions/${planSession.body.session.id}/plan`, { method: 'POST', body: JSON.stringify({ question: '如何安全修改 README.md？', models: ['mock-primary', 'mock-reviewer'] }) });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.mode, 'Plan');
    assert.equal(plan.body.synthesis.requiresHumanReview, false);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');

    const codeSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const code = await request(context.address, `/v1/sessions/${codeSession.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'mock-primary', message: '请修改 README.md，增加 APPROVED_CHANGE' }) });
    assert.equal(code.status, 200);
    const proposals = await request(context.address, `/v1/proposals?sessionId=${codeSession.body.session.id}`);
    const proposal = proposals.body.proposals.find((item) => item.action?.type === 'patch');
    assert.ok(proposal?.action?.id, 'Code must return an approval-gated patch proposal');
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');

    const denied = await request(context.address, `/v1/proposals/${proposal.action.id}/approve`, { method: 'POST', body: JSON.stringify({ actionHash: proposal.action.actionHash }) });
    assert.equal(denied.status, 403);
    const approved = await request(context.address, `/v1/proposals/${proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\nAPPROVED_CHANGE\n');

    const audit = await request(context.address, '/v1/audit');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.events.some((event) => event.type === 'action.proposed'));
    assert.ok(audit.body.events.some((event) => event.type === 'action.verified'));
    assert.equal(JSON.stringify(audit.body).includes('mock-secret-value'), false);
  } finally {
    await context.close();
  }
});

test('command proposal executes only after approval and records a redacted audit result', async () => {
  const context = await setup();
  try {
    const session = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const proposal = await request(context.address, `/v1/sessions/${session.body.session.id}/tools/proposals`, { method: 'POST', body: JSON.stringify({ tool: 'command', input: { argv: ['pwd'] } }) });
    assert.equal(proposal.status, 201);
    const action = proposal.body.proposal.action;
    const before = await request(context.address, '/v1/audit');
    assert.equal(before.body.events.some((event) => event.type === 'command.verified'), false);
    const approved = await request(context.address, `/v1/proposals/${action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.result.cwd, context.root);
    const audit = await request(context.address, '/v1/audit');
    assert.ok(audit.body.events.some((event) => event.type === 'command.verified'));
  } finally {
    await context.close();
  }
});

test('restarted pending proposals require manual review and cannot be replayed', async () => {
  const first = await setup();
  let proposal;
  try {
    const session = await request(first.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const created = await request(first.address, `/v1/sessions/${session.body.session.id}/tools/proposals`, { method: 'POST', body: JSON.stringify({ tool: 'command', input: { argv: ['pwd'] } }) });
    proposal = created.body.proposal;
  } finally {
    await first.app.close();
    await first.provider.close();
  }
  const second = createWorkbenchServer({ root: first.root, token: TOKEN, approvalToken: APPROVAL });
  const address = await second.listen();
  try {
    const listed = await request(address, `/v1/proposals/${proposal.action.id}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.recovery.state, 'manual_review');
    const replay = await request(address, `/v1/proposals/${proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.action.actionHash }) });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, 'PROPOSAL_MANUAL_REVIEW');
  } finally {
    await second.close();
    await rm(first.root, { recursive: true, force: true });
  }
});

test('configuration change creates a backup and rollback is approval-gated', async () => {
  const context = await setup();
  try {
    const before = '{"mode":"before"}\n';
    const after = '{"mode":"after"}\n';
    await writeFile(path.join(context.root, 'openclaw.json'), before);
    const current = await request(context.address, '/v1/config');
    const importProposal = await request(context.address, '/v1/config/import', { method: 'POST', body: JSON.stringify({ sessionId: 'config-e2e', expectedHash: current.body.config.hash, content: after }) });
    assert.equal(importProposal.status, 201);
    const imported = await request(context.address, `/v1/config/${importProposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: importProposal.body.proposal.action.actionHash }) });
    assert.equal(imported.status, 200);
    assert.equal(await readFile(path.join(context.root, 'openclaw.json'), 'utf8'), after);
    const rollbackProposal = await request(context.address, '/v1/config/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 'config-e2e', expectedHash: imported.body.config.afterHash, backupId: imported.body.config.backupId }) });
    assert.equal(rollbackProposal.status, 201);
    const missingApproval = await request(context.address, `/v1/config/${rollbackProposal.body.proposal.action.id}/approve`, { method: 'POST', body: JSON.stringify({ actionHash: rollbackProposal.body.proposal.action.actionHash }) });
    assert.equal(missingApproval.status, 403);
    const rolledBack = await request(context.address, `/v1/config/${rollbackProposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: rollbackProposal.body.proposal.action.actionHash }) });
    assert.equal(rolledBack.status, 200);
    assert.equal(await readFile(path.join(context.root, 'openclaw.json'), 'utf8'), before);
  } finally {
    await context.close();
  }
});
