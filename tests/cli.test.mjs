import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs, runCli } from '../bin/workbench.mjs';
import { startWorkbench as packageStartWorkbench } from 'openclaw-workbench';

async function fixture() { return mkdtemp(`${tmpdir()}/openclaw-workbench-cli-`); }

test('package self-reference resolves the declared public entrypoint', () => {
  assert.equal(typeof packageStartWorkbench, 'function');
});

test('CLI 参数只接受明确 root、json 和 help', () => {
  assert.deepEqual(parseArgs(['--root', 'demo', '--host', 'localhost', '--port', '4312', '--token', 'test-token-012345', '--approval-token', 'approve-token-012345', '--json']), { root: 'demo', host: 'localhost', port: 4312, token: 'test-token-012345', approvalToken: 'approve-token-012345', json: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--root']), /requires a path/);
  assert.throws(() => parseArgs(['--port', '70000']), /0 to 65535/);
  assert.throws(() => parseArgs(['--shell']), /unknown argument/);
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
  const result = await runCli(['--token', 'test-token-012345', '--port', '4312', '--json'], { stdout: { write: (value) => chunks.push(value) }, cwd: await fixture(), createServer: (options) => { assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 4312); return app; } });
  assert.equal(result.app, app);
  assert.deepEqual(JSON.parse(chunks.join('')).service, { host: '127.0.0.1', port: 4312 });
});

test('CLI 启动恢复出现 fatalError 时不监听服务', async () => {
  let listened = false;
  const app = { startup: Promise.resolve({ summary: { scanned: 0, finalized: 0, errors: 1 }, fatalError: { code: 'STARTUP_FAILED' } }), listen: async () => { listened = true; } };
  const result = await runCli(['--token', 'test-token-012345'], { cwd: await fixture(), createServer: () => app, stdout: { write() {} } });
  assert.equal(result.exitCode, 2);
  assert.equal(listened, false);
});
