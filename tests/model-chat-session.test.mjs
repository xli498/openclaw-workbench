import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatSessionManager } from '../runtime/session.mjs';
import { createModelRunner } from '../runtime/model-runner.mjs';

function profile(overrides = {}) {
  return { id: 'primary', provider: 'test', protocol: 'openai-compatible', model: 'test-model', endpoint: 'https://provider.example/v1', secretRef: 'env:MODEL_KEY', enabled: true, ...overrides };
}

test('Ask Chat 使用明确的 enabled model profile，并保存规范化 assistant 消息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-chat-'));
  const seen = [];
  const selected = profile();
  const runner = createModelRunner({
    secretResolver: { resolve: async () => 'header-only-secret' },
    fetchImpl: async (_url, options) => {
      seen.push({ options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '模型回答' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const manager = createChatSessionManager({ root, modelRunner: runner, modelResolver: { get: (id) => id === selected.id ? selected : null } });
  const session = manager.createSession({ mode: 'Ask' });
  try {
    const result = await manager.sendMessage({ sessionId: session.id, model: selected.id, message: '读取项目' });
    assert.equal(result.message.content.text, '模型回答');
    assert.equal(seen[0].body.model, 'test-model');
    assert.equal(seen[0].body.messages[0].content, '读取项目');
    assert.equal(seen[0].options.headers.authorization, 'Bearer header-only-secret');
    assert.equal(JSON.stringify(manager.listMessages(session.id)).includes('header-only-secret'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('模型 Chat 拒绝未选择、未知和 disabled profile，不回退到其他模型', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-chat-boundary-'));
  const enabled = profile();
  const disabled = profile({ id: 'disabled', enabled: false });
  const calls = [];
  const manager = createChatSessionManager({ root, modelRunner: async (input) => { calls.push(input); return { text: 'unexpected', toolCalls: [], finishReason: 'stop', model: 'test-model', protocol: 'openai-compatible' }; }, modelResolver: { get: (id) => ({ primary: enabled, disabled }[id] ?? null) } });
  const session = manager.createSession({ mode: 'Ask' });
  try {
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, message: 'no model' }), { code: 'MODEL_REQUIRED' });
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, model: 'missing', message: 'unknown' }), { code: 'MODEL_NOT_FOUND' });
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, model: 'disabled', message: 'disabled' }), { code: 'MODEL_DISABLED' });
    assert.equal(calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('模型 Chat 跨用户回合向 provider 发送字符串 assistant content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-chat-history-'));
  const seen = [];
  const selected = profile({ id: 'history' });
  const manager = createChatSessionManager({
    root,
    modelRunner: async (input) => {
      seen.push(input.messages);
      return { text: `reply-${seen.length}`, toolCalls: [], finishReason: 'stop', model: selected.model, protocol: selected.protocol };
    },
    modelResolver: { get: (id) => id === selected.id ? selected : null },
  });
  const session = manager.createSession({ mode: 'Ask' });
  try {
    await manager.sendMessage({ sessionId: session.id, model: selected.id, message: 'one' });
    await manager.sendMessage({ sessionId: session.id, model: selected.id, message: 'two' });
    assert.equal(typeof seen[1].find((message) => message.role === 'assistant').content, 'string');
    assert.equal(seen[1].find((message) => message.role === 'assistant').content, 'reply-1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
