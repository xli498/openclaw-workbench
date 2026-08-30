import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: 'Bearer test-token', ...(options.headers ?? {}) } });
  return { status: response.status, body: await response.json() };
}

test('本地控制面提供健康检查、鉴权和命令提案审批执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-'));
  const app = createWorkbenchServer({ root, token: 'test-token' });
  const address = await app.listen();
  try {
    assert.equal((await request(address, '/health')).body.ok, true);
    const unauthorized = await fetch(`http://${address.address}:${address.port}/health`);
    assert.equal(unauthorized.status, 401);
    const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'http-test', argv: [process.execPath, '-e', 'console.log("ok")'] }) });
    assert.equal(proposal.status, 201);
    const approved = await request(address, `/v1/proposals/${proposal.body.proposal.action.id}/approve`, { method: 'POST', body: '{}' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.action.status, 'verified');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
