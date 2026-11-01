import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectDiagnostics } from '../runtime/diagnostics.mjs';

test('诊断聚合只返回可展示的状态、哈希和脱敏审计', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-diagnostics-'));
  try {
    const result = await collectDiagnostics({
      root,
      now: () => new Date('2026-09-21T00:00:00.000Z'),
      openclaw: async () => ({ status: 'ready', version: '1.2.3', command: 'C:\\Users\\HP\\secret-token=bad\\openclaw.cmd' }),
      mcp: async () => ({ status: 'ready', serverCount: 1, servers: [{ name: 'safe-server', status: 'ready', endpoint: 'https://user:password@example.test' }] }),
      models: () => [{ id: 'main', enabled: true, endpoint: 'https://api.example.test', secretRef: 'env:OPENAI_KEY', health: { status: 'ready' } }],
      audit: { list: async () => [{ type: 'model.connected', actor: 'system', secret: 'secret-value', path: root, timestamp: '2026-09-21T00:00:00.000Z' }] },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.openclaw.version, '1.2.3');
    assert.equal(result.models.profiles[0].id, 'main');
    assert.equal(result.audit.events[0].type, 'model.connected');
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes('secret-value'), false);
    assert.equal(encoded.includes('OPENAI_KEY'), false);
    assert.equal(encoded.includes(root), false);
    assert.equal(encoded.includes('password'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('诊断组件失败时返回结构化 unavailable，不回显异常原文', async () => {
  const result = await collectDiagnostics({
    openclaw: async () => { throw Object.assign(new Error('token=secret-value C:\\private'), { code: 'CLI_FAILED' }); },
    mcp: async () => ({ status: 'unavailable', code: 'CLI_NOT_FOUND' }),
    models: () => { throw new Error('apiKey=secret-value'); },
    audit: { list: async () => { throw new Error('password=secret-value'); } },
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.openclaw.status, 'unavailable');
  assert.equal(result.openclaw.code, 'DIAGNOSTIC_UNAVAILABLE');
  assert.equal(result.models.status, 'unavailable');
  assert.equal(result.audit.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('诊断不会把任意模型或 MCP 配置字段原样透传', async () => {
  const result = await collectDiagnostics({
    models: () => [{ id: 'safe', enabled: false, provider: 'x', secretRef: 'keychain:private', nested: { token: 'secret' } }],
    mcpServers: () => [{ id: 'mcp', name: 'safe', enabled: true, command: 'curl --token secret', endpoint: 'https://example.test', envKeys: ['TOKEN'] }],
  });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('secret'), false);
  assert.equal(encoded.includes('curl'), false);
  assert.deepEqual(result.models.profiles, [{ id: 'safe', enabled: false, status: 'unknown' }]);
  assert.deepEqual(result.mcp.servers, [{ id: 'mcp', name: 'safe', enabled: true, status: 'unknown' }]);
});

test('MCP server 诊断探针失败时返回 unavailable，而不是伪装为空 ready', async () => {
  const result = await collectDiagnostics({
    mcpServers: async () => { throw Object.assign(new Error('provider failed'), { code: 'MCP_PROBE_FAILED' }); },
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.mcp.status, 'unavailable');
  assert.equal(result.mcp.code, 'DIAGNOSTIC_UNAVAILABLE');
});

test('诊断聚合保留 MCP/model 异常状态，并拒绝不安全的标签和 revision', async () => {
  const result = await collectDiagnostics({
    openclaw: () => ({ status: 'ready', version: '1.2.3' }),
    mcpServers: () => ({ status: 'error', code: 'MCP_BAD', servers: [{ id: 'https://user:password@example.test', name: 'server C:\\private', status: 'error' }] }),
    models: () => [{ id: 'env:OPENAI_KEY', enabled: true, health: { status: 'error' } }],
    workspace: () => ({ status: 'ready', workspaceRevision: `sha256:${'a'.repeat(64)}`, gitRevision: 'b'.repeat(40) }),
    audit: { list: () => [{ type: 'model.connected', actor: 'operator C:\\private', sessionId: 'https://user:password@example.test', status: 'error', path: 'C:\\private' }] },
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.mcp.status, 'degraded');
  assert.equal(result.models.status, 'degraded');
  assert.equal(result.workspace.status, 'ready');
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('password'), false);
  assert.equal(encoded.includes('OPENAI_KEY'), false);
  assert.equal(encoded.includes('C:\\private'), false);
  assert.equal(encoded.includes('https://'), false);
});

test('诊断将任意非 ready 的模型和 MCP 状态聚合为 degraded', async () => {
  const result = await collectDiagnostics({
    mcp: () => ({ status: 'ready', servers: [{ name: 'mcp', status: 'failed' }] }),
    models: () => ({ status: 'ready', profiles: [{ id: 'model', status: 'unavailable' }] }),
  });
  assert.equal(result.mcp.status, 'degraded');
  assert.equal(result.models.status, 'degraded');
});
