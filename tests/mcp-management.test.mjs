import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpRegistry } from '../runtime/mcp-registry.mjs';
import { createMcpServerRuntime } from '../runtime/mcp-runtime.mjs';
import { createWorkbenchServer } from '../runtime/http-server.mjs';

function serverInput(overrides = {}) {
  return { id: 'demo', name: 'demo', transport: 'stdio', command: 'node', args: ['server.mjs'], tools: ['tool-a'], ...overrides };
}

test('MCP registry update resets enablement and remove requires the current hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-mgmt-'));
  try {
    const registry = createMcpRegistry({ root });
    const created = registry.register(serverInput());
    const enabled = registry.setEnabled('demo', true, created.configHash);
    assert.equal(enabled.enabled, true);
    const updated = registry.update('demo', serverInput({ command: 'node', args: ['server2.mjs'] }), enabled.configHash);
    assert.equal(updated.enabled, false);
    assert.notEqual(updated.configHash, enabled.configHash);
    assert.equal(updated.health.status, 'unknown');
    assert.throws(() => registry.update('demo', serverInput(), enabled.configHash), { code: 'MCP_CONFLICT' });
    assert.throws(() => registry.remove('demo', enabled.configHash), { code: 'MCP_CONFLICT' });
    assert.deepEqual(registry.remove('demo', updated.configHash), { id: 'demo', removed: true });
    assert.equal(registry.get('demo'), null);
    assert.throws(() => registry.update('demo', serverInput(), updated.configHash), { code: 'MCP_NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP runtime listTools marks authorized tools and never authorizes by listing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-list-'));
  try {
    const registry = createMcpRegistry({ root });
    const created = registry.register(serverInput());
    registry.setEnabled('demo', true, created.configHash);
    const current = registry.get('demo');
    const transport = {
      start: async () => {},
      close: async () => {},
      request: async (method) => {
        assert.equal(method, 'tools/list');
        return { tools: [{ name: 'tool-a' }, { name: 'tool-secret' }] };
      },
    };
    const runtime = createMcpServerRuntime({ registry, transportFactory: () => transport });
    await runtime.start('demo', { expectedConfigHash: current.configHash, approved: true });
    const listed = await runtime.listTools('demo', { expectedConfigHash: current.configHash, approved: true });
    assert.deepEqual(listed.tools, [
      { name: 'tool-a', authorized: true },
      { name: 'tool-secret', authorized: false },
    ]);
    await assert.rejects(runtime.callTool('demo', 'tool-secret', {}, { expectedConfigHash: current.configHash, approved: true }), (error) => error.code === 'MCP_TOOL_NOT_AUTHORIZED');
    await runtime.stop('demo');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('MCP control plane proposes, approves, and removes a server only when stopped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-http-mgmt-'));
  const TOKEN = 'mgmt-plane-token-987654';
  const APPROVAL = 'mgmt-approve-token-987654';
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  const call = async (pathname, options = {}) => {
    const response = await fetch(`http://${address.address}:${address.port}${pathname}`, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  };
  try {
    const proposed = await call('/v1/mcp/servers', { method: 'POST', body: JSON.stringify({ sessionId: 's1', ...serverInput() }) });
    assert.equal(proposed.status, 201);
    const action = proposed.body.proposal.action;
    const approved = await call(`/v1/mcp/servers/${action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: action.actionHash }) });
    assert.equal(approved.status, 200);
    const listed = await call('/v1/mcp/servers');
    assert.equal(listed.body.servers.length, 1);
    const current = listed.body.servers[0];
    const removeProposal = await call('/v1/mcp/servers/demo/remove', { method: 'POST', body: JSON.stringify({ sessionId: 's1', configHash: current.configHash }) });
    assert.equal(removeProposal.status, 201);
    const removed = await call(`/v1/mcp/servers/${removeProposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: removeProposal.body.proposal.action.actionHash }) });
    assert.equal(removed.status, 200);
    assert.equal((await call('/v1/mcp/servers')).body.servers.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
