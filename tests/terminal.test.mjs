import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStableCwd, runControlledCommand } from '../runtime/terminal.mjs';

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
  const outside = await fixture();
  await symlink(outside, path.join(root, 'escape'));
  await assert.rejects(() => runControlledCommand({ root, argv: ['echo hi'], approved: true }), (error) => error.code === 'SPAWN_FAILED' || error.code === 'INVALID_COMMAND' || error.code === 'EXECUTABLE_UNAVAILABLE');
  await assert.rejects(() => runControlledCommand({ root, argv: ['echo', 'x'], cwd: '../outside', approved: true }), (error) => error.code === 'PATH_ESCAPE');
  await assert.rejects(() => runControlledCommand({ root, argv: ['pwd'], cwd: 'escape', approved: true }), (error) => error.code === 'SYMLINK_ESCAPE');
});

test('稳定 cwd 句柄在目录改名后仍锚定原目录', async () => {
  const root = await fixture();
  const original = path.join(root, 'work');
  const moved = path.join(root, 'moved');
  await mkdir(original);
  const stable = await openStableCwd(root, 'work');
  try {
    await rename(original, moved);
    const result = await new Promise((resolve, reject) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: stable.procPath, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`exit ${code}`)));
      }, reject);
    });
    assert.equal(result, moved);
  } finally { await stable.handle.close(); }
});

test('受控命令在打开 cwd 后替换可见父路径，仍在原目录 inode 中执行', async () => {
  const root = await fixture();
  const outside = await fixture();
  const work = path.join(root, 'work');
  const moved = path.join(root, 'moved');
  await mkdir(work);
  const result = await runControlledCommand({
    root, cwd: 'work', argv: [process.execPath, '-e', 'console.log(process.cwd())'], approved: true,
    __testHooks: { onCwdOpened: () => { renameSync(work, moved); symlinkSync(outside, work); } },
  });
  assert.equal(result.stdout.trim(), moved);
  assert.equal(result.cwd, work);
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

test('spawn 同步 throw 保留关闭诊断、关闭稳定 cwd FD，且 Promise 只结算一次', async () => {
  const root = await fixture(); let opened; let closeErrors = 0;
  await assert.rejects(() => runControlledCommand({
    root, argv: [process.execPath, '--version'], approved: true,
    __testHooks: {
      onCwdOpened: (stable) => {
        opened = stable;
        const close = stable.handle.close.bind(stable.handle);
        stable.handle.close = async () => {
          await close();
          const error = new Error('synthetic close failure');
          error.code = 'ECLOSE';
          throw error;
        };
      },
      onCloseError: () => { closeErrors += 1; },
      spawn: () => { throw new Error('synthetic synchronous spawn failure'); },
    },
  }), (error) => error.code === 'SPAWN_FAILED'
    && error.message === 'synthetic synchronous spawn failure'
    && error.details.closeError?.code === 'ECLOSE'
    && error.details.closeError?.message === 'synthetic close failure');
  assert.equal(closeErrors, 1);
  await assert.rejects(() => opened.handle.stat(), /closed|EBADF/i);
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
