import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createChatSessionManager } from '../runtime/session.mjs';

async function tempRoot() {
  return mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'gateway-session-'));
}

test('Chat session can use an explicitly supplied Gateway request function', async () => {
  const root = await tempRoot();
  const calls = [];
  const sessions = createChatSessionManager({
    root,
    gatewayRequestFn: async (input) => {
      calls.push(input);
      return { text: 'gateway reply' };
    },
  });
  const session = sessions.createSession({ mode: 'Ask' });
  try {
    const result = await sessions.sendMessage({ sessionId: session.id, message: 'hello' });
    assert.equal(result.message.content.text, 'gateway reply');
    assert.equal(calls[0].sessionId, session.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cancelled Gateway turn does not append an assistant message', async () => {
  const root = await tempRoot();
  const sessions = createChatSessionManager({
    root,
    gatewayRequestFn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })), { once: true });
    }),
  });
  const session = sessions.createSession({ mode: 'Ask' });
  try {
    const pending = sessions.sendMessage({ sessionId: session.id, message: 'wait' });
    sessions.cancelTurn(session.id);
    await assert.rejects(pending, (error) => error.code === 'ABORTED');
    assert.deepEqual(sessions.listMessages(session.id).map((message) => message.role), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
