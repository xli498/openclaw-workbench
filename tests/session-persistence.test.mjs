import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatSessionManager, SessionError } from '../runtime/session.mjs';
import { writeSnapshotAtomically } from '../runtime/snapshot-store.mjs';
import { symlinkOrSkip } from './test-support.mjs';

test('会话消息可原子持久化并在新 manager 中恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-store-'));
  try {
    const first = createChatSessionManager({ root, runAgentFn: async () => ({ text: 'answer' }) });
    const session = first.createSession({ mode: 'Ask' });
    await first.sendMessage({ sessionId: session.id, message: 'question' });
    const second = createChatSessionManager({ root });
    assert.equal(second.getSession(session.id).status, 'active');
    assert.deepEqual(second.listMessages(session.id).map((item) => item.content), ['question', { text: 'answer' }]);
    const snapshot = JSON.parse(await readFile(first.snapshotPath, 'utf8'));
    assert.equal(snapshot.version, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('恢复 busy 会话时降级为 manual_review，绝不自动重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-recover-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'sessions.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(storePath, JSON.stringify({ version: 1, sessions: [{ id: 'interrupted', workspaceId: root, mode: 'Code', actor: 'user', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'do not rerun', createdAt: '2026-01-01T00:00:00.000Z' }], running: true }] }));
    let calls = 0;
    const manager = createChatSessionManager({ root, runAgentFn: async () => { calls += 1; return {}; } });
    assert.equal(manager.getSession('interrupted').status, 'manual_review');
    assert.equal(manager.getSession('interrupted').recoveryReason, 'interrupted_turn');
    await assert.rejects(() => manager.sendMessage({ sessionId: 'interrupted', message: 'retry' }), { code: 'SESSION_NOT_ACTIVE' });
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝损坏会话快照，避免猜测性恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-invalid-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'sessions.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(storePath, '{not-json');
    assert.throws(() => createChatSessionManager({ root }), SessionError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('恢复 Debate 快照时校验角色、摘要、目标关联和裁判模型绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-debate-invalid-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'sessions.json');
    await mkdir(join(root, '.openclaw-workbench'));
    const item = (model, role, text, extra = {}) => ({ model, modelId: model, role, text, digest: 'forged-digest', ...extra });
    await writeFile(storePath, JSON.stringify({ version: 1, sessions: [{ id: 'debate', mode: 'Plan', status: 'active', messages: [], planResults: [{ id: 'p', question: 'q', analyses: [], failures: [], createdAt: '2026-01-01T00:00:00.000Z', debate: true, judgeModel: 'judge', synthesis: { judgeModel: 'judge' }, rounds: { proposals: [item('a', 'proposer', 'proposal')], critiques: [item('b', 'opposing_reviewer', 'critique', { targetModel: 'a', targetProposal: 'forged-digest' })], responses: [item('a', 'respondent', 'response', { targetModel: 'a', targetProposal: 'forged-digest' })], verdict: item('judge', 'judge', 'verdict') } }] }] }));
    assert.throws(() => createChatSessionManager({ root }), { code: 'SESSION_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('人工复核只恢复会话状态，不重放中断回合', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-review-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'sessions.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(storePath, JSON.stringify({ version: 1, sessions: [{ id: 'review-me', workspaceId: root, mode: 'Ask', actor: 'user', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'old turn', createdAt: '2026-01-01T00:00:00.000Z' }], running: true }] }));
    let calls = 0;
    const manager = createChatSessionManager({ root, runAgentFn: async () => { calls += 1; return { text: 'new only' }; } });
    assert.equal(manager.reviewSession('review-me', { decision: 'resume', reviewer: 'alice' }).status, 'active');
    assert.equal(calls, 0);
    await manager.sendMessage({ sessionId: 'review-me', message: 'fresh turn' });
    assert.equal(calls, 1);
    assert.throws(() => manager.reviewSession('review-me', { decision: 'resume' }), { code: 'REVIEW_NOT_REQUIRED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝重复会话 ID 和非法消息快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-invalid-shape-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'sessions.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(storePath, JSON.stringify({ version: 1, sessions: [
      { id: 'duplicate', mode: 'Ask', status: 'active', messages: [] },
      { id: 'duplicate', mode: 'Ask', status: 'active', messages: [{ role: 'tool', content: 'unsafe' }] },
    ] }));
    assert.throws(() => createChatSessionManager({ root }), { code: 'SESSION_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝指向工作区外的会话快照符号链接', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-session-outside-'));
  try {
    await mkdir(join(root, '.openclaw-workbench'));
    const target = join(outside, 'sessions.json');
    await writeFile(target, JSON.stringify({ version: 1, sessions: [] }));
    if (!await symlinkOrSkip(t, target, join(root, '.openclaw-workbench', 'sessions.json'))) return;
    assert.throws(() => createChatSessionManager({ root }), { code: 'SESSION_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('会话快照在首次写入和原子覆盖后保持 owner-only 权限', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows does not expose POSIX owner-only mode bits');
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-mode-'));
  try {
    const manager = createChatSessionManager({ root });
    manager.createSession();
    assert.equal((await stat(manager.snapshotPath)).mode & 0o777, 0o600);
    manager.createSession({ mode: 'Code' });
    assert.equal((await stat(manager.snapshotPath)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('会话快照写入遇到已有锁时保守拒绝，不覆盖现有状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-lock-'));
  try {
    const manager = createChatSessionManager({ root });
    await mkdir(`${manager.snapshotPath}.lock`, { recursive: true });
    assert.throws(() => manager.createSession(), { code: 'SESSION_STORE_BUSY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('两个会话 manager 基于不同快照版本写入时拒绝后写者覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-conflict-'));
  try {
    const first = createChatSessionManager({ root });
    const stale = createChatSessionManager({ root });
    const created = first.createSession();
    assert.throws(() => stale.createSession(), { code: 'SESSION_STORE_CONFLICT' });
    assert.throws(() => stale.getSession(created.id), { code: 'SESSION_NOT_FOUND' });
    const restored = createChatSessionManager({ root });
    assert.equal(restored.getSession(created.id).id, created.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('打开父目录后路径被替换为外部符号链接时，快照仍写入原目录 inode', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows native helper rejects a replaced visible parent path; inode anchoring is covered on POSIX');
  const root = await mkdtemp(join(tmpdir(), 'ocw-session-anchor-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-session-anchor-outside-'));
  try {
    const storeDir = join(root, '.openclaw-workbench');
    await mkdir(storeDir);
    const originalDir = `${storeDir}.old`;
    const storePath = join(storeDir, 'sessions.json');
    class SnapshotError extends Error { constructor(code) { super(code); this.code = code; } }
    writeSnapshotAtomically({
      root, storePath, payload: 'anchored', expectedDigest: null, ErrorType: SnapshotError,
      code: 'INVALID', message: 'invalid', busyCode: 'BUSY', busyMessage: 'busy', conflictCode: 'CONFLICT', conflictMessage: 'conflict',
      __testHooks: { onParentOpened: () => { renameSync(storeDir, originalDir); symlinkSync(outside, storeDir); } },
    });
    assert.equal(await readFile(join(originalDir, 'sessions.json'), 'utf8'), 'anchored');
    assert.equal(await readFile(join(outside, 'sessions.json'), 'utf8').catch(() => null), null);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
