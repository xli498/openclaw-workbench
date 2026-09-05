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
