import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('外部 AbortSignal 会取消 Chat 回合并清理半轮消息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-session-external-abort-'));
  const external = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const manager = createChatSessionManager({ root, runAgentFn: async ({ signal }) => await new Promise((resolve, reject) => { markStarted(); signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true }); }) });
  try {
    const session = manager.createSession({ mode: 'Ask' });
    const turn = manager.sendMessage({ sessionId: session.id, message: 'long', signal: external.signal });
    await started;
    external.abort();
    await assert.rejects(turn, { code: 'ABORTED' });
    assert.deepEqual(manager.listMessages(session.id), []);
    assert.throws(() => manager.cancelTurn(session.id), { code: 'NO_RUNNING_TURN' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Plan 超时后等待忽略 abort 的底层 runner 排水，排水完成后才允许下一回合', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-session-plan-drain-'));
  try {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let firstTurn = true;
    let started = 0;
    const manager = createChatSessionManager({
      root,
      runAgentFn: async ({ signal }) => {
        if (!firstTurn) return { text: 'ok' };
        started += 1;
        await blocked;
        return { text: 'late result despite abort' };
      },
    });
    const session = manager.createSession({ mode: 'Plan' });
    const turn = manager.planReview({ sessionId: session.id, question: 'long review', models: ['a', 'b'], debate: true, timeoutSeconds: 0.01 });
    while (started < 2) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(turn, { code: 'DEBATE_FAILED' });
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, message: 'must wait' }), { code: 'SESSION_BUSY' });

    release();
    await new Promise((resolve) => setImmediate(resolve));
    firstTurn = false;
    const result = await manager.sendMessage({ sessionId: session.id, message: 'after drain' });
    assert.equal(result.message.content.text, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});
