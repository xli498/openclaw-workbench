import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTerminalSessionManager, TerminalSessionError } from '../runtime/terminal-session.mjs';

async function fixture(prefix = 'ocw-terminal-session-') {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function wait(ms = 10) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('Windows realpath casing differences do not reject an in-workspace session store', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('ocw-terminal-session-path-case-');
  const manager = createTerminalSessionManager({ root: root.toUpperCase() });
  try {
    assert.deepEqual(await manager.restore(), { sessions: 0 });
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('持久终端会话支持增量输出、输入、取消和 capability 声明', async () => {
  const root = await fixture();
  const provider = ({ onOutput }) => ({
    write(input) { onOutput({ stream: 'stdout', text: `received:${input}` }); },
    cancel() { onOutput({ stream: 'stderr', text: 'cancelled\n' }); },
    capabilities: { pty: true, input: true, incrementalOutput: true },
  });
  const manager = createTerminalSessionManager({ root, sessionProvider: provider, maxOutputBytes: 512 });
  try {
    await manager.restore();
    const created = await manager.create({ argv: ['pwd'], approved: true });
    assert.equal(created.status, 'running');
    assert.deepEqual(created.capabilities, { pty: true, input: true, incrementalOutput: true });
    const written = await manager.write(created.id, 'hello\n');
    assert.equal(written.acceptedBytes, Buffer.byteLength('hello\n'));
    const output = await manager.read(created.id, { after: 0 });
    assert.equal(output.chunks.some((chunk) => chunk.text.includes('received:hello')), true);
    const cancelled = await manager.cancel(created.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await manager.get(created.id)).status, 'cancelled');
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('无 PTY 提供者时使用受控命令 fallback，并拒绝伪造输入能力', async () => {
  const root = await fixture();
  const calls = [];
  const manager = createTerminalSessionManager({
    root,
    runCommand: async (input) => { calls.push(input); return { code: 0, stdout: 'safe output\n', stderr: '', cwd: root }; },
  });
  try {
    const created = await manager.create({ argv: ['pwd'], approved: true });
    assert.deepEqual(created.capabilities, { pty: false, input: false, incrementalOutput: false });
    await wait();
    assert.equal((await manager.get(created.id)).status, 'exited');
    assert.equal((await manager.read(created.id, { after: 0 })).chunks[0].text, 'safe output\n');
    await assert.rejects(() => manager.write(created.id, 'never-run'), (error) => error instanceof TerminalSessionError && error.code === 'PTY_UNAVAILABLE');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].approved, true);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('重启恢复会把未完成会话降级为 manual_review，绝不自动重放进程', async () => {
  const root = await fixture();
  let starts = 0;
  const provider = () => { starts += 1; return { cancel() {} }; };
  const first = createTerminalSessionManager({ root, sessionProvider: provider });
  const created = await first.create({ argv: ['pwd'], approved: true });
  assert.equal(starts, 1);
  const second = createTerminalSessionManager({ root, sessionProvider: provider });
  try {
    await second.restore();
    const restored = await second.get(created.id);
    assert.equal(restored.status, 'manual_review');
    assert.equal(starts, 1);
    await assert.rejects(() => second.write(created.id, 'replay'), (error) => error.code === 'SESSION_MANUAL_REVIEW');
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('终端会话拒绝未审批、危险 argv、越界 cwd 和超出输出预算', async () => {
  const root = await fixture();
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: ({ onOutput }) => { onOutput({ stream: 'stdout', text: 'x'.repeat(2_000) }); return { cancel() {} }; },
    maxOutputBytes: 128,
  });
  try {
    await assert.rejects(() => manager.create({ argv: ['pwd'] }), (error) => error.code === 'APPROVAL_REQUIRED');
    await assert.rejects(() => manager.create({ argv: ['sh', '-c', 'whoami'], approved: true }), (error) => error.code === 'COMMAND_POLICY_DENIED');
    await assert.rejects(() => manager.create({ argv: ['pwd'], cwd: '../outside', approved: true }), (error) => error.code === 'PATH_ESCAPE');
    const flood = await manager.create({ argv: ['pwd'], approved: true });
    await wait();
    assert.equal((await manager.get(flood.id)).status, 'failed');
    assert.equal((await manager.get(flood.id)).error.code, 'OUTPUT_LIMIT');
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY provider 输出超限时会取消运行时，避免进程继续运行', async () => {
  const root = await fixture('ocw-terminal-session-output-cancel-');
  let cancelled = 0;
  const manager = createTerminalSessionManager({
    root,
    maxOutputBytes: 128,
    sessionProvider: ({ onOutput }) => {
      onOutput({ stream: 'stdout', text: 'x'.repeat(2_000) });
      return { cancel() { cancelled += 1; } };
    },
  });
  try {
    const session = await manager.create({ argv: ['pwd'], approved: true });
    await wait();
    assert.equal((await manager.get(session.id)).error.code, 'OUTPUT_LIMIT');
    assert.equal(cancelled, 1);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('PTY provider 忽略 timeout 时 manager 会取消并收敛会话', async () => {
  const root = await fixture('ocw-terminal-session-provider-timeout-');
  let cancelled = 0;
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: () => ({ cancel() { cancelled += 1; } }),
  });
  try {
    const session = await manager.create({ argv: ['pwd'], timeoutMs: 20, approved: true });
    await wait(50);
    assert.equal((await manager.get(session.id)).status, 'timed_out');
    assert.equal((await manager.get(session.id)).error.code, 'TIMEOUT');
    assert.equal(cancelled, 1);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('终端会话清单只保存脱敏元数据，不写入输入和绝对工作区路径', async () => {
  const root = await fixture();
  const manager = createTerminalSessionManager({ root, runCommand: async () => ({ code: 0, stdout: 'token=secret-value\n', stderr: '', cwd: root }) });
  try {
    const created = await manager.create({ argv: ['pwd'], approved: true });
    await wait();
    const file = path.join(root, '.openclaw-workbench', 'terminal-sessions', `${created.id}.json`);
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.includes('secret-value'), false);
    assert.equal(raw.includes(root), false);
    assert.equal(raw.includes('token=[redacted]'), true);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('红队攻击：会话不能重放、不能启动 shell/绝对路径，也不能继承调用方环境', async () => {
  const root = await fixture('ocw-terminal-session-red-team-');
  const calls = [];
  const manager = createTerminalSessionManager({ root, runCommand: async (input) => { calls.push(input); return { code: 0, stdout: 'ok\n', stderr: '', cwd: root }; } });
  try {
    const first = await manager.create({ id: '00000000-0000-4000-8000-000000000001', argv: ['pwd'], approved: true });
    await assert.rejects(() => manager.create({ id: first.id, argv: ['pwd'], approved: true }), (error) => error.code === 'SESSION_EXISTS');
    await assert.rejects(() => manager.create({ argv: [process.execPath, '-e', 'process.env.OCW_SECRET'], approved: true }), (error) => error.code === 'COMMAND_POLICY_DENIED');
    await assert.rejects(() => manager.create({ argv: ['powershell', '-EncodedCommand', 'bad'], approved: true }), (error) => error.code === 'COMMAND_POLICY_DENIED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    assert.equal('env' in calls[0], false);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：fallback 命令超时会持久化 timed_out，而不是留下 running 会话', async () => {
  const root = await fixture('ocw-terminal-session-timeout-');
  const manager = createTerminalSessionManager({ root, runCommand: async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
  try {
    const session = await manager.create({ argv: ['pwd'], approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await manager.get(session.id)).status, 'timed_out');
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('并发创建会话不能绕过容量或重复 session ID 门禁', async () => {
  const root = await fixture('ocw-terminal-session-concurrency-');
  let starts = 0;
  const provider = async () => {
    starts += 1;
    await wait(20);
    return { cancel() {} };
  };
  const manager = createTerminalSessionManager({ root, sessionProvider: provider, maxSessions: 1 });
  try {
    const capacityResults = await Promise.allSettled([
      manager.create({ id: '00000000-0000-4000-8000-000000000001', argv: ['pwd'], approved: true }),
      manager.create({ id: '00000000-0000-4000-8000-000000000002', argv: ['pwd'], approved: true }),
    ]);
    assert.equal(capacityResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(capacityResults.filter((result) => result.status === 'rejected' && result.reason.code === 'SESSION_LIMIT').length, 1);
    await manager.close();

    const duplicateRoot = await fixture('ocw-terminal-session-duplicate-');
    const duplicateManager = createTerminalSessionManager({ root: duplicateRoot, sessionProvider: provider, maxSessions: 2 });
    try {
      const duplicateResults = await Promise.allSettled([
        duplicateManager.create({ id: '00000000-0000-4000-8000-000000000003', argv: ['pwd'], approved: true }),
        duplicateManager.create({ id: '00000000-0000-4000-8000-000000000003', argv: ['pwd'], approved: true }),
      ]);
      assert.equal(duplicateResults.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(duplicateResults.filter((result) => result.status === 'rejected' && result.reason.code === 'SESSION_EXISTS').length, 1);
      assert.equal(starts, 2);
    } finally {
      await duplicateManager.close();
      await rm(duplicateRoot, { recursive: true, force: true });
    }
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('会话关闭会等待进行中的创建并拒绝后续创建', async () => {
  const root = await fixture('ocw-terminal-session-close-');
  let cancelled = 0;
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: async () => { await wait(25); return { capabilities: { pty: true, input: true, incrementalOutput: true }, cancel() { cancelled += 1; } }; },
  });
  const pending = manager.create({ id: '00000000-0000-4000-8000-000000000010', argv: ['pwd'], approved: true });
  try {
    await manager.close();
    await pending;
    assert.notEqual(manager.get('00000000-0000-4000-8000-000000000010').status, 'running');
    assert.equal(cancelled, 1);
    await assert.rejects(() => manager.create({ argv: ['pwd'], approved: true }), (error) => error.code === 'SESSION_CLOSING');
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('已结束会话不永久占用并发容量，provider 必须显式声明 capability', async () => {
  const root = await fixture('ocw-terminal-session-reuse-');
  const manager = createTerminalSessionManager({
    root,
    maxSessions: 1,
    sessionProvider: ({ onExit }) => { queueMicrotask(() => onExit({ status: 'exited', code: 0 })); return { cancel() {} }; },
  });
  try {
    const first = await manager.create({ argv: ['pwd'], approved: true });
    await wait();
    assert.equal((await manager.get(first.id)).status, 'exited');
    const second = await manager.create({ argv: ['pwd'], approved: true });
    assert.deepEqual(second.capabilities, { pty: false, input: false, incrementalOutput: false });
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('终端输出会隐藏绝对路径，持久化冲突会把会话锁定为 manual_review', async () => {
  const root = await fixture('ocw-terminal-session-store-conflict-');
  let emit;
  let cancelled = 0;
  const manager = createTerminalSessionManager({ root, sessionProvider: ({ onOutput }) => { emit = onOutput; return { cancel() { cancelled += 1; } }; } });
  try {
    const session = await manager.create({ argv: ['pwd'], approved: true });
    const file = path.join(root, '.openclaw-workbench', 'terminal-sessions', `${session.id}.json`);
    await writeFile(file, JSON.stringify({ version: 1, id: session.id, status: 'running', argv: ['pwd'], cwd: '.', capabilities: { pty: true, input: true, incrementalOutput: true }, createdAt: session.createdAt, updatedAt: session.updatedAt, outputBytes: 0, chunks: [] }), 'utf8');
    emit({ stream: 'stdout', text: `${root}\\private\\file\n` });
    await wait(20);
    const result = await manager.get(session.id);
    assert.equal(result.status, 'manual_review');
    assert.equal(result.error.code, 'SESSION_STORE_FAILURE');
    assert.equal(cancelled, 1);
    assert.equal((await manager.read(session.id)).chunks[0]?.text.includes(root), false);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('恢复持久化终端会话时再次脱敏绝对路径输出', async () => {
  const root = await fixture('ocw-terminal-session-restore-redaction-');
  const id = '00000000-0000-4000-8000-000000000020';
  const directory = path.join(root, '.openclaw-workbench', 'terminal-sessions');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, status: 'exited', argv: [`${root}\\private\\command`], cwd: '.', capabilities: { pty: false, input: false, incrementalOutput: false }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), outputBytes: 32, chunks: [{ sequence: 1, stream: 'stdout', text: `${root}\\private\\secret.txt` }] }), 'utf8');
    const manager = createTerminalSessionManager({ root });
    await manager.restore();
    assert.equal((await manager.read(id)).chunks[0].text.includes(root), false);
    assert.equal((await manager.get(id)).argv[0].includes(root), false);
    await manager.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
