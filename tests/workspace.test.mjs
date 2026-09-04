import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../runtime/workspace.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-'));
  await writeFile(path.join(root, 'ok.txt'), 'hello');
  await writeFile(path.join(root, '.env'), 'SECRET=hidden');
  await mkdir(path.join(root, 'subdir'));
  return root;
}

test('工作区读取正常文件并返回安全元数据', async () => {
  const ws = await createWorkspace(await fixture());
  assert.equal(await ws.read('ok.txt'), 'hello');
  assert.deepEqual(await ws.inspect('ok.txt'), { path: 'ok.txt', size: 5, isFile: true, isDirectory: false });
});

test('拦截绝对路径、路径穿越和敏感文件', async () => {
  const ws = await createWorkspace(await fixture());
  await assert.rejects(() => ws.read('../outside'), (e) => e.code === 'PATH_ESCAPE');
  await assert.rejects(() => ws.read('/etc/passwd'), (e) => e.code === 'INVALID_PATH');
  await assert.rejects(() => ws.read('.env'), (e) => e.code === 'SENSITIVE_PATH');
});

test('拦截符号链接逃逸', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const ws = await createWorkspace(root);
  await assert.rejects(() => ws.read('link.txt'), (e) => e.code === 'SYMLINK_ESCAPE');
});

test('限制单文件读取大小，并拒绝目录读取', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'large.txt'), '123456');
  const ws = await createWorkspace(root, { maxReadBytes: 5 });
  await assert.rejects(() => ws.read('large.txt'), (e) => e.code === 'READ_LIMIT');
  await assert.rejects(() => ws.read('subdir'), (e) => e.code === 'NOT_A_FILE');
});

test('读取 Git revision；非 Git 工作区返回 null', async () => {
  const ws = await createWorkspace(await fixture());
  assert.equal(await ws.gitRevision(), null);
});

test('非 Git 工作区 revision 绑定普通内容变化并忽略内部状态和敏感文件', async () => {
  const root = await fixture();
  const ws = await createWorkspace(root);
  const initial = await ws.workspaceRevision();
  assert.match(initial, /^sha256:[a-f0-9]{64}$/);
  await writeFile(path.join(root, 'ok.txt'), 'changed');
  const changed = await ws.workspaceRevision();
  assert.notEqual(changed, initial);
  await mkdir(path.join(root, '.openclaw-workbench'));
  await writeFile(path.join(root, '.openclaw-workbench', 'runtime.json'), 'volatile');
  await writeFile(path.join(root, '.env'), 'SECRET=changed');
  assert.equal(await ws.workspaceRevision(), changed);
});

test('非 Git 工作区 revision 拒绝指向工作区外的符号链接', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-revision-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  const ws = await createWorkspace(root);
  await assert.rejects(() => ws.workspaceRevision(), (error) => error.code === 'SYMLINK_ESCAPE');
});

test('非 Git 工作区 revision 拒绝经别名读取敏感文件', async () => {
  const root = await fixture();
  await symlink(path.join(root, '.env'), path.join(root, 'innocent.txt'));
  const ws = await createWorkspace(root);
  await assert.rejects(() => ws.workspaceRevision(), (error) => error.code === 'SENSITIVE_PATH');
});

test('workspace revision 对扫描条目和字节数设置硬上限', async () => {
  const root = await fixture();
  const entriesLimited = await createWorkspace(root, { maxRevisionEntries: 1 });
  await assert.rejects(() => entriesLimited.workspaceRevision(), (error) => error.code === 'REVISION_LIMIT');
  const bytesLimited = await createWorkspace(root, { maxRevisionBytes: 2 });
  await assert.rejects(() => bytesLimited.workspaceRevision(), (error) => error.code === 'REVISION_LIMIT');
});

test('工作区内容 revision 识别修改、新增和删除', async () => {
  const root = await fixture();
  await new Promise((resolve, reject) => execFile('git', ['init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['add', 'ok.txt'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const ws = await createWorkspace(root);
  const initial = await ws.workspaceRevision();
  await writeFile(path.join(root, 'ok.txt'), 'changed');
  const modified = await ws.workspaceRevision();
  assert.notEqual(modified, initial);
  await writeFile(path.join(root, 'new.txt'), 'new');
  const added = await ws.workspaceRevision();
  assert.notEqual(added, modified);
  await rm(path.join(root, 'ok.txt'));
  const deleted = await ws.workspaceRevision();
  assert.notEqual(deleted, added);
});

test('Git 工作区 revision 拒绝经已跟踪别名读取敏感文件', async () => {
  const root = await fixture();
  await symlink(path.join(root, '.env'), path.join(root, 'alias.txt'));
  await new Promise((resolve, reject) => execFile('git', ['init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['add', 'alias.txt'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'alias'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  const ws = await createWorkspace(root);
  await assert.rejects(() => ws.workspaceRevision(), (error) => error.code === 'SENSITIVE_PATH');
});

test('Git 工作区 revision 同样执行条目与字节预算', async () => {
  const root = await fixture();
  await new Promise((resolve, reject) => execFile('git', ['init'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['add', 'ok.txt'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'budget'], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await assert.rejects(() => createWorkspace(root, { maxRevisionEntries: 0 }).then((ws) => ws.workspaceRevision()), (error) => error.code === 'REVISION_LIMIT');
  await assert.rejects(() => createWorkspace(root, { maxRevisionBytes: 2 }).then((ws) => ws.workspaceRevision()), (error) => error.code === 'REVISION_LIMIT');
});
