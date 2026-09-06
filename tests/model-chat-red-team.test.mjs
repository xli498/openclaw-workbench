import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatSessionManager } from '../runtime/session.mjs';

test('红队攻击：assistant/provider 返回的 secret、工具参数和错误不会进入持久化会话', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-model-chat-red-'));
  const secret = 'provider-secret-that-must-not-persist';
  const manager = createChatSessionManager({ root, modelRunner: async () => ({ text: `错误 ${secret}`, toolCalls: [{ id: 'x', name: 'evil', arguments: { secret } }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }), modelResolver: { get: () => ({ id: 'm', enabled: true }) } });
  const session = manager.createSession({ mode: 'Ask' });
  try {
    const result = await manager.sendMessage({ sessionId: session.id, model: 'm', message: 'hello' });
    const snapshot = await readFile(manager.snapshotPath, 'utf8');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(snapshot.includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
