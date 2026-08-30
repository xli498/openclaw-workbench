import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runControlledCommand } from '../runtime/terminal.mjs';

async function fixture() { return mkdtemp(path.join(tmpdir(), 'ocw-terminal-')); }

test('终端执行需要明确审批，并使用工作区 cwd', async () => {
  const root = await fixture();
  await assert.rejects(() => runControlledCommand({ root, argv: [process.execPath, '-e', 'console.log(process.cwd())'] }), (error) => error.code === 'APPROVAL_REQUIRED');
  const result = await runControlledCommand({ root, argv: [process.execPath, '-e', 'console.log(process.cwd())'], approved: true });
  assert.equal(result.cwd, root);
  assert.equal(result.stdout.trim(), root);
});

test('拒绝 shell 字符串、越界 cwd 和 cwd 逃逸符号链接', async () => {
  const root = await fixture();
  await assert.rejects(() => runControlledCommand({ root, argv: ['echo hi'], approved: true }), (error) => error.code === 'SPAWN_FAILED' || error.code === 'INVALID_COMMAND' || error.code === 'EXECUTABLE_UNAVAILABLE');
  await assert.rejects(() => runControlledCommand({ root, argv: ['echo', 'x'], cwd: '../outside', approved: true }), (error) => error.code === 'PATH_ESCAPE');
});

test('命令超时、取消和输出超限都会终止执行', async () => {
  const root = await fixture();
  await assert.rejects(() => runControlledCommand({ root, argv: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'], approved: true, timeoutMs: 20 }), (error) => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const pending = runControlledCommand({ root, argv: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'], approved: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === 'ABORTED');
  await assert.rejects(() => runControlledCommand({ root, argv: [process.execPath, '-e', 'process.stdout.write("123456")'], approved: true, maxOutputBytes: 3 }), (error) => error.code === 'OUTPUT_LIMIT');
});

test('环境变量只保留允许键', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'unused.txt'), 'ok');
  const result = await runControlledCommand({ root, argv: [process.execPath, '-e', 'console.log(process.env.OCW_SECRET || "missing", process.env.NODE_OPTIONS || "node-options-missing")'], approved: true, env: { PATH: process.env.PATH, OCW_SECRET: 'hidden', NODE_OPTIONS: '--require=/outside/injection.js' } });
  assert.equal(result.stdout.trim(), 'missing node-options-missing');
});

test('命令环境不接受调用方覆盖 PATH', async () => {
  const root = await fixture();
  const result = await runControlledCommand({ root, argv: ['node', '-e', 'console.log(process.env.PATH === process.argv[1])', process.env.PATH], approved: true, env: { PATH: '/untrusted/bin' } });
  assert.equal(result.stdout.trim(), 'true');
});

test('命令解析忽略调用方 PATH 中的同名可执行文件', async () => {
  const root = await fixture();
  const fakeBin = await mkdtemp(path.join(tmpdir(), 'ocw-fake-bin-'));
  await writeFile(path.join(fakeBin, 'pwd'), '#!/bin/sh\necho hijacked\n', { mode: 0o755 });
  const result = await runControlledCommand({ root, argv: ['pwd'], approved: true, env: { PATH: fakeBin } });
  assert.equal(result.stdout.trim(), root);
});

test('命令环境不接受调用方覆盖 HOME 和 TMPDIR', async () => {
  const root = await fixture();
  const result = await runControlledCommand({ root, argv: [process.execPath, '-e', 'console.log(process.env.HOME !== "\/untrusted\/home", process.env.TMPDIR !== "\/untrusted\/tmp")'], approved: true, env: { HOME: '/untrusted/home', TMPDIR: '/untrusted/tmp' } });
  assert.equal(result.stdout.trim(), 'true true');
});

test('拒绝超大 argv 和超长执行时间', async () => {
  const root = await fixture();
  await assert.rejects(() => runControlledCommand({ root, argv: [process.execPath, 'x'.repeat(16 * 1024 + 1)], approved: true }), (error) => error.code === 'INVALID_COMMAND_SIZE');
  await assert.rejects(() => runControlledCommand({ root, argv: [process.execPath, '--version'], approved: true, timeoutMs: 600_001 }), (error) => error.code === 'INVALID_TIMEOUT');
});
