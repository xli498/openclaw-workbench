import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspaceToolRegistry } from '../runtime/workspace-tool-registry.mjs';

test('只读 workspace tool registry 提供列目录、读文件和搜索，并拒绝未知工具', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tools-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'README.md'), 'hello workbench');
    await writeFile(path.join(root, 'src', 'app.js'), 'hello app');
    const registry = await createWorkspaceToolRegistry({ root });
    const listed = await registry.call('workspace.list_files', { path: '.' });
    assert.deepEqual(listed.files.map((item) => item.path), ['README.md', 'src', 'src/app.js']);
    const file = await registry.call('workspace.read_file', { path: 'README.md' });
    assert.equal(file.content, 'hello workbench');
    const found = await registry.call('workspace.search', { query: 'hello' });
    assert.deepEqual(found.matches.map((item) => item.path), ['README.md', 'src/app.js']);
    await assert.rejects(() => registry.call('workspace.exec', {}), { code: 'TOOL_NOT_ALLOWED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：list path 不能被忽略或穿越，读取结果和列表结果必须有硬上限并脱敏', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-tools-red-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'app.js'), 'const token=super-secret-value;');
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(200_000));
    const registry = createWorkspaceToolRegistry({ root });
    const scoped = await registry.call('workspace.list_files', { path: 'src' });
    assert.deepEqual(scoped.files.map((item) => item.path), ['src', 'src/app.js']);
    await assert.rejects(() => registry.call('workspace.list_files', { path: '../' }), { code: 'TOOL_INPUT_INVALID' });
    const file = await registry.call('workspace.read_file', { path: 'src/app.js' });
    assert.doesNotMatch(file.content, /super-secret-value/);
    await assert.rejects(() => registry.call('workspace.read_file', { path: 'large.txt' }), { code: 'TOOL_RESULT_LIMIT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
