import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatSessionManager, SessionError } from '../runtime/session.mjs';

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
