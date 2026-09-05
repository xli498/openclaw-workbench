import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

const TOKEN = 'test-token-012345';
const APPROVAL = 'approve-token-012345';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) } });
  return { status: response.status, body: await response.json() };
}

function input(overrides = {}) {
  return { sessionId: 'mcp-session', id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: ['server-filesystem'], envKeys: ['HOME'], tools: ['read_file'], permissions: { filesystem: false, network: false }, ...overrides };
}

function fakeMcpTransport() {
  return {
    starts: 0,
    closes: 0,
    requests: [],
    async start() { this.starts += 1; },
    async request(method, params) { this.requests.push({ method, params }); return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() { this.closes += 1; },
  };
}

test('MCP 注册先生成审批提案，正确审批后仍保持 disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-http-'));
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input()) });
    assert.equal(created.status, 201);
    assert.equal(created.body.proposal.action.status, 'awaiting_approval');
    assert.equal(created.body.proposal.server.enabled, false);
    assert.deepEqual((await request(address, '/v1/mcp/servers')).body.servers, []);
    const approved = await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.server.enabled, false);
    assert.equal((await request(address, '/v1/mcp/servers')).body.servers[0].id, 'filesystem');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP 审批拒绝 token 互换、actionHash 篡改和重复重放', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-http-replay-'));
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'safe' })) });
    const swapped = await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(swapped.status, 403);
    const tampered = await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: '0'.repeat(64) }) });
    assert.equal(tampered.status, 409);
    const approved = await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    const replay = await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    assert.equal(replay.status, 404);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP 健康检查默认不启动 Server，注入探针只收到安全元数据', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-health-'));
  let probeInput;
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, inspectMcpServerFn: async (input) => { probeInput = input; return { status: 'ready' }; } });
  const address = await app.listen();
  try {
    const missing = await request(address, '/v1/mcp/servers/missing/health');
    assert.equal(missing.status, 404);
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'health' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const health = await request(address, '/v1/mcp/servers/health/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.health, { status: 'ready' });
    assert.equal('env' in probeInput, false);
    assert.equal(probeInput.server.command, 'npx');
    assert.equal(probeInput.server.enabled, false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP 工具授权必须审批并绑定当前配置哈希', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-tools-'));
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'tools' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const current = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const missingTools = await request(address, '/v1/mcp/servers/tools/authorize', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: current.configHash }) });
    assert.equal(missingTools.status, 400);
    assert.equal(missingTools.body.error, 'MCP_TOOLS_INVALID');
    const proposal = await request(address, '/v1/mcp/servers/tools/authorize', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: current.configHash, tools: ['read_file'] }) });
    assert.equal(proposal.status, 201);
    assert.equal(proposal.body.proposal.action.status, 'awaiting_approval');
    const approved = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body.server.tools, ['read_file']);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP 启用和停用必须单独审批并绑定 configHash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-enable-http-'));
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'toggle' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const current = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const proposal = await request(address, '/v1/mcp/servers/toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: current.configHash }) });
    assert.equal(proposal.status, 201);
    assert.equal((await request(address, '/v1/mcp/servers')).body.servers[0].enabled, false);
    const bad = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: '0'.repeat(64) }) });
    assert.equal(bad.status, 409);
    const approved = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.server.enabled, true);
    const disabled = await request(address, '/v1/mcp/servers/toggle/disable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: approved.body.server.configHash }) });
    assert.equal(disabled.status, 201);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：MCP 启用不能用控制 token、旧 hash 或重复审批绕过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-enable-red-team-'));
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'red-toggle' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    const current = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const proposal = await request(address, '/v1/mcp/servers/red-toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: current.configHash }) });
    const swapped = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(swapped.status, 403);
    const tampered = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: '0'.repeat(64) }) });
    assert.equal(tampered.status, 409);
    const changed = await request(address, '/v1/mcp/servers/red-toggle/authorize', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: current.configHash, tools: ['list_files'] }) });
    assert.equal(changed.status, 201);
    const changedApproved = await request(address, `/v1/mcp/servers/${changed.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: changed.body.proposal.action.actionHash }) });
    assert.equal(changedApproved.status, 200);
    const stale = await request(address, `/v1/mcp/servers/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(stale.status, 409);
    assert.equal((await request(address, '/v1/mcp/servers')).body.servers[0].enabled, false);
    const latest = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const approvedProposal = await request(address, '/v1/mcp/servers/red-toggle/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: latest.configHash }) });
    const approved = await request(address, `/v1/mcp/servers/${approvedProposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: approvedProposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    const replay = await request(address, `/v1/mcp/servers/${approvedProposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: approvedProposal.body.proposal.action.actionHash }) });
    assert.equal(replay.status, 404);
    assert.equal((await request(address, '/v1/mcp/servers')).body.servers[0].enabled, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP runtime 控制面以审批驱动 start、call 和 stop，并只返回公开状态', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-runtime-http-'));
  const transport = fakeMcpTransport();
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, mcpTransportFactory: () => transport });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'runtime', tools: ['read_file'] })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    let server = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const enabled = await request(address, '/v1/mcp/servers/runtime/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    const enabledResult = await request(address, `/v1/mcp/servers/${enabled.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) });
    server = enabledResult.body.server;
    assert.deepEqual((await request(address, '/v1/mcp/runtimes')).body.runtimes, []);
    const start = await request(address, '/v1/mcp/servers/runtime/start', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    assert.equal(start.status, 201);
    assert.equal(start.body.proposal.operation, 'runtime_start');
    assert.equal(JSON.stringify(start.body).includes('server-filesystem'), false);
    const started = await request(address, `/v1/mcp/servers/${start.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: start.body.proposal.action.actionHash }) });
    assert.equal(started.status, 200);
    assert.deepEqual(started.body.runtime, { id: 'runtime', transport: 'stdio', state: 'ready' });
    const call = await request(address, '/v1/mcp/servers/runtime/call', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash, tool: 'read_file', input: { path: 'secret.txt', token: 'hidden-value' } }) });
    assert.equal(call.status, 201);
    assert.equal(call.body.proposal.operation, 'runtime_call');
    assert.equal(call.body.proposal.input, undefined);
    assert.equal(JSON.stringify(call.body).includes('hidden-value'), false);
    const called = await request(address, `/v1/mcp/servers/${call.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: call.body.proposal.action.actionHash }) });
    assert.equal(called.status, 200);
    assert.deepEqual(called.body.result, { content: [{ type: 'text', text: 'ok' }] });
    assert.equal(transport.requests.length, 1);
    const stop = await request(address, '/v1/mcp/servers/runtime/stop', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    const stopped = await request(address, `/v1/mcp/servers/${stop.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: stop.body.proposal.action.actionHash }) });
    assert.equal(stopped.status, 200);
    assert.deepEqual((await request(address, '/v1/mcp/runtimes')).body.runtimes, []);
    assert.equal(transport.closes, 1);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：MCP runtime 控制面拒绝错误凭据、旧 hash 和未授权工具', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-runtime-red-http-'));
  const transport = fakeMcpTransport();
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, mcpTransportFactory: () => transport });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'runtime-red', tools: ['read_file'] })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    let server = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const enabled = await request(address, '/v1/mcp/servers/runtime-red/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    const enabledResult = await request(address, `/v1/mcp/servers/${enabled.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) });
    server = enabledResult.body.server;
    const start = await request(address, '/v1/mcp/servers/runtime-red/start', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    const swapped = await request(address, `/v1/mcp/servers/${start.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: start.body.proposal.action.actionHash }) });
    assert.equal(swapped.status, 403);
    const stale = await request(address, '/v1/mcp/servers/runtime-red/authorize', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash, tools: ['list_files'] }) });
    const changed = await request(address, `/v1/mcp/servers/${stale.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: stale.body.proposal.action.actionHash }) });
    server = changed.body.server;
    const oldStart = await request(address, `/v1/mcp/servers/${start.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: start.body.proposal.action.actionHash }) });
    assert.equal(oldStart.status, 409);
    const unauthorized = await request(address, '/v1/mcp/servers/runtime-red/call', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash, tool: 'read_file', input: {} }) });
    assert.equal(unauthorized.status, 201);
    const unauthorizedResult = await request(address, `/v1/mcp/servers/${unauthorized.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: unauthorized.body.proposal.action.actionHash }) });
    assert.equal(unauthorizedResult.status, 409);
    assert.equal(transport.starts, 0);
    assert.equal(transport.requests.length, 0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：并发 MCP runtime 审批只能执行一次', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-runtime-race-http-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const transport = { starts: 0, requests: 0, async start() { this.starts += 1; }, async request() { this.requests += 1; await gate; return { content: [{ type: 'text', text: 'ok' }] }; }, async close() {} };
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, mcpTransportFactory: () => transport });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'runtime-race' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    let server = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const enabled = await request(address, '/v1/mcp/servers/runtime-race/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    server = (await request(address, `/v1/mcp/servers/${enabled.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) })).body.server;
    const start = await request(address, '/v1/mcp/servers/runtime-race/start', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    await request(address, `/v1/mcp/servers/${start.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: start.body.proposal.action.actionHash }) });
    const call = await request(address, '/v1/mcp/servers/runtime-race/call', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash, tool: 'read_file', input: {} }) });
    const approvalBody = { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: call.body.proposal.action.actionHash }) };
    const first = request(address, `/v1/mcp/servers/${call.body.proposal.action.id}/approve`, approvalBody);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await request(address, `/v1/mcp/servers/${call.body.proposal.action.id}/approve`, approvalBody);
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200);
    assert.equal(transport.requests, 1);
  } finally { release?.(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('MCP runtime 控制面将 transport 超时映射为 504', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-runtime-error-http-'));
  const transport = { async start() {}, async request() { const error = new Error('transport timeout'); error.code = 'MCP_REQUEST_TIMEOUT'; throw error; }, async close() {} };
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL, mcpTransportFactory: () => transport });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/mcp/servers', { method: 'POST', body: JSON.stringify(input({ id: 'runtime-error' })) });
    await request(address, `/v1/mcp/servers/${created.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }) });
    let server = (await request(address, '/v1/mcp/servers')).body.servers[0];
    const enabled = await request(address, '/v1/mcp/servers/runtime-error/enable', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    server = (await request(address, `/v1/mcp/servers/${enabled.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: enabled.body.proposal.action.actionHash }) })).body.server;
    const start = await request(address, '/v1/mcp/servers/runtime-error/start', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash }) });
    await request(address, `/v1/mcp/servers/${start.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: start.body.proposal.action.actionHash }) });
    const call = await request(address, '/v1/mcp/servers/runtime-error/call', { method: 'POST', body: JSON.stringify({ sessionId: 'mcp-session', configHash: server.configHash, tool: 'read_file', input: {} }) });
    const failed = await request(address, `/v1/mcp/servers/${call.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: call.body.proposal.action.actionHash }) });
    assert.equal(failed.status, 504);
    assert.equal(failed.body.error, 'MCP_REQUEST_TIMEOUT');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
