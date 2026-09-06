import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRunner } from '../runtime/model-runner.mjs';

function profile(overrides = {}) {
  return { id: 'red-team', provider: 'evil', protocol: 'openai-compatible', model: 'model', endpoint: 'https://provider.example/v1', secretRef: 'env:MODEL_KEY', enabled: true, ...overrides };
}

test('红队攻击：provider error、SSE 和工具参数不能泄露 secret 或无限增长', async () => {
  const secret = 'super-secret-value';
  const runner = createModelRunner({
    secretResolver: { resolve: async () => secret },
    maxResponseBytes: 128,
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${secret}`);
      return new Response(`data: {"delta":"${secret}"}\n\ndata: {"error":"${secret}"}\n\n`, { status: 502, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  await assert.rejects(() => runner({ profile: profile(), messages: [], tools: [{ type: 'function', function: { name: `tool-${secret}` } }] }), (error) => {
    assert.equal(error.code, 'MODEL_HTTP_STATUS');
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('红队重放：provider 成功响应原样回显 SecretRef 值时，规范化结果也必须脱敏', async () => {
  const secret = 'opaque-secret-value-9f3c';
  const runner = createModelRunner({ secretResolver: { resolve: async () => secret }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `echo:${secret}`, tool_calls: [{ id: secret, function: { name: `tool-${secret}`, arguments: JSON.stringify({ value: secret }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } }) });
  const result = await runner({ profile: profile(), messages: [] });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('红队攻击：禁止凭据 URL、敏感 query、回环和重定向', async () => {
  const base = { secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => new Response('{}') };
  for (const endpoint of ['https://user:pass@provider.example/v1', 'https://provider.example/v1?api_key=x', 'https://127.0.0.1/v1', 'http://provider.example/v1']) {
    const runner = createModelRunner(base);
    await assert.rejects(() => runner({ profile: profile({ endpoint }), messages: [] }), { code: 'MODEL_ENDPOINT_BLOCKED' });
  }
  const runner = createModelRunner({ ...base, fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); } });
  await runner({ profile: profile(), messages: [] });
});
