import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { createModelRunner } from '../runtime/model-runner.mjs';
import { createSecretResolver } from '../runtime/secret-resolver.mjs';
import { createMemorySecretBackend, createWindowsCredentialStore } from '../runtime/secret-store.mjs';
import { createMockOpenAIProvider } from './mock-provider.mjs';

const TOKEN = 'keychain-product-token-012345';
const APPROVAL = 'keychain-product-approval-012345';
const SECRET = 'keychain-only-test-secret';

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

async function approve(address, proposal) {
  return request(address, `/v1/models/${proposal.action.id}/approve`, {
    method: 'POST',
    headers: { 'x-approval-token': APPROVAL },
    body: JSON.stringify({ actionHash: proposal.action.actionHash }),
  });
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-keychain-product-e2e-'));
  await writeFile(path.join(root, 'README.md'), 'WORKBENCH_FIXTURE\n');
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node -e \\"process.exit(0)\\"}}\n');
  const provider = await createMockOpenAIProvider({ secret: SECRET });
  const backend = createMemorySecretBackend();
  const secretStore = createWindowsCredentialStore({ service: 'openclaw-workbench-test', backend, platform: 'linux' });
  const secretResolver = createSecretResolver({ keychainProvider: (name, options) => secretStore.get(name, options) });
  const modelRunner = createModelRunner({
    secretResolver,
    fetchImpl: provider.fetch,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, secretStore, secretResolver, modelRunner });
  const address = await app.listen();
  const saved = await request(address, '/v1/secrets', { method: 'POST', body: JSON.stringify({ name: 'workbench.model.keychain', value: SECRET }) });
  assert.equal(saved.status, 200);
  const registered = await request(address, '/v1/models', { method: 'POST', body: JSON.stringify({
    sessionId: 'setup', id: 'keychain-primary', provider: 'local-mock', protocol: 'openai-compatible', model: 'mock-model', endpoint: 'https://mock.provider.test/v1', capabilities: ['text', 'tool_calling'], secretRef: 'keychain:workbench.model.keychain',
  }) });
  assert.equal(registered.status, 201);
  assert.equal(JSON.stringify(registered.body).includes(SECRET), false);
  const approved = await approve(address, registered.body.proposal);
  assert.equal(approved.status, 200);
  const enabled = await request(address, '/v1/models/keychain-primary/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'setup', configHash: approved.body.profile.configHash }) });
  assert.equal(enabled.status, 201);
  const active = await approve(address, enabled.body.proposal);
  assert.equal(active.status, 200);
  return { root, provider, app, address, secretStore, async close() { await app.close(); await provider.close(); await rm(root, { recursive: true, force: true }); } };
}

test('keychain model runs the product loop without persisting the API key', async () => {
  const context = await setup();
  try {
    const askSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const ask = await request(context.address, `/v1/sessions/${askSession.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'keychain-primary', message: '读取 README.md' }) });
    assert.equal(ask.status, 200);
    assert.match(ask.body.message.content.text, /WORKBENCH_FIXTURE/);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');

    const planSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const plan = await request(context.address, `/v1/sessions/${planSession.body.session.id}/plan`, { method: 'POST', body: JSON.stringify({ model: 'keychain-primary', question: '如何安全修改 README.md？' }) });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.mode, 'Plan');
    assert.equal(plan.body.synthesis.requiresHumanReview, false);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');

    const codeSession = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const code = await request(context.address, `/v1/sessions/${codeSession.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'keychain-primary', message: '请修改 README.md，增加 APPROVED_CHANGE' }) });
    assert.equal(code.status, 200);
    const proposals = await request(context.address, `/v1/proposals?sessionId=${codeSession.body.session.id}`);
    const patch = proposals.body.proposals.find((item) => item.action?.type === 'patch');
    assert.ok(patch?.action?.id);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\n');
    const applied = await request(context.address, `/v1/proposals/${patch.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: patch.action.actionHash }) });
    assert.equal(applied.status, 200);
    assert.equal(await readFile(path.join(context.root, 'README.md'), 'utf8'), 'WORKBENCH_FIXTURE\nAPPROVED_CHANGE\n');

    const command = await request(context.address, `/v1/sessions/${codeSession.body.session.id}/tools/proposals`, { method: 'POST', body: JSON.stringify({ tool: 'command', input: { argv: ['pwd'] } }) });
    assert.equal(command.status, 201);
    const commandApproved = await request(context.address, `/v1/proposals/${command.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: command.body.proposal.action.actionHash }) });
    assert.equal(commandApproved.status, 200);
    assert.equal(commandApproved.body.action.status, 'verified');
    assert.equal(commandApproved.body.result.code, 0);

    const audit = await request(context.address, '/v1/audit');
    assert.ok(audit.body.events.some((event) => event.type === 'action.verified'));
    assert.ok(audit.body.events.some((event) => event.type === 'command.verified'));
    assert.equal(JSON.stringify(audit.body).includes(SECRET), false);
    assert.equal(JSON.stringify(await request(context.address, '/v1/status')).includes(SECRET), false);
    assert.equal(context.provider.requests.length >= 3, true);
    assert.ok(context.provider.requests.every((entry) => entry.headers.authorization === `Bearer ${SECRET}`));
    assert.equal(JSON.stringify(context.provider.requests.map((entry) => entry.body)).includes(SECRET), false);
  } finally {
    await context.close();
  }
});

test('keychain secret survives only in the credential backend, never in the session snapshot', async () => {
  const context = await setup();
  try {
    const session = await request(context.address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    await request(context.address, `/v1/sessions/${session.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ modelId: 'keychain-primary', message: '读取 README.md' }) });
    const snapshot = await readFile(path.join(context.root, '.openclaw-workbench', 'sessions.json'), 'utf8');
    assert.equal(snapshot.includes(SECRET), false);
    assert.equal(await context.secretStore.get('workbench.model.keychain'), SECRET);
  } finally {
    await context.close();
  }
});
