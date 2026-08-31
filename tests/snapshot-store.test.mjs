import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSnapshot, snapshotDigest, writeSnapshotAtomically } from '../runtime/snapshot-store.mjs';

class SnapshotError extends Error { constructor(code) { super(code); this.code = code; } }
function write(root, storePath, overrides = {}) {
  return writeSnapshotAtomically({ root, storePath, payload: 'new', expectedDigest: null, ErrorType: SnapshotError, code: 'INVALID', message: 'invalid', busyCode: 'BUSY', busyMessage: 'busy', conflictCode: 'CONFLICT', conflictMessage: 'conflict', now: 10_000, staleLockMs: 100, ...overrides });
}

test('过期、活跃、损坏和符号链接 owner 锁均保守拒绝，要求人工恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-lock-'));
  try {
    const storePath = join(root, 'state.json');
    const lock = `${storePath}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: '11111111-1111-4111-8111-111111111111', startedAt: 1 }));
    assert.throws(() => write(root, storePath), { code: 'BUSY' });
    assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8').includes('11111111'), true);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: '22222222-2222-4222-8222-222222222222', startedAt: 9_999 }));
    assert.throws(() => write(root, storePath), { code: 'BUSY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('损坏或符号链接 owner 不能触发 stale 回收', async () => {
  for (const owner of ['{broken', null]) {
    const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-owner-'));
    try {
      const storePath = join(root, 'state.json'); const lock = `${storePath}.lock`;
      mkdirSync(lock);
      if (owner === null) { writeFileSync(join(root, 'outside-owner'), '{}'); symlinkSync(join(root, 'outside-owner'), join(lock, 'owner.json')); }
      else writeFileSync(join(lock, 'owner.json'), owner);
      assert.throws(() => write(root, storePath), { code: 'BUSY' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('恢复读取锚定父目录并拒绝末级符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-read-'));
  try {
    const state = join(root, 'state'); const storePath = join(state, 'snapshot.json');
    mkdirSync(state); writeFileSync(storePath, 'safe');
    const result = readSnapshot({ root, storePath, ErrorType: SnapshotError, code: 'INVALID', message: 'invalid', __testHooks: { onParentOpened() {
      renameSync(state, `${state}.old`); mkdirSync(state); writeFileSync(storePath, 'attacker');
    } } });
    assert.equal(result.content, 'safe');
    unlinkSync(storePath); symlinkSync(join(root, 'outside'), storePath);
    assert.throws(() => readSnapshot({ root, storePath, ErrorType: SnapshotError, code: 'INVALID', message: 'invalid' }), { code: 'INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('读取逐级拒绝嵌套祖先符号链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-nested-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-snapshot-nested-outside-'));
  try {
    mkdirSync(join(outside, 'inner')); writeFileSync(join(outside, 'inner', 'snapshot.json'), 'outside');
    mkdirSync(join(root, 'state')); symlinkSync(join(outside, 'inner'), join(root, 'state', 'nested'));
    assert.throws(() => readSnapshot({ root, storePath: join(root, 'state', 'nested', 'snapshot.json'), ErrorType: SnapshotError, code: 'INVALID', message: 'invalid' }), { code: 'INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('stale 锁 inode 确认后出现 successor 时，successor 保持在活 lockName 且写者不得取得锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-aba-'));
  try {
    const nested = join(root, 'new', 'state.json');
    assert.equal(write(root, nested), snapshotDigest('new'));
    const storePath = join(root, 'state.json'); const lock = `${storePath}.lock`;
    mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: '33333333-3333-4333-8333-333333333333', startedAt: 1 }));
    assert.throws(() => write(root, storePath, { __testHooks: { afterStaleLockVerified() {
      renameSync(lock, `${lock}.replaced`); mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: '44444444-4444-4444-8444-444444444444', startedAt: 1 }));
    } } }), { code: 'BUSY' });
    assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8').includes('44444444'), true);
    assert.equal(readFileSync(join(`${lock}.replaced`, 'owner.json'), 'utf8').includes('33333333'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('写入 current digest 时拒绝末级外链且绝不读取或覆盖外部', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-snapshot-write-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-snapshot-outside-'));
  try {
    const storePath = join(root, 'state.json'); const outsideFile = join(outside, 'digest.txt');
    writeFileSync(storePath, 'safe'); writeFileSync(outsideFile, 'outside');
    assert.throws(() => write(root, storePath, { expectedDigest: snapshotDigest('safe'), __testHooks: { beforeCurrentDigestOpen() {
      unlinkSync(storePath); symlinkSync(outsideFile, storePath);
    } } }), { code: 'INVALID' });
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
