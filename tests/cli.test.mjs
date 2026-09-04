import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, runCli } from '../bin/workbench.mjs';
import { inspectOpenClaw as packageInspectOpenClaw, startWorkbench as packageStartWorkbench } from 'openclaw-workbench';

async function fixture() { return mkdtemp(`${tmpdir()}/openclaw-workbench-cli-`); }

test('Windows 直接运行 bin 入口会响应 help，而不是静默退出', async () => {
  const bin = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => execFile(process.execPath, [bin, '--help'], { windowsHide: true }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
  assert.match(result.stdout, /Usage: openclaw-workbench/);
});

test('package self-reference resolves the declared public entrypoint', () => {
  assert.equal(typeof packageStartWorkbench, 'function');
});

test('package exports the read-only OpenClaw diagnostic', () => {
  assert.equal(typeof packageInspectOpenClaw, 'function');
});

test('CLI 参数只接受明确 root、json 和 help，并从环境变量读取令牌', () => {
  assert.deepEqual(parseArgs(['--root', 'demo', '--host', 'localhost', '--port', '4312', '--token-env', 'MY_TOKEN', '--approval-token-env', 'MY_APPROVAL', '--openclaw-command-env', 'MY_OPENCLAW', '--json']), { root: 'demo', host: 'localhost', port: 4312, tokenEnv: 'MY_TOKEN', approvalTokenEnv: 'MY_APPROVAL', openclawCommandEnv: 'MY_OPENCLAW', json: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--root']), /requires a path/);
  assert.throws(() => parseArgs(['--port', '70000']), /0 to 65535/);
  assert.throws(() => parseArgs(['--shell']), /unknown argument/);
  assert.throws(() => parseArgs(['--token', 'secret']), /命令行/);
});

test('CLI 以 JSON 输出启动恢复摘要', async () => {
  const chunks = []; const stdout = { write: (value) => chunks.push(value) };
  const result = await runCli(['--json'], { stdout, cwd: await fixture() });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(chunks.join('')).summary.scanned, 0);
});

test('CLI 在提供 token 时启动长期本地服务，并保留可关闭句柄', async () => {
  const chunks = [];
  const app = { startup: Promise.resolve({ summary: { scanned: 0, finalized: 0, errors: 0 } }), listen: async () => ({ address: '127.0.0.1', port: 4312 }), close: async () => {} };
  const result = await runCli(['--port', '4312', '--openclaw-command-env', 'MY_OPENCLAW', '--json'], { stdout: { write: (value) => chunks.push(value) }, cwd: await fixture(), env: { OPENCLAW_WORKBENCH_TOKEN: 'test-token-012345', OPENCLAW_WORKBENCH_APPROVAL_TOKEN: 'approve-token-012345', MY_OPENCLAW: 'openclaw.cmd' }, createServer: (options) => { assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 4312); assert.deepEqual(options.adapter, { command: 'openclaw.cmd' }); return app; } });
  assert.equal(result.app, app);
  assert.deepEqual(JSON.parse(chunks.join('')).service, { host: '127.0.0.1', port: 4312 });
});

test('CLI 拒绝只提供访问令牌而没有独立审批令牌的服务启动', async () => {
  await assert.rejects(
    async () => runCli([], { cwd: await fixture(), env: { OPENCLAW_WORKBENCH_TOKEN: 'test-token-012345' } }),
    /审批令牌缺失/,
  );
});

test('CLI 启动恢复出现 fatalError 时不监听服务', async () => {
  let listened = false;
  const app = { startup: Promise.resolve({ summary: { scanned: 0, finalized: 0, errors: 1 }, fatalError: { code: 'STARTUP_FAILED' } }), listen: async () => { listened = true; } };
  const result = await runCli([], { cwd: await fixture(), env: { OPENCLAW_WORKBENCH_TOKEN: 'test-token-012345', OPENCLAW_WORKBENCH_APPROVAL_TOKEN: 'approve-token-012345' }, createServer: () => app, stdout: { write() {} } });
  assert.equal(result.exitCode, 2);
  assert.equal(listened, false);
});
