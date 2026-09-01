import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

const API_TOKEN = 'local-api-token-012345';
const APPROVAL_TOKEN = 'separate-approval-token-012345';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_TOKEN}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('fresh workspace smoke: Ask/Plan/Code main path uses injected runner without network', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-fresh-smoke-'));
  const calls = [];
  const app = createWorkbenchServer({
    root,
    token: API_TOKEN,
    approvalToken: APPROVAL_TOKEN,
    // Deterministic adapter seam: this test never starts OpenClaw or contacts a model.
    runAgentFn: async (input) => {
      calls.push(input);
      return { text: `stub response for ${input.mode}` };
    },
  });
  const address = await app.listen();
  try {
    assert.equal(address.address, '127.0.0.1');
    assert.equal((await request(address, '/health')).body.ok, true);
    assert.equal('root' in (await request(address, '/v1/status')).body, false);

    const ask = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    assert.equal(ask.status, 201);
    const askMessage = await request(address, `/v1/sessions/${ask.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'summarize this workspace' }) });
    assert.equal(askMessage.status, 200);
    assert.equal(askMessage.body.message.role, 'assistant');

    const plan = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const planReview = await request(address, `/v1/sessions/${plan.body.session.id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'make a read-only verification plan', models: ['stub-a', 'stub-b'] }) });
    assert.equal(planReview.status, 200);
    assert.equal(planReview.body.synthesis.analysisCount, 2);
    assert.equal(planReview.body.synthesis.requiresHumanReview, false);

    await (await import('node:fs/promises')).writeFile(path.join(root, 'smoke.txt'), 'before\n');
    const code = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code' }) });
    const proposal = await request(address, `/v1/sessions/${code.body.session.id}/tools/proposals`, {
      method: 'POST',
      body: JSON.stringify({ tool: 'patch', input: { patch: '--- smoke.txt\n+++ smoke.txt\n@@ -1 +1 @@\n-before\n+smoke', declaredPaths: ['smoke.txt'] } }),
    });
    assert.equal(proposal.status, 201);
    assert.equal(proposal.body.proposal.action.status, 'awaiting_approval');
    assert.equal(calls.every((call) => call.local === true), true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
