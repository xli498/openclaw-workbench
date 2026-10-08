import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelRunner, ModelRunnerError } from '../runtime/model-runner.mjs';
import { createSecretResolver } from '../runtime/secret-resolver.mjs';
import { createMockOpenAIProvider } from './mock-provider.mjs';

const SECRET = 'mock-secret-value';
const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }];

function profile(overrides = {}) {
  return { id: 'mock-primary', provider: 'local-mock', protocol: 'openai-compatible', model: 'mock-model', endpoint: 'https://provider.example/v1', secretRef: 'env:MOCK_PROVIDER_KEY', enabled: true, ...overrides };
}

function makeRunner(provider, overrides = {}) {
  return createModelRunner({ secretResolver: createSecretResolver({ env: { MOCK_PROVIDER_KEY: SECRET } }), fetchImpl: provider.fetch, lookupImpl: async () => PUBLIC_ADDRESS, ...overrides });
}

test('Mock OpenAI-compatible HTTP provider returns streamed text and receives only the configured bearer secret', async () => {
  const provider = await createMockOpenAIProvider({ responseText: 'Ask response' });
  try {
    const result = await makeRunner(provider)({ profile: profile(), messages: [{ role: 'user', content: 'Ask' }] });
    assert.equal(result.text, 'Ask response');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].url, 'https://provider.example/v1/chat/completions');
    assert.equal(provider.requests[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(provider.requests[0].body.stream, true);
    assert.equal(JSON.stringify(provider.requests[0].body).includes(SECRET), false);
  } finally { await provider.close(); }
});

test('Mock provider emits a real streamed tool call and model runner parses it', async () => {
  const provider = await createMockOpenAIProvider();
  try {
    const result = await makeRunner(provider)({ profile: profile(), messages: [{ role: 'user', content: '读取 README.md' }], tools: [{ type: 'function', function: { name: 'workspace.read_files' } }] });
    assert.deepEqual(result.toolCalls, [{ id: 'mock-read-1', name: 'workspace.read_files', arguments: { paths: ['README.md'] } }]);
    assert.equal(result.text, '');
  } finally { await provider.close(); }
});

test('Mock provider HTTP errors become stable model errors without exposing provider details', async () => {
  const provider = await createMockOpenAIProvider({ errorStatus: 503 });
  try {
    await assert.rejects(() => makeRunner(provider)({ profile: profile(), messages: [] }), (error) => error instanceof ModelRunnerError && error.code === 'MODEL_HTTP_STATUS' && error.message === 'model provider returned an HTTP error' && !error.message.includes(SECRET));
  } finally { await provider.close(); }
});

test('Mock provider timeout aborts the underlying request and does not return a result', async () => {
  const provider = await createMockOpenAIProvider({ delayMs: 100 });
  try {
    await assert.rejects(() => makeRunner(provider, { requestTimeoutMs: 10 })({ profile: profile(), messages: [] }), { code: 'MODEL_TIMEOUT' });
    assert.equal(provider.aborts, 1);
  } finally { await provider.close(); }
});

test('Mock provider request can be cancelled by the caller', async () => {
  const provider = await createMockOpenAIProvider({ delayMs: 100 });
  try {
    const controller = new AbortController();
    const pending = makeRunner(provider)({ profile: profile(), messages: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, { code: 'MODEL_ABORTED' });
    assert.equal(provider.aborts, 1);
  } finally { await provider.close(); }
});

test('provider output containing the API key is redacted from text and result payloads', async () => {
  const provider = await createMockOpenAIProvider({ responseText: `provider echoed ${SECRET}` });
  try {
    const result = await makeRunner(provider)({ profile: profile(), messages: [{ role: 'user', content: 'echo' }] });
    assert.equal(result.text, 'provider echoed [redacted]');
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  } finally { await provider.close(); }
});
