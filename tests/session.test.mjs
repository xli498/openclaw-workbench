import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatSessionManager, SessionError } from '../runtime/session.mjs';

test('Chat 会话遵守 Ask/Plan/Code 模式并通过 Adapter 记录消息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-session-'));
  const calls = [];
  const manager = createChatSessionManager({ root, runAgentFn: async (input) => { calls.push(input); return { text: 'ok' }; } });
  const session = manager.createSession({ mode: 'Plan' });
  const result = await manager.sendMessage({ sessionId: session.id, message: '设计方案' });
  assert.equal(result.session.mode, 'Plan');
  assert.equal(result.message.role, 'assistant');
  assert.equal(calls[0].sessionKey, session.id);
  assert.equal(calls[0].mode, 'Plan');
  assert.equal(calls[0].local, true);
  assert.equal(manager.listMessages(session.id).length, 2);
  assert.throws(() => manager.createSession({ mode: 'Unknown' }), (error) => error instanceof SessionError && error.code === 'INVALID_MODE');
});

test('Chat 会话失败时不残留用户半轮消息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-session-fail-'));
  const manager = createChatSessionManager({ root, runAgentFn: async () => { throw new Error('adapter failed'); } });
  const session = manager.createSession({ mode: 'Ask' });
  await assert.rejects(() => manager.sendMessage({ sessionId: session.id, message: '读取' }));
  assert.equal(manager.listMessages(session.id).length, 0);
});
