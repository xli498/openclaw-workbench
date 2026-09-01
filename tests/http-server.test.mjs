import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { createEventBus } from '../runtime/event-bus.mjs';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-012345', ...(options.headers ?? {}) } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('控制面提供受鉴权的工作区只读文件读取，并拒绝敏感路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-workspace-'));
  await writeFile(path.join(root, 'README.md'), '# local\n');
  await writeFile(path.join(root, '.env'), 'secret\n');
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const tree = await request(address, '/v1/workspace/tree');
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.root.children, [{ path: 'README.md', type: 'file', size: 8 }]);
    const file = await request(address, '/v1/workspace/read?path=README.md');
    assert.equal(file.status, 200);
    assert.deepEqual(file.body.file, { path: 'README.md', size: 8, isFile: true, isDirectory: false, content: '# local\n' });
    const sensitive = await request(address, '/v1/workspace/read?path=.env');
    assert.equal(sensitive.status, 400);
    assert.equal(sensitive.body.error, 'SENSITIVE_PATH');
    const missing = await request(address, '/v1/workspace/read?path=missing.md');
    assert.equal(missing.status, 404);
    const limited = await request(address, '/v1/workspace/tree?maxEntries=0');
    assert.equal(limited.status, 400);
    assert.equal(limited.body.error, 'TREE_LIMIT');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('控制面提供 Patch Diff 只读预览并拒绝非 Patch 提案', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-diff-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const patch = '--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-old\n+new\n';
    const created = await request(address, '/v1/proposals/patch', { method: 'POST', body: JSON.stringify({ sessionId: 'diff-test', patch, declaredPaths: ['README.md'] }) });
    assert.equal(created.status, 201);
    const diff = await request(address, `/v1/proposals/${created.body.proposal.action.id}/diff`);
    assert.equal(diff.status, 200);
    assert.equal(diff.body.diff.patch, patch);
    assert.deepEqual(diff.body.diff.paths, ['README.md']);
    assert.equal(diff.body.diff.actionHash, created.body.proposal.action.actionHash);
    const command = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'diff-command', argv: ['pwd'] }) });
    const rejected = await request(address, `/v1/proposals/${command.body.proposal.action.id}/diff`);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, 'NOT_PATCH_PROPOSAL');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

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

test('关闭本地服务会终止 SSE 与进行中的 Agent 回合', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-close-'));
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true }); }) });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const turn = request(address, `/v1/sessions/${created.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'long turn' }) });
    await running;
    await app.close();
    const response = await turn;
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'TURN_ABORTED');
  } finally { await app.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('本地控制面提供带安全策略响应头的控制台页面', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-ui-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const response = await fetch(`http://${address.address}:${address.port}/ui`, { headers: { authorization: 'Bearer test-token-012345' } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(html, /Ask · 只读/);
    assert.match(html, /批准执行/);
    assert.match(html, /Workspace Inspector/);
    assert.match(html, /workspaceTree/);
    assert.match(html, /workspacePreview/);
    assert.match(html, /proposalStatus/);
    assert.match(html, /查看 Patch Diff/);
    assert.match(html, /查看最近 Terminal 结果/);
    assert.match(html, /\/v1\/commands/);
    assert.match(html, /command-list/);
    assert.match(html, /renderCommands/);
    assert.match(html, /标准输出/);
    assert.match(html, /错误输出/);
    assert.match(html, /转入 Code 审阅/);
    assert.match(html, /handoffHint/);
    assert.match(html, /复核结果不会自动执行/);
    assert.match(html, /if\(state.mode==='Plan'\)await loadPlanHistory\(\)/);
    assert.match(html, /人工复核/);
    assert.match(html, /恢复会话/);
    assert.match(html, /关闭会话/);
    assert.match(html, /reviewSession\('resume'\)/);
    assert.match(html, /reviewSession\('close'\)/);
    assert.match(html, /authorization:'Bearer '\+state\.token/);
    assert.doesNotMatch(html, /EventSource|prompt\(|test-token-012345|approve-token-012345/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('控制面可显式使用受限 OpenClaw CLI Adapter，并将其失败安全映射为上游错误', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-adapter-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', adapter: { command: process.execPath, local: false, timeoutMs: 5_000, maxOutputBytes: 16_384 } });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const response = await request(address, `/v1/sessions/${created.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'hello', local: false }) });
    assert.equal(response.status, 502);
    assert.equal(response.body.error, 'PROCESS_FAILED');
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

test('事件 SSE 先发送历史事件，再推送新事件并支持断开清理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-event-stream-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const streamResponse = await fetch(`http://${address.address}:${address.port}/v1/events/stream?after=0`, { headers: { authorization: 'Bearer test-token-012345' } });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/);
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    assert.match(text, new RegExp(`event: session\\.created[\\s\\S]*${created.body.session.id}`));
    const next = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    text += decoder.decode((await next).value);
    assert.match(text, new RegExp(`event: session\\.created[\\s\\S]*${second.body.session.id}`));
    await reader.cancel();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('事件 SSE 强制鉴权并拒绝非法或重复游标', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-event-stream-boundary-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    assert.equal((await fetch(`http://${address.address}:${address.port}/v1/events/stream?after=0`)).status, 401);
    for (const query of ['after=0x10', 'after=1.5', 'after=0&after=1']) {
      const response = await fetch(`http://${address.address}:${address.port}/v1/events/stream?${query}`, { headers: { authorization: 'Bearer test-token-012345' } });
      assert.equal(response.status, 400, query);
      const body = await response.json();
      assert.ok(['INVALID_QUERY_INTEGER', 'DUPLICATE_QUERY_PARAMETER'].includes(body.error), query);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('事件 SSE 对超出保留窗口的游标返回明确冲突', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-event-expired-'));
  const eventBus = createEventBus({ root, limit: 2 });
  eventBus.publish({ type: 'one' }); eventBus.publish({ type: 'two' }); eventBus.publish({ type: 'three' }); eventBus.publish({ type: 'four' });
  const app = createWorkbenchServer({ root, eventBus, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const response = await fetch(`http://${address.address}:${address.port}/v1/events/stream?after=1`, { headers: { authorization: 'Bearer test-token-012345' } });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'EVENT_CURSOR_EXPIRED');
    assert.equal(body.earliestSequence, 3);
    assert.equal(body.latestSequence, 4);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('控制面提供会话和提案列表，且默认只暴露公开字段', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-lists-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Code', actor: 'tester' }) });
    const sessions = await request(address, '/v1/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.sessions[0].id, created.body.session.id);
    assert.equal('messages' in sessions.body.sessions[0], false);
    const proposal = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: created.body.session.id, argv: ['pwd'] }) });
    const proposals = await request(address, '/v1/proposals?status=awaiting_approval');
    assert.equal(proposals.status, 200);
    assert.equal(proposals.body.proposals[0].action.id, proposal.body.proposal.action.id);
    assert.equal('claim' in proposals.body.proposals[0], false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('待审批提案可拒绝或取消，执行中提案不能被取消', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-reject-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await app.listen();
  try {
    const denied = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'reject', argv: ['pwd'] }) });
    const deniedResult = await request(address, `/v1/proposals/${denied.body.proposal.action.id}/deny`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(deniedResult.status, 200);
    assert.equal(deniedResult.body.proposal.action.status, 'denied');
    const cancelled = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'cancel', argv: ['pwd'] }) });
    const cancelledResult = await request(address, `/v1/proposals/${cancelled.body.proposal.action.id}/cancel`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(cancelledResult.status, 200);
    assert.equal(cancelledResult.body.proposal.action.status, 'cancelled');
    const executing = await request(address, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'busy', argv: ['pwd'] }) });
    const approveUrl = `/v1/proposals/${executing.body.proposal.action.id}/approve`;
    const approveOptions = { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: executing.body.proposal.action.actionHash }) };
    const pending = request(address, approveUrl, approveOptions);
    const cancelBusy = await request(address, `/v1/proposals/${executing.body.proposal.action.id}/cancel`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' } });
    assert.equal(cancelBusy.status, 409);
    await pending;
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Plan 复核结果可查询并持久化到重启后的会话快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-plan-history-'));
  const runAgentFn = async ({ model }) => ({ text: `analysis from ${model}` });
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan', actor: 'tester' }) });
    const result = await request(address, `/v1/sessions/${created.body.session.id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'compare two designs', models: ['model-a', 'model-b'] }) });
    assert.equal(result.status, 200);
    const history = await request(address, `/v1/sessions/${created.body.session.id}/plan`);
    assert.equal(history.status, 200);
    assert.equal(history.body.results.length, 1);
    assert.equal(history.body.results[0].synthesis.analysisCount, 2);
    assert.equal('runAgentFn' in history.body.results[0], false);
    await app.close();
    const restarted = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn });
    const restartedAddress = await restarted.listen();
    try {
      const restored = await request(restartedAddress, `/v1/sessions/${created.body.session.id}/plan`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.results[0].question, 'compare two designs');
    } finally { await restarted.close(); }
  } finally { await app.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test('控制面 Plan 接口可执行多轮大模型博弈并持久化结果', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-debate-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async ({ model, message }) => ({ text: `${model}:${message.includes('final impartial judge') ? 'verdict' : message.includes('opposing reviewer') ? 'critique' : 'proposal'}` }) });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const result = await request(address, `/v1/sessions/${created.body.session.id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'compare designs', models: ['model-a', 'model-b'], judgeModel: 'judge', debate: true }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.debate, true);
    assert.equal(result.body.rounds.proposals.length, 2);
    assert.equal(result.body.rounds.critiques.length, 2);
    assert.equal(result.body.rounds.responses.length, 2);
    assert.equal(result.body.rounds.verdict.model, 'judge');
    const events = await request(address, '/v1/events');
    const stages = events.body.events.filter((event) => event.sessionId === created.body.session.id && event.type.startsWith('plan.stage.'));
    assert.deepEqual(stages.map((event) => `${event.data.stage}:${event.data.status}`), ['proposal:started', 'proposal:completed', 'challenge:started', 'challenge:completed', 'response:started', 'response:completed', 'judge:started', 'judge:completed']);
    const history = await request(address, `/v1/sessions/${created.body.session.id}/plan`);
    assert.equal(history.body.results[0].debate, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('运行中的 Chat 回合可通过控制面安全取消', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-cancel-'));
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async ({ signal }) => await new Promise((resolve, reject) => { markStarted(); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true }); }) });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Ask' }) });
    const turn = request(address, `/v1/sessions/${created.body.session.id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'long turn' }) });
    await started;
    const cancelled = await request(address, `/v1/sessions/${created.body.session.id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 202);
    const result = await turn;
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'TURN_ABORTED');
    assert.equal((await request(address, `/v1/sessions/${created.body.session.id}/cancel`, { method: 'POST' })).status, 400);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('运行中的 Plan 复核可取消、拒绝并发回合且不保存半成品', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-plan-cancel-'));
  let startedCount = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const runAgentFn = async ({ signal }) => await new Promise((resolve, reject) => {
    startedCount += 1;
    if (startedCount === 2) markStarted();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
  });
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const id = created.body.session.id;
    const turn = request(address, `/v1/sessions/${id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'long review', models: ['model-a', 'model-b'] }) });
    await started;
    const concurrent = await request(address, `/v1/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ message: 'must conflict' }) });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error, 'SESSION_BUSY');
    assert.equal((await request(address, `/v1/sessions/${id}/cancel`, { method: 'POST' })).status, 202);
    const result = await turn;
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'TURN_ABORTED');
    const history = await request(address, `/v1/sessions/${id}/plan`);
    assert.deepEqual(history.body.results, []);
    const events = await request(address, '/v1/events?after=0&limit=100');
    const planEvents = events.body.events.filter((event) => event.sessionId === id);
    assert.equal(planEvents.some((event) => event.type === 'plan.completed'), false);
    assert.equal(planEvents.some((event) => event.type === 'plan.stage.completed'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Plan Debate 阶段全失败时发布失败终态且不发布完成事件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-plan-failed-'));
  const app = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345', runAgentFn: async () => { throw Object.assign(new Error('model down'), { code: 'MODEL_FAILED' }); } });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const id = created.body.session.id;
    const result = await request(address, `/v1/sessions/${id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'failed debate', models: ['a', 'b'], debate: true }) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'DEBATE_FAILED');
    const events = await request(address, '/v1/events?after=0&limit=100');
    const planEvents = events.body.events.filter((event) => event.sessionId === id);
    const stageEvents = planEvents.filter((event) => event.type.startsWith('plan.stage.'));
    assert.deepEqual(stageEvents.map((event) => `${event.data.stage}:${event.data.status}`), ['proposal:started', 'proposal:failed']);
    assert.equal(planEvents.some((event) => event.type === 'plan.completed'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Plan Debate 裁判失败时发布 judge 失败终态且不发布完成事件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-judge-failed-'));
  const app = createWorkbenchServer({
    root,
    token: 'test-token-012345',
    approvalToken: 'approve-token-012345',
    runAgentFn: async ({ message }) => {
      if (message.includes('final impartial judge')) throw Object.assign(new Error('judge down'), { code: 'MODEL_FAILED' });
      if (message.includes('opposing reviewer')) return { text: 'critique' };
      if (message.includes('responding to peer criticism')) return { text: 'response' };
      return { text: 'proposal' };
    },
  });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/sessions', { method: 'POST', body: JSON.stringify({ mode: 'Plan' }) });
    const id = created.body.session.id;
    const result = await request(address, `/v1/sessions/${id}/plan`, { method: 'POST', body: JSON.stringify({ question: 'judge failure', models: ['a', 'b'], judgeModel: 'judge', debate: true }) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'JUDGE_FAILED');
    const events = await request(address, '/v1/events?after=0&limit=100');
    const planEvents = events.body.events.filter((event) => event.sessionId === id);
    assert.equal(planEvents.at(-1).type, 'plan.stage.failed');
    assert.equal(planEvents.at(-1).data.stage, 'judge');
    assert.equal(planEvents.some((event) => event.type === 'plan.completed'), false);
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
    const commands = await request(address, `/v1/commands?actionHash=${created.body.proposal.action.actionHash}`);
    assert.equal(commands.status, 200);
    assert.equal(commands.body.commands.length, 1);
    assert.equal(commands.body.commands[0].actionHash, created.body.proposal.action.actionHash);
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

test('Terminal 结果摘要在重启后可按会话读取，且不暴露 ledger 路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-http-command-result-recovery-'));
  const first = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const firstAddress = await first.listen();
  const created = await request(firstAddress, '/v1/proposals/command', { method: 'POST', body: JSON.stringify({ sessionId: 'terminal-session', argv: ['pwd'] }) });
  const approved = await request(firstAddress, `/v1/proposals/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': 'approve-token-012345' }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
  assert.equal(approved.status, 200);
  await first.close();
  const second = createWorkbenchServer({ root, token: 'test-token-012345', approvalToken: 'approve-token-012345' });
  const address = await second.listen();
  try {
    const commands = await request(address, '/v1/commands?sessionId=terminal-session');
    assert.equal(commands.status, 200);
    assert.equal(commands.body.commands.length, 1);
    assert.equal(commands.body.commands[0].status, 'verified');
    assert.equal(commands.body.commands[0].result.code, 0);
    assert.equal(typeof commands.body.commands[0].result.stdout, 'string');
    assert.equal('ledgerPath' in commands.body.commands[0], false);
    const otherSession = await request(address, '/v1/commands?sessionId=other-session');
    assert.deepEqual(otherSession.body.commands, []);
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
    assert.equal('root' in status.body, false);
    assert.deepEqual(status.body.persistedState.sessions, { total: 1, active: 0, closed: 0, manualReview: 1, interruptedTurns: 1 });
    assert.deepEqual(status.body.persistedState.proposals, { total: 0, manualReview: 0, executing: 0, terminal: 0 });
    assert.equal(status.body.persistedState.events.recovered, false);
    assert.equal(JSON.stringify(status.body.persistedState).includes('"id"'), false);
    assert.equal(JSON.stringify(status.body.persistedState).includes('"messages"'), false);
    await app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
