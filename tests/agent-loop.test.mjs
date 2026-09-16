import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../runtime/agent-loop.mjs';

test('agent loop 把结构化工具结果回传模型并保留安全 trace', async () => {
  const requests = [];
  const registry = {
    definitions: () => [{ type: 'function', function: { name: 'workspace.read_files', parameters: { type: 'object' } } }],
    call: async ({ name }) => ({ files: [{ path: 'README.md', content: 'hello' }], name }),
  };
  const result = await runAgentLoop({
    mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [{ role: 'user', content: 'read' }], registry,
    modelRunner: async (input) => {
      requests.push(input);
      return requests.length === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'workspace.read_files', arguments: { paths: ['README.md'] } }], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }
        : { text: 'done', toolCalls: [], finishReason: 'stop', model: 'm', protocol: 'openai-compatible' };
    },
  });
  assert.equal(result.text, 'done');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.deepEqual(result.toolTrace, [{ id: 'c1', name: 'workspace.read_files', status: 'completed' }]);
});

test('agent loop 将同一批多个调用合并为一个 assistant 消息，并传递取消信号', async () => {
  const requests = [];
  const calls = [];
  const registry = {
    definitions: () => [
      { type: 'function', function: { name: 'workspace.read_files', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'workspace.search_files', parameters: { type: 'object' } } },
    ],
    call: async (input) => { calls.push(input); return { ok: true, name: input.name }; },
  };
  const result = await runAgentLoop({
    mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [{ role: 'user', content: 'read' }], registry,
    modelRunner: async (input) => {
      requests.push(input);
      return requests.length === 1
        ? { text: 'working', toolCalls: [
          { id: 'c1', name: 'workspace.read_files', arguments: { paths: ['README.md'] } },
          { id: 'c2', name: 'workspace.search_files', arguments: { query: 'hello' } },
        ], finishReason: 'tool_calls', model: 'm', protocol: 'openai-compatible' }
        : { text: 'done', toolCalls: [], finishReason: 'stop', model: 'm', protocol: 'openai-compatible' };
    },
  });
  assert.equal(result.text, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal?.aborted, false);
  assert.equal(requests[1].messages.at(-3).role, 'assistant');
  assert.equal(requests[1].messages.at(-3).tool_calls.length, 2);
  assert.equal(requests[1].messages.at(-2).tool_call_id, 'c1');
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'c2');
});

test('agent loop 在工具执行期间取消时不再调用模型或提交成功结果', async () => {
  const controller = new AbortController();
  let modelCalls = 0;
  let toolCalls = 0;
  const registry = {
    definitions: () => [{ type: 'function', function: { name: 'workspace.read_files', parameters: { type: 'object' } } }],
    call: async ({ signal }) => {
      toolCalls += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })), { once: true });
        setTimeout(resolve, 5_000);
      });
      return {};
    },
  };
  const running = runAgentLoop({
    mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [], registry, signal: controller.signal,
    modelRunner: async () => { modelCalls += 1; return { text: '', toolCalls: [{ id: 'c1', name: 'workspace.read_files', arguments: {} }] }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running, { code: 'AGENT_LOOP_ABORTED' });
  assert.equal(toolCalls, 1);
  assert.equal(modelCalls, 1);
});
