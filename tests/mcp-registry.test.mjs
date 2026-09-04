import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpRegistry, McpRegistryError } from '../runtime/mcp-registry.mjs';
import { symlinkOrSkip } from './test-support.mjs';

function server(overrides = {}) {
  return {
    id: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    envKeys: ['HOME'],
    tools: ['read_file', 'list_directory'],
    permissions: { filesystem: false, network: false },
    ...overrides,
  };
}

test('注册表保存安全元数据且默认禁用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-registry-'));
  try {
    const registry = createMcpRegistry({ root });
    const created = registry.register(server());
    assert.equal(created.enabled, false);
    assert.deepEqual(created.envKeys, ['HOME']);
    assert.deepEqual(created.tools, ['read_file', 'list_directory']);
    assert.equal(created.health.status, 'unknown');
    assert.equal('env' in created, false);
    assert.equal(registry.list().length, 1);
    assert.deepEqual(createMcpRegistry({ root }).get('filesystem'), created);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('注册表接受不带凭据的 SSE endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-http-transport-'));
  try {
    const registry = createMcpRegistry({ root });
    const created = registry.register({ id: 'remote', name: 'Remote', transport: 'sse', endpoint: 'https://example.test/mcp', tools: [] });
    assert.equal(created.transport, 'sse');
    assert.deepEqual(created.args, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('注册表拒绝 shell 注入、凭据和不受控环境值', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-invalid-'));
  try {
    const registry = createMcpRegistry({ root });
    for (const value of ['node; whoami', 'node\nwhoami', 'node --token=secret', 'https://user:pass@example.test']) {
      assert.throws(() => registry.validate(server({ command: value })), (error) => error instanceof McpRegistryError && error.code === 'MCP_COMMAND_INVALID');
    }
    assert.throws(() => registry.validate(server({ command: 'node', args: ['--token', 'secret'] })), { code: 'MCP_ARGS_INVALID' });
    for (const key of ['token', 'access_token', 'client-secret', 'auth', 'bearer', 'key', 'apikey', 'clientsecret', 'xkey']) {
      assert.throws(() => registry.validate(server({ transport: 'sse', command: undefined, endpoint: `https://example.test/mcp?${key}=secret` })), { code: 'MCP_ENDPOINT_INVALID' });
    }
    assert.throws(() => registry.validate(server({ envKeys: ['API_KEY=secret'] })), { code: 'MCP_ENV_KEY_INVALID' });
    assert.throws(() => registry.validate(server({ tools: ['read_file', 'read_file'] })), { code: 'MCP_TOOLS_INVALID' });
    assert.throws(() => registry.validate(server({ tools: ['../read_file'] })), { code: 'MCP_TOOLS_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('注册表拒绝重复 ID、越界权限和未知 transport', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-duplicate-'));
  try {
    const registry = createMcpRegistry({ root });
    registry.register(server());
    assert.throws(() => registry.register(server()), { code: 'MCP_DUPLICATE' });
    assert.throws(() => registry.validate(server({ transport: 'ftp' })), { code: 'MCP_TRANSPORT_INVALID' });
    assert.throws(() => registry.validate(server({ permissions: { filesystem: 'yes' } })), { code: 'MCP_PERMISSIONS_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('工具授权要求当前配置哈希且只保留 allowlist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-authorize-'));
  try {
    const registry = createMcpRegistry({ root });
    const created = registry.register(server());
    assert.throws(() => registry.authorizeTools('filesystem', ['write_file'], 'wrong'), { code: 'MCP_CONFLICT' });
    const updated = registry.authorizeTools('filesystem', ['read_file'], created.configHash);
    assert.deepEqual(updated.tools, ['read_file']);
    assert.notEqual(updated.configHash, created.configHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('注册表快照符号链接被拒绝，不读取工作区外文件', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-mcp-outside-'));
  try {
    await mkdir(path.join(root, '.openclaw-workbench'), { recursive: true });
    const target = path.join(outside, 'registry.json');
    await writeFile(target, JSON.stringify({ version: 1, servers: [] }));
    if (!await symlinkOrSkip(t, target, path.join(root, '.openclaw-workbench', 'mcp-registry.json'))) return;
    assert.throws(() => createMcpRegistry({ root }), { code: 'MCP_REGISTRY_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
