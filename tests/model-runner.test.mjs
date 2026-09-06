import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createModelRunner, ModelRunnerError } from '../runtime/model-runner.mjs';

function profile(overrides = {}) {
  return {
    id: 'primary',
    provider: 'test-provider',
    protocol: 'openai-compatible',
    model: 'test-model',
    endpoint: 'https://provider.example/v1',
    secretRef: 'env:MODEL_KEY',
    enabled: true,
    ...overrides,
  };
}

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

function streamResponse(text, headers = {}) {
  return new Response(Readable.toWeb(Readable.from([text])), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

test('OpenAI Chat Completions 请求被规范化并返回 tool calls', async () => {
  let seen;
  const runner = createModelRunner({
    secretResolver: { resolve: async (ref) => { assert.equal(ref, 'env:MODEL_KEY'); return 'secret-value'; } },
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return jsonResponse({ id: 'chatcmpl-1', model: 'test-model', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '先查目录', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'workspace.list_directory', arguments: '{"path":"."}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    },
  });
  const result = await runner({ profile: profile(), messages: [{ role: 'user', content: '看看项目' }], tools: [{ type: 'function', function: { name: 'workspace.list_directory' } }] });
  assert.equal(seen.url, 'https://provider.example/v1/chat/completions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.authorization, 'Bearer secret-value');
  assert.equal(JSON.parse(seen.options.body).stream, true);
  assert.deepEqual(result, { text: '先查目录', toolCalls: [{ id: 'call-1', name: 'workspace.list_directory', arguments: { path: '.' } }], usage: { prompt_tokens: 3, completion_tokens: 4 }, finishReason: 'tool_calls', model: 'test-model', protocol: 'openai-compatible' });
});

test('Responses API 的 JSON 与 SSE 输出都被规范化', async () => {
  const responses = [
    jsonResponse({ id: 'resp-1', model: 'r-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }, { type: 'function_call', call_id: 'call-r', name: 'workspace.read_files', arguments: '{"paths":["README.md"]}' }], usage: { input_tokens: 2, output_tokens: 5 } }),
    streamResponse('data: {"type":"response.output_text.delta","delta":"流"}\n\ndata: {"type":"response.output_text.delta","delta":"式"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n'),
  ];
  const runner = createModelRunner({ secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => responses.shift(), });
  const first = await runner({ profile: profile({ protocol: 'openai-responses', model: 'r-model' }), messages: [] });
  assert.deepEqual(first, { text: '完成', toolCalls: [{ id: 'call-r', name: 'workspace.read_files', arguments: { paths: ['README.md'] } }], usage: { input_tokens: 2, output_tokens: 5 }, finishReason: 'completed', model: 'r-model', protocol: 'openai-responses' });
  const second = await runner({ profile: profile({ protocol: 'openai-responses', model: 'r-model' }), messages: [] });
  assert.equal(second.text, '流式');
  assert.deepEqual(second.toolCalls, []);
});

test('模型 runner 拒绝禁用/错配 profile、坏响应和不支持协议', async () => {
  const base = { secretResolver: { resolve: async () => 'secret-never-in-error' }, fetchImpl: async () => jsonResponse({ nope: true }) };
  const runner = createModelRunner(base);
  await assert.rejects(() => runner({ profile: profile({ enabled: false }), messages: [] }), (error) => error instanceof ModelRunnerError && error.code === 'MODEL_DISABLED');
  await assert.rejects(() => runner({ profile: profile(), model: 'other-model', messages: [] }), { code: 'MODEL_PROFILE_MISMATCH' });
  await assert.rejects(() => runner({ profile: profile(), messages: [] }), (error) => error.code === 'MODEL_RESPONSE_INVALID' && !error.message.includes('secret-never-in-error'));
  await assert.rejects(() => runner({ profile: profile({ protocol: 'anthropic' }), messages: [] }), { code: 'MODEL_PROTOCOL_UNSUPPORTED' });
});

test('模型 runner 支持调用方取消和硬超时，底层忽略 signal 也不能返回 ready', async () => {
  const runner = createModelRunner({ secretResolver: { resolve: async () => 'x' }, requestTimeoutMs: 15, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(() => runner({ profile: profile(), messages: [] }), { code: 'MODEL_TIMEOUT' });
  const controller = new AbortController();
  const pending = runner({ profile: profile(), messages: [], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'MODEL_ABORTED' });
});
