import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterError, buildAgentArgv, createOpenClawAgentRunner, inspectOpenClaw, inspectOpenClawMcp, runAgent } from '../runtime/openclaw-adapter.mjs';

function fakeSpawnVersion(version) {
  return (_command, args, options) => {
    assert.deepEqual(args, ['--version']);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(`openclaw ${version}\n`)); child.emit('close', 0, null); });
    return child;
  };
}

function fakeSpawnError(code) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { const error = new Error('spawn failed'); error.code = code; child.emit('error', error); });
    return child;
  };
}

test('诊断返回可运行 CLI 的版本且不使用 shell', async () => {
  const result = await inspectOpenClaw({ command: process.execPath, spawnImpl: fakeSpawnVersion('2026.6.6') });
  assert.equal(result.status, 'ready');
  assert.equal(result.version, '2026.6.6');
  assert.equal(result.command, process.platform === 'win32' ? 'node.exe' : 'node');
});

test('诊断将找不到 CLI 映射为可展示的 unavailable 状态', async () => {
  const result = await inspectOpenClaw({ command: 'missing-openclaw', spawnImpl: fakeSpawnError('ENOENT') });
  assert.deepEqual(result, { status: 'unavailable', code: 'CLI_NOT_FOUND', command: 'missing-openclaw' });
});

test('MCP 诊断只读解析 server 状态摘要，不返回原始配置', async () => {
  const spawnImpl = (_command, args, options) => {
    assert.deepEqual(args, ['mcp', 'status', '--json']);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ servers: [
        { name: 'filesystem', status: 'healthy', command: 'node', env: { API_KEY: 'secret' } },
        { name: 'broken', state: 'error', error: 'private path' },
      ] })));
      child.emit('close', 0, null);
    });
    return child;
  };
  const result = await inspectOpenClawMcp({ command: 'openclaw.cmd', platform: 'linux', spawnImpl });
  assert.deepEqual(result, {
    status: 'ready',
    command: 'openclaw.cmd',
    serverCount: 2,
    servers: [
      { name: 'filesystem', status: 'healthy' },
      { name: 'broken', status: 'error' },
    ],
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('private path'), false);
});

test('MCP 诊断将找不到 CLI 映射为 unavailable', async () => {
  const result = await inspectOpenClawMcp({ command: 'missing-openclaw', spawnImpl: fakeSpawnError('ENOENT') });
  assert.deepEqual(result, { status: 'unavailable', code: 'CLI_NOT_FOUND', command: 'missing-openclaw' });
});

test('MCP 诊断遇到无效响应时也不回显敏感命令配置', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('not-json')); child.emit('close', 0, null); });
    return child;
  };
  const result = await inspectOpenClawMcp({ command: 'https://user:password@example.test/openclaw', spawnImpl });
  assert.deepEqual(result, { status: 'unavailable', code: 'INVALID_RESPONSE', command: 'openclaw' });
  assert.equal(JSON.stringify(result).includes('user'), false);
  assert.equal(JSON.stringify(result).includes('password'), false);
});

test('Windows .cmd CLI 通过 ComSpec 启动且仍关闭 shell 选项', async () => {
  const result = await inspectOpenClaw({ command: 'C:\\Tools\\openclaw.cmd', platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe', spawnImpl: (command, args, options) => {
    assert.equal(command, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(options.shell, false);
    assert.equal(args[0], '/d');
    assert.equal(args[1], '/s');
    assert.equal(args[2], '/c');
    assert.match(args[3], /openclaw\.cmd/);
    assert.match(args[3], /--version/);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('openclaw 2026.6.6\n')); child.emit('close', 0, null); });
    return child;
  } });
  assert.equal(result.status, 'ready');
});

test('Windows .cmd Agent 通过 ComSpec 启动且固定 local 参数', async () => {
  const seen = [];
  const spawnImpl = (command, args, options) => {
    seen.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from('{}')); child.emit('close', 0, null); });
    return child;
  };
  await runAgent({ message: 'hello', sessionKey: 's', local: true }, { command: 'C:\\Tools\\openclaw.cmd', platform: 'win32', comSpec: 'C:\\Windows\\System32\\cmd.exe', spawnImpl });
  assert.equal(seen[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(seen[0].options.shell, false);
  assert.match(seen[0].args[3], /--local/);
});

test('MCP 诊断会脱敏路径和敏感片段', async () => {
  const spawnImpl = (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ servers: [{ name: 'C:\\Users\\HP\\token=secret', status: 'https://user:pass@example.test' }] }))); child.emit('close', 0, null); });
    return child;
  };
  const result = await inspectOpenClawMcp({ spawnImpl });
  assert.deepEqual(result.servers, [{ name: '[redacted]', status: '[redacted]' }]);
});

test('OpenClaw CLI argv 仅接受显式会话或 Agent 目标', () => {
  assert.throws(() => buildAgentArgv({ message: 'hello' }), (error) => error instanceof AdapterError && error.code === 'INVALID_INPUT');
  assert.deepEqual(buildAgentArgv({ message: 'hello', sessionKey: 'session-1', local: true }), ['agent', '--json', '--message', 'hello', '--session-key', 'session-1', '--local']);
});

test('受限 Agent runner 固定 local 边界，调用方不能降级为远端执行', async () => {
  if (process.platform === 'win32') return;
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
