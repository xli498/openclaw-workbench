import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatSessionManager } from '../runtime/session.mjs';
import { createWorkspaceToolRegistry } from '../runtime/workspace-tool-registry.mjs';

test('Chat 只执行 allowlisted workspace read tool，并把结果回传模型', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-chat-tools-'));
  try {
    await writeFile(path.join(root, 'README.md'), 'tool result');
    const tools = await createWorkspaceToolRegistry({ root });
    const profile = { id: 'm', model: 'm', enabled: true };
    const calls = [];
    const manager = createChatSessionManager({ root, modelResolver: { get: () => profile }, toolRegistry: tools, modelRunner: async (input) => {
      calls.push({ messages: input.messages, tools: input.tools });
      return calls.length === 1
        ? { text: '', toolCalls: [{ id: 'call-1', name: 'workspace.read_file', arguments: { path: 'README.md' } }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }
        : { text: '读取完成', toolCalls: [], finishReason: 'stop', model: 'm', protocol: 'openai-compatible' };
    } });
    const session = manager.createSession({ mode: 'Ask' });
    const result = await manager.sendMessage({ sessionId: session.id, model: 'm', message: '读取 README' });
    assert.equal(result.message.content.text, '读取完成');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tools.length, 3);
    assert.equal(calls[1].messages.at(-1).role, 'tool');
    assert.match(calls[1].messages.at(-1).content, /tool result/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Chat 工具循环达到上限时停止，不持久化半成品 assistant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-chat-tools-limit-'));
  try {
    const tools = await createWorkspaceToolRegistry({ root });
    const profile = { id: 'm', model: 'm', enabled: true };
    let round = 0;
    const manager = createChatSessionManager({ root, modelResolver: { get: () => profile }, toolRegistry: tools, modelRunner: async () => ({ text: '', toolCalls: [{ id: `loop-${round++}`, name: 'workspace.list_files', arguments: {} }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }) });
    const session = manager.createSession({ mode: 'Ask' });
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, model: 'm', message: 'loop' }), { code: 'TOOL_LOOP_LIMIT' });
    assert.equal(manager.listMessages(session.id).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：工具回传的 SecretRef 片段不进入下一次 provider 请求或会话快照', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-chat-tools-secret-'));
  try {
    await writeFile(path.join(root, 'notes.txt'), 'token=workspace-secret-value');
    const tools = await createWorkspaceToolRegistry({ root });
    const profile = { id: 'm', model: 'm', enabled: true };
    const seen = [];
    const manager = createChatSessionManager({ root, modelResolver: { get: () => profile }, toolRegistry: tools, modelRunner: async (input) => {
      seen.push(JSON.stringify(input.messages));
      return seen.length === 1
        ? { text: '', toolCalls: [{ id: 'read', name: 'workspace.read_file', arguments: { path: 'notes.txt' } }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }
        : { text: 'safe', toolCalls: [], finishReason: 'stop', model: 'm', protocol: 'openai-compatible' };
    } });
    const session = manager.createSession({ mode: 'Ask' });
    await manager.sendMessage({ sessionId: session.id, model: 'm', message: 'read notes' });
    assert.equal(seen.some((value) => value.includes('workspace-secret-value')), false);
    assert.equal(JSON.stringify(manager.listMessages(session.id)).includes('workspace-secret-value'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：模型不能借 tool call 执行未注册的写入工具', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-chat-tools-unknown-'));
  try {
    const tools = await createWorkspaceToolRegistry({ root });
    const profile = { id: 'm', model: 'm', enabled: true };
    const manager = createChatSessionManager({ root, modelResolver: { get: () => profile }, toolRegistry: tools, modelRunner: async () => ({ text: '', toolCalls: [{ id: 'evil', name: 'workspace.write_file', arguments: { path: 'owned.txt', content: 'owned' } }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }) });
    const session = manager.createSession({ mode: 'Ask' });
    await assert.rejects(() => manager.sendMessage({ sessionId: session.id, model: 'm', message: 'write file' }), { code: 'TOOL_NOT_ALLOWED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
