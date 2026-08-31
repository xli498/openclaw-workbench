import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterError, buildAgentArgv, createOpenClawAgentRunner } from '../runtime/openclaw-adapter.mjs';

test('OpenClaw CLI argv 仅接受显式会话或 Agent 目标', () => {
  assert.throws(() => buildAgentArgv({ message: 'hello' }), (error) => error instanceof AdapterError && error.code === 'INVALID_INPUT');
  assert.deepEqual(buildAgentArgv({ message: 'hello', sessionKey: 'session-1', local: true }), ['agent', '--json', '--message', 'hello', '--session-key', 'session-1', '--local']);
});

test('受限 Agent runner 固定 local 边界，调用方不能降级为远端执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-adapter-runner-'));
  const command = path.join(root, 'fake-openclaw');
  await writeFile(command, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n', { mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const runner = createOpenClawAgentRunner({ command, timeoutMs: 5_000, maxOutputBytes: 16_384 });
    const result = await runner({ message: 'hello', sessionKey: 'session-1', local: false });
    assert.deepEqual(result.argv, ['agent', '--json', '--message', 'hello', '--session-key', 'session-1', '--local']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('受限 Agent runner 拒绝不安全的构造参数', () => {
  assert.throws(() => createOpenClawAgentRunner({ command: '' }), (error) => error instanceof AdapterError && error.code === 'INVALID_CONFIG');
  assert.throws(() => createOpenClawAgentRunner({ timeoutMs: 0 }), (error) => error instanceof AdapterError && error.code === 'INVALID_CONFIG');
  assert.throws(() => createOpenClawAgentRunner({ maxOutputBytes: 0 }), (error) => error instanceof AdapterError && error.code === 'INVALID_CONFIG');
  const fixedRunner = createOpenClawAgentRunner({ local: false });
  assert.equal(typeof fixedRunner, 'function');
});
