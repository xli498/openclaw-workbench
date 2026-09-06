import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelHealthProbe, ModelProbeError } from '../runtime/model-probe.mjs';

function profile(overrides = {}) {
  return { id: 'primary', provider: 'openai', protocol: 'openai-compatible', model: 'gpt-test', endpoint: 'https://provider.example/v1', secretRef: 'env:OPENAI_KEY', capabilities: ['text'], ...overrides };
}

function response(body, { status = 200, contentType = 'application/json' } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name === 'content-type' ? contentType : null }, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }) };
}

function settles(promise) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('probe did not settle in test deadline'), { code: 'TEST_HANG' })), 100))]);
}

test('OpenAI-compatible 探针解析 SecretRef 并只返回安全健康摘要', async () => {
  let seen;
  const probe = createModelHealthProbe({ secretResolver: { resolve: async () => 'probe-secret' }, fetchImpl: async (url, options) => { seen = { url, options }; return response({ data: [{ id: 'gpt-test' }] }); } });
  const result = await probe(profile());
  assert.deepEqual(result, { status: 'ready', code: 'PROBE_OK' });
  assert.equal(seen.url, 'https://provider.example/v1/models');
  assert.equal(seen.options.headers.authorization, 'Bearer probe-secret');
  assert.equal('body' in seen.options, false);
});

test('探针拒绝未知协议、HTTP 错误、超大响应并隐藏 secret', async () => {
  const secret = 'secret-never-in-error';
  const probe = createModelHealthProbe({ secretResolver: { resolve: async () => secret }, fetchImpl: async () => response('provider says ' + secret, { status: 503 }), maxResponseBytes: 32 });
  await assert.rejects(() => probe(profile({ protocol: 'anthropic' })), { code: 'MODEL_PROTOCOL_UNSUPPORTED' });
  await assert.rejects(() => probe(profile()), (error) => { assert.ok(error instanceof ModelProbeError); assert.equal(error.code, 'MODEL_HTTP_STATUS'); assert.doesNotMatch(error.message, /secret-never-in-error/); return true; });
  const oversized = createModelHealthProbe({ secretResolver: { resolve: async () => secret }, fetchImpl: async () => response('x'.repeat(100)), maxResponseBytes: 8 });
  await assert.rejects(() => oversized(profile()), { code: 'MODEL_RESPONSE_LIMIT' });
  const invalidShape = createModelHealthProbe({ secretResolver: { resolve: async () => secret }, fetchImpl: async () => response(null) });
  await assert.rejects(() => invalidShape(profile()), { code: 'MODEL_RESPONSE_INVALID' });
});

test('探针支持超时和调用方取消且不重试', async () => {
  let attempts = 0;
  const probe = createModelHealthProbe({ requestTimeoutMs: 10, secretResolver: { resolve: async () => 'x' }, fetchImpl: async (_url, { signal }) => { attempts += 1; await new Promise((resolve, reject) => { if (signal.aborted) return reject(new Error('aborted')); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); } });
  await assert.rejects(() => settles(probe(profile())), { code: 'MODEL_TIMEOUT' });
  assert.equal(attempts, 1);
  const controller = new AbortController();
  const cancelled = probe(profile(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => settles(cancelled), { code: 'MODEL_ABORTED' });
  assert.equal(attempts, 1);
});

test('底层 fetch 忽略 AbortSignal 时，探针也不会在取消后返回 ready', async () => {
  const controller = new AbortController();
  const probe = createModelHealthProbe({ requestTimeoutMs: 100, secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return response({ data: [] }); } });
  const running = probe(profile(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => running, { code: 'MODEL_ABORTED' });
});

test('SecretRef 解析本身受探针超时和调用方取消保护', async () => {
  const resolver = { resolve: async () => new Promise((resolve) => setTimeout(() => resolve('x'), 150)) };
  const probe = createModelHealthProbe({ requestTimeoutMs: 10, secretResolver: resolver, fetchImpl: async () => response({ data: [] }) });
  await assert.rejects(() => settles(probe(profile())), { code: 'MODEL_TIMEOUT' });
  const controller = new AbortController();
  const cancelled = probe(profile(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => cancelled, { code: 'MODEL_ABORTED' });
});

test('响应流读取受探针超时保护，且无可控流的 response 被拒绝', async () => {
  const hanging = { ok: true, status: 200, body: new ReadableStream({ pull() { return new Promise((resolve) => setTimeout(resolve, 150)); } }) };
  const probe = createModelHealthProbe({ requestTimeoutMs: 10, secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => hanging });
  await assert.rejects(() => probe(profile()), { code: 'MODEL_TIMEOUT' });
  const noStream = createModelHealthProbe({ secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(100) }), maxResponseBytes: 8 });
  await assert.rejects(() => settles(noStream(profile())), { code: 'MODEL_RESPONSE_STREAM_INVALID' });
});

test('探针默认阻断回环、私网、metadata 和非 HTTPS endpoint，并禁止重定向', async () => {
  const probe = createModelHealthProbe({ secretResolver: { resolve: async () => 'x' }, fetchImpl: async () => response({ data: [] }) });
  for (const endpoint of ['http://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://localhost./v1', 'https://metadata.google.internal./computeMetadata/v1', 'https://127.0.0.1.nip.io/v1', 'https://provider.example/v1?api_key=secret']) {
    await assert.rejects(() => probe(profile({ endpoint })), { code: 'MODEL_ENDPOINT_BLOCKED' });
  }
  let seen;
  const publicProbe = createModelHealthProbe({ secretResolver: { resolve: async () => 'x' }, fetchImpl: async (_url, options) => { seen = options; return response({ data: [] }); } });
  await publicProbe(profile());
  assert.equal(seen.redirect, 'error');
  const dnsBlocked = createModelHealthProbe({ secretResolver: { resolve: async () => 'x' }, lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => response({ data: [] }) });
  await assert.rejects(() => dnsBlocked(profile()), { code: 'MODEL_ENDPOINT_BLOCKED' });
});
