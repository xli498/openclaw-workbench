import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServerRuntime } from '../runtime/mcp-runtime.mjs';

test('红队攻击：工具名和 configHash 篡改不能绕过 MCP runtime 门禁', async () => {
  let current = { id: 'target', name: 'Target', transport: 'stdio', command: 'node', args: [], tools: ['read_file'], configHash: 'c'.repeat(64), enabled: true };
  const transport = { async start() {}, async close() {}, async request() { throw new Error('should not execute'); } };
  const runtime = createMcpServerRuntime({ registry: { get: () => ({ ...current }) }, transportFactory: () => transport });
  await runtime.start('target', { expectedConfigHash: current.configHash, approved: true });
  for (const tool of ['write_file', '../read_file', 'read_file\u0000']) {
    await assert.rejects(runtime.callTool('target', tool, {}, { expectedConfigHash: current.configHash, approved: true }), (error) => error.code === 'MCP_TOOL_NOT_AUTHORIZED');
  }
  await assert.rejects(runtime.callTool('target', 'read_file', {}, { expectedConfigHash: 'd'.repeat(64), approved: true }), { code: 'MCP_CONFLICT' });
  current = { ...current, configHash: 'd'.repeat(64), command: 'other-server' };
  await assert.rejects(runtime.callTool('target', 'read_file', {}, { expectedConfigHash: current.configHash, approved: true }), { code: 'MCP_CONFLICT' });
  current = { ...current, enabled: false, configHash: 'e'.repeat(64) };
  await runtime.stop('target');
  await assert.rejects(runtime.start('target', { expectedConfigHash: current.configHash, approved: true }), { code: 'MCP_SERVER_DISABLED' });
});
