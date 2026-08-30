import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-012345', ...(options.headers ?? {}) } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('本地控制面提供健康检查、鉴权和命令提案审批执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    assert.equal((await request(address, '/health')).body.ok, true);
    const unauthorized = await fetch(`http://${address.address}:${address.port}/health`);
    assert.equal(unauthorized.status, 401);
    const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'http-test', argv: ['pwd'] }) });
    assert.equal(proposal.status, 201);
    const approved = await request(address, `/v1/proposals/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.action.status, 'verified');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('并发审批先持久化 claim，第二个请求冲突且不会双执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-approval-race-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'approval-race', argv: ['pwd'] }) });
    const url = `/v1/proposals/${proposal.body.proposal.action.id}/approve`;
    const options = { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) };
    const [first, second] = await Promise.all([request(address, url, options), request(address, url, options)]);
    assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);
    assert.equal([first.body.error, second.body.error].filter(Boolean)[0], 'PROPOSAL_BUSY');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('本地控制面拒绝部分匹配和错误类型的 Bearer token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-auth-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    for (const authorization of ['Bearer test-toke', 'Bearer test-token-extra', 'Basic test-token', 'Bearer ', 'test-token']) {
      const response = await fetch(`http://${address.address}:${address.port}/health`, { headers: { authorization } });
      assert.equal(response.status, 401, authorization);
    }
    assert.equal((await request(address, '/health')).status, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('控制面拒绝无 token、弱 token 或非回环绑定，并要求独立审批凭据和 actionHash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-auth-boundary-'));
  try {
    assert.throws(() => createWorkbenchServer({ root }), /token must be at least 16 characters/);
    assert.throws(() => createWorkbenchServer({ root, token: 'too-short' }), /token must be at least 16 characters/);
    assert.throws(() => createWorkbenchServer({ root, token: 'test-token-012345', host: '0.0.0.0' }), /host must be loopback/);
    const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
    const address = await app.listen();
    try {
      const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'auth-boundary', argv: ['pwd'] }) });
      const url = `/v1/proposals/${proposal.body.proposal.action.id}/approve`;
      const absent = await request(address, url, { method: 'POST', body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
      assert.equal(absent.status, 403);
      assert.equal(absent.body.error, 'APPROVAL_AUTH_REQUIRED');
      const mismatch = await request(address, url, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: 'wrong' }) });
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.body.error, 'ACTION_HASH_MISMATCH');
    } finally { await app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('审批请求不能用 currentRevision 覆盖服务端工作区版本', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-revision-binding-'));
  await writeFile(path.join(root, 'tracked.txt'), 'before');
  await new Promise((resolve, reject) => execFile('/usr/bin/git', ['init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('/usr/bin/git', ['add', 'tracked.txt'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('/usr/bin/git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'revision-binding', argv: ['pwd'] }) });
    await writeFile(path.join(root, 'tracked.txt'), 'after');
    const approval = await request(address, `/v1/proposals/${proposal.body.proposal.action.id}/approve`, {
      method: 'POST',
      headers: { 'x-approval-token': 'approve-token-012345' },
      body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash, currentRevision: proposal.body.proposal.action.workspaceRevision }),
    });
    assert.equal(approval.status, 400);
    assert.equal(approval.body.error, 'REVISION_MISMATCH');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('本地控制面只接受受限格式的请求 ID，非法值会替换为服务端 UUID', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-request-id-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const accepted = await request(address, '/health', { headers: { 'x-request-id': 'client.trace-01:part' } });
    assert.equal(accepted.headers.get('x-request-id'), 'client.trace-01:part');
    const replaced = await request(address, '/health', { headers: { 'x-request-id': 'contains space' } });
    assert.match(replaced.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    const overlong = await request(address, '/health', { headers: { 'x-request-id': `x${'a'.repeat(128)}` } });
    assert.match(overlong.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('事件游标和页面大小只接受安全的十进制整数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-event-query-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    assert.equal((await request(address, '/v1/events?after=0&limit=10')).status, 200);
    for (const query of ['after= 0&limit=10', 'after=0x10&limit=10', 'after=1e2&limit=10', 'after=1.5&limit=10', 'after=0&limit=01', 'after=9007199254740992&limit=10']) {
      const response = await request(address, `/v1/events?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error, 'INVALID_QUERY_INTEGER');
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('事件游标和页面大小拒绝重复查询参数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-event-duplicates-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    for (const query of ['after=0&after=1', 'limit=10&limit=20', 'after=0&limit=10&after=0']) {
      const response = await request(address, `/v1/events?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error, 'DUPLICATE_QUERY_PARAMETER');
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('写接口只接受 JSON 对象请求体，不把原始 JSON 值传入运行时', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-body-shape-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    for (const body of ['null', '[]', '"text"', '1', 'true']) {
      const response = await request(address, '/v1/sessions', { method: 'POST', body });
      assert.equal(response.status, 400, body);
      assert.equal(response.body.error, 'INVALID_BODY');
    }
    const malformed = await request(address, '/v1/sessions', { method: 'POST', body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'INVALID_JSON');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('本地控制面提供 Chat 会话并把模式绑定到 Adapter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-chat-'));
  const calls = [];
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async (input) => { calls.push(input); return { text: '计划完成' }; } });
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
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async () => ({ text: 'unused' }) });
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
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async () => ({ text: 'ok' }) });
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

test('人工复核 API 仅转换 manual_review 状态并发布只读事件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-review-'));
  try {
    await mkdir(path.join(root, '.openclaw-workbench'));
    await writeFile(path.join(root, '.openclaw-workbench', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'manual', workspaceId: root, mode: 'Ask', actor: 'user', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', messages: [], running: true }] }));
    const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
    const address = await app.listen();
    const reviewed = await request(address, '/v1/sessions/manual/review', { method: 'POST', body: JSON.stringify({ decision: 'resume' }) });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.session.status, 'active');
    const events = await request(address, '/v1/events?after=0&limit=10');
    assert.equal(events.body.events.at(-1).type, 'session.reviewed');
    await app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('重启后的未完成提案只能查看，审批接口拒绝自动恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-proposal-recovery-'));
  const first = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const firstAddress = await first.listen();
  const created = await request(firstAddress, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 's', argv: ['pwd'] }) });
  await first.close();
  const second = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await second.listen();
  try {
    const record = await request(address, `/v1/proposals/${created.body.proposal.action.id}`);
    assert.equal(record.status, 200);
    assert.equal(record.body.recovery.state, 'manual_review');
    const approval = await request(address, `/v1/proposals/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(approval.status, 409);
    assert.equal(approval.body.error, 'PROPOSAL_MANUAL_REVIEW');
  } finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

test('执行失败的命令提案保存终态，而不是被重启误判为待复核', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-proposal-terminal-'));
  const first = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const firstAddress = await first.listen();
  const created = await request(firstAddress, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 's', argv: ['git', 'rev-parse', 'HEAD'] }) });
  const failed = await request(firstAddress, `/v1/proposals/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
  assert.equal(failed.status, 400);
  await first.close();
  const second = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await second.listen();
  try {
    const record = await request(address, `/v1/proposals/${created.body.proposal.action.id}`);
    assert.equal(record.body.proposal.action.status, 'failed');
    assert.equal(record.body.recovery, undefined);
  } finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

test('重启后事件 API 把历史事件标记为 recovered，且维持全局 sequence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-events-recovery-'));
  const first = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const firstAddress = await first.listen();
  await request(firstAddress, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
  await first.close();
  const second = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await second.listen();
  try {
    const events = await request(address, '/v1/events?after=0&limit=10');
    assert.equal(events.body.recovered, true);
    assert.equal(events.body.events[0].recovered, true);
    assert.equal(events.body.events[0].sequence, 1);
  } finally { await second.close(); await rm(root, { recursive: true, force: true }); }
});

test('状态 API 汇总重启恢复状态，不暴露会话或提案内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-status-recovery-'));
  try {
    await mkdir(path.join(root, '.openclaw-workbench'));
    await writeFile(path.join(root, '.openclaw-workbench', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'manual', workspaceId: root, mode: 'Code', actor: 'user', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', messages: [], running: true }] }));
    const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
    const address = await app.listen();
    const status = await request(address, '/v1/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.persistedState.sessions, { total: 1, active: 0, closed: 0, manualReview: 1, interruptedTurns: 1 });
    assert.deepEqual(status.body.persistedState.proposals, { total: 0, manualReview: 0, executing: 0, terminal: 0 });
    assert.equal(status.body.persistedState.events.recovered, false);
    assert.equal(JSON.stringify(status.body.persistedState).includes('"id"'), false);
    assert.equal(JSON.stringify(status.body.persistedState).includes('"messages"'), false);
    await app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
