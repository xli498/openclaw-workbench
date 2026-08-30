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

test('本地控制面提供 Chat 会话并把模式绑定到 Adapter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-chat-'));
  const calls = [];
  const app = createWorkbenchServer({ root, token: 'test-token', runAgentFn: async (input) => { calls.push(input); return { text: '计划完成' }; } });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan', actor: 'tester' }) });
    assert.equal(created.status, 201);
    const sessionId = created.body.session.id;
    const result = await request(address, `/v1/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ message: '分析项目' }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.session.mode, 'Plan');
    assert.equal(calls[0].mode, 'Plan');
    assert.equal(calls[0].sessionKey, sessionId);
    const messages = await request(address, `/v1/sessions/${sessionId}/messages`);
    assert.equal(messages.body.messages.length, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Chat 会话非法模式和不存在会话返回结构化错误', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-chat-error-'));
  const app = createWorkbenchServer({ root, token: 'test-token', runAgentFn: async () => ({ text: 'unused' }) });
  const address = await app.listen();
  try {
    const invalid = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Write' }) });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'INVALID_MODE');
    const missing = await request(address, '/v1/sessions/not-found/messages', { method: 'GET' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'SESSION_NOT_FOUND');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('本地事件 API 仅暴露已发生事件且遵守鉴权', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-events-'));
  const app = createWorkbenchServer({ root, token: 'test-token', runAgentFn: async () => ({ text: 'ok' }) });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const events = await request(address, '/v1/events?after=0&limit=10');
    assert.equal(events.status, 200);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].type, 'session.created');
    assert.equal(events.body.events[0].sessionId, created.body.session.id);
    const unauthorized = await fetch(`http://${address.address}:${address.port}/v1/events`);
    assert.equal(unauthorized.status, 401);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
