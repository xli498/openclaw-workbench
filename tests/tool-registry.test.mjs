import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRegistry } from '../runtime/tool-registry.mjs';

test('统一工具注册表按模式暴露八类有界工具', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-registry-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), 'hello workbench\n');
    await writeFile(path.join(root, 'src', 'app.mjs'), 'export const hello = true;\n');
    const registry = createToolRegistry({ root });
    assert.deepEqual(registry.names({ mode: 'Ask' }), [
      'workspace.list_directory', 'workspace.find_files', 'workspace.search_files',
      'workspace.read_files', 'workspace.diagnostics', 'workspace.progress',
    ]);
    assert.deepEqual(registry.names({ mode: 'Code' }).slice(-2), ['workspace.patch', 'workspace.command']);
    assert.equal(registry.definitions({ mode: 'Code' }).length, 8);
    const listed = await registry.call({ mode: 'Ask', name: 'workspace.list_directory', input: { path: 'src' }, sessionId: 's' });
    assert.deepEqual(listed.entries.map((entry) => entry.path), ['src/app.mjs']);
    const found = await registry.call({ mode: 'Plan', name: 'workspace.find_files', input: { pattern: '*.mjs' }, sessionId: 's' });
    assert.deepEqual(found.files, ['src/app.mjs']);
    const searched = await registry.call({ mode: 'Ask', name: 'workspace.search_files', input: { query: 'hello' }, sessionId: 's' });
    assert.deepEqual(searched.matches.map((match) => match.path), ['README.md', 'src/app.mjs']);
    const files = await registry.call({ mode: 'Ask', name: 'workspace.read_files', input: { paths: ['README.md'] }, sessionId: 's' });
    assert.equal(files.files[0].content, 'hello workbench\n');
    const diagnostics = await registry.call({ mode: 'Ask', name: 'workspace.diagnostics', input: {}, sessionId: 's' });
    assert.match(diagnostics.workspaceRevision, /^(?:sha256:|[0-9a-f]{40}$)/);
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'hello workbench\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('统一 registry 将 legacy workspace alias 转换为 canonical 工具并保留兼容结果', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-alias-'));
  try {
    await writeFile(path.join(root, 'README.md'), 'alias result\n');
    const registry = createToolRegistry({ root });
    const file = await registry.call({ mode: 'Ask', name: 'workspace.read_file', input: { path: 'README.md' }, sessionId: 's' });
    assert.deepEqual(file, { path: 'README.md', content: 'alias result\n' });
    const listed = await registry.call({ mode: 'Ask', name: 'workspace.list_files', input: { path: '.' }, sessionId: 's' });
    assert.deepEqual(listed.files.map((entry) => entry.path), ['README.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：legacy read alias 的非对象参数仍返回统一工具输入错误', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-alias-invalid-'));
  try {
    const registry = createToolRegistry({ root });
    for (const input of [null, [], 'README.md']) {
      await assert.rejects(() => registry.call({ mode: 'Ask', name: 'workspace.read_file', input, sessionId: 's' }), { code: 'TOOL_INPUT_INVALID' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Code 写工具只创建可审批提案，Ask 和 Plan 不能调用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-proposal-'));
  const proposals = [];
  try {
    await writeFile(path.join(root, 'a.txt'), 'before\n');
    const registry = createToolRegistry({ root, onProposal: async (proposal) => proposals.push(proposal) });
    const input = { patch: '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-before\n+after', declaredPaths: ['a.txt'] };
    await assert.rejects(() => registry.call({ mode: 'Ask', name: 'workspace.patch', input, sessionId: 's' }), { code: 'TOOL_MODE_DENIED' });
    await assert.rejects(() => registry.call({ mode: 'Plan', name: 'workspace.command', input: { argv: ['git', 'status'] }, sessionId: 's' }), { code: 'TOOL_MODE_DENIED' });
    const result = await registry.call({ mode: 'Code', name: 'workspace.patch', input, sessionId: 's' });
    assert.equal(result.approvalRequired, true);
    assert.equal(result.proposal.status, 'awaiting_approval');
    assert.equal(proposals.length, 1);
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'before\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：内部状态、大小写变体和 JSON 引号形式的密钥不会被工具返回', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-internal-'));
  try {
    await mkdir(path.join(root, '.openclaw-workbench'));
    await writeFile(path.join(root, '.openclaw-workbench', 'sessions.json'), 'INTERNAL_SESSION_MARKER');
    await writeFile(path.join(root, 'secrets.txt'), '{"token":"JSON_TOKEN_MARKER","apiKey":"JSON_API_MARKER","password":"JSON_PASSWORD_MARKER"}');
    const registry = createToolRegistry({ root });
    await assert.rejects(() => registry.call({ mode: 'Ask', name: 'workspace.read_files', input: { paths: ['.openclaw-workbench/sessions.json'] }, sessionId: 's' }), { code: 'TOOL_INPUT_INVALID' });
    await assert.rejects(() => registry.call({ mode: 'Ask', name: 'workspace.read_files', input: { paths: ['.OPENCLAW-WORKBENCH/sessions.json'] }, sessionId: 's' }), { code: 'TOOL_INPUT_INVALID' });
    const result = await registry.call({ mode: 'Ask', name: 'workspace.read_files', input: { paths: ['secrets.txt'] }, sessionId: 's' });
    assert.doesNotMatch(JSON.stringify(result), /JSON_(?:TOKEN|API|PASSWORD)_MARKER/);
    assert.match(result.files[0].content, /\[redacted\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：Windows Alternate Data Stream 路径不能绕过敏感文件边界', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows ADS regression');
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tool-ads-'));
  try {
    await writeFile(path.join(root, '.env'), 'BASE_ENV_MARKER');
    await writeFile(path.join(root, '.env:secret'), 'ADS_SECRET_MARKER');
    const registry = createToolRegistry({ root });
    await assert.rejects(() => registry.call({ mode: 'Ask', name: 'workspace.read_files', input: { paths: ['.env:secret'] }, sessionId: 's' }), { code: 'TOOL_INPUT_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
