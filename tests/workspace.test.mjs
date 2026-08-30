import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
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
