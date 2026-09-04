import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyTextChange, ChangeError, rollbackTextChange } from '../runtime/change-engine.mjs';
import { createHash } from 'node:crypto';
import { symlinkOrSkip } from './test-support.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-change-'));
  await writeFile(path.join(root, 'a.txt'), 'old\n');
  return root;
}

test('文本变更先校验 hash，再快照并原子替换，支持回滚', async () => {
  const root = await fixture();
  const result = await applyTextChange({ root, relativePath: 'a.txt', expectedHash: hash('old\n'), nextContent: 'new\n' });
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'new\n');
  assert.equal(result.beforeHash, hash('old\n'));
  await rollbackTextChange({ root, relativePath: 'a.txt', snapshot: result.snapshot });
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old\n');
});

test('hash 不匹配时拒绝写入且不生成快照', async () => {
  const root = await fixture();
  await assert.rejects(() => applyTextChange({ root, relativePath: 'a.txt', expectedHash: 'bad', nextContent: 'new\n' }), (e) => e instanceof ChangeError && e.code === 'HASH_MISMATCH');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'old\n');
});

test('拒绝写入逃逸的符号链接', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-change-outside-'));
  await writeFile(path.join(outside, 'x.txt'), 'outside\n');
  if (!await symlinkOrSkip(t, path.join(outside, 'x.txt'), path.join(root, 'link.txt'))) return;
  await assert.rejects(() => applyTextChange({ root, relativePath: 'link.txt', expectedHash: hash('outside\n'), nextContent: 'bad' }), (e) => e.code === 'SYMLINK_ESCAPE');
});

test('拒绝越界路径', async () => {
  const root = await fixture();
  await assert.rejects(() => applyTextChange({ root, relativePath: '../x', expectedHash: hash('old\n'), nextContent: 'x' }), (e) => e.code === 'PATH_ESCAPE');
});

test('拒绝工作区外的 snapshot 目录', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-change-outside-'));
  await assert.rejects(() => applyTextChange({ root, relativePath: 'a.txt', expectedHash: hash('old\n'), nextContent: 'new\n', snapshotDir: outside }), (e) => e.code === 'PATH_ESCAPE');
});

test('回滚拒绝工作区外 snapshot 和逃逸符号链接', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'ocw-change-outside-'));
  const snapshot = path.join(outside, 'snapshot');
  await writeFile(snapshot, 'old\n');
  await assert.rejects(() => rollbackTextChange({ root, relativePath: 'a.txt', snapshot }), (e) => e.code === 'PATH_ESCAPE');
  const link = path.join(root, 'snapshot-link');
  if (!await symlinkOrSkip(t, snapshot, link)) return;
  await assert.rejects(() => rollbackTextChange({ root, relativePath: 'a.txt', snapshot: link }), (e) => e.code === 'SYMLINK_ESCAPE');
});
