import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelRunner, ModelRunnerError } from '../runtime/model-runner.mjs';
import { createSecretResolver } from '../runtime/secret-resolver.mjs';
import { createMockOpenAIProvider } from './mock-provider.mjs';

const profile = (endpoint = 'https://mock.provider.test/v1') => ({
  id: 'mock-primary', provider: 'local-mock', protocol: 'openai-compatible', model: 'mock-model', endpoint,
  capabilities: ['text', 'tool_calling'], secretRef: 'env:MOCK_PROVIDER_KEY', enabled: true,
});

function runner(provider, options = {}) {
  return createModelRunner({
    secretResolver: createSecretResolver({ env: { MOCK_PROVIDER_KEY: 'mock-secret-value' } }),
    fetchImpl: provider.fetch,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    ...options,
  });
}

test('Mock Provider serves an OpenAI-compatible SSE tool call and authenticates without exposing the secret', async () => {
  const provider = await createMockOpenAIProvider();
  try {
    const result = await runner(provider)({ profile: profile(), messages: [{ role: 'user', content: '请读取 README.md' }], tools: [{ type: 'function', function: { name: 'workspace.read_files', parameters: {} } }] });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'workspace.read_files');
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].headers.authorization, 'Bearer mock-secret-value');
    assert.equal(JSON.stringify(result).includes('mock-secret-value'), false);
  } finally { await provider.close(); }
});

test('Mock Provider exercises timeout, cancellation, and HTTP error handling', async () => {
  const timed = await createMockOpenAIProvider({ delayMs: 50 });
  try {
    await assert.rejects(() => runner(timed, { requestTimeoutMs: 5 })({ profile: profile(), messages: [{ role: 'user', content: 'slow' }] }), (error) => error instanceof ModelRunnerError && error.code === 'MODEL_TIMEOUT');
  } finally { await timed.close(); }

  const cancelled = await createMockOpenAIProvider({ delayMs: 50 });
  try {
    const controller = new AbortController();
    const pending = runner(cancelled)({ profile: profile(), messages: [{ role: 'user', content: 'cancel' }], signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => error instanceof ModelRunnerError && error.code === 'MODEL_ABORTED');
  } finally { await cancelled.close(); }

  const failed = await createMockOpenAIProvider({ errorStatus: 503 });
  try {
    await assert.rejects(() => runner(failed)({ profile: profile(), messages: [{ role: 'user', content: 'error' }] }), (error) => error instanceof ModelRunnerError && error.code === 'MODEL_HTTP_STATUS');
  } finally { await failed.close(); }
});

test('Mock Provider can return a secret-bearing response and the runner redacts it', async () => {
  const provider = await createMockOpenAIProvider({ responseText: 'provider said mock-secret-value' });
  try {
    const result = await runner(provider)({ profile: profile(), messages: [{ role: 'user', content: 'leak test' }] });
    assert.equal(result.text.includes('mock-secret-value'), false);
    assert.match(result.text, /\[redacted\]/);
  } finally { await provider.close(); }
});
