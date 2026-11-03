import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('terminal session store still rejects a directory junction outside the workspace', { skip: process.platform !== 'win32' }, async () => {
  const root = await fixture('ocw-terminal-session-junction-root-');
  const outside = await fixture('ocw-terminal-session-junction-outside-');
  const parent = path.join(root, '.openclaw-workbench');
  const directory = path.join(parent, 'terminal-sessions');
  const manager = createTerminalSessionManager({ root });
  try {
    await mkdir(parent, { recursive: true });
    await symlink(outside, directory, 'junction');
    await assert.rejects(() => manager.restore(), (error) => error instanceof TerminalSessionError && error.code === 'SESSION_STORE_ESCAPE');
  } finally {
    await manager.close();
    await rm(directory, { force: true });
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

test('终端会话审批门禁只接受严格 true，非布尔真值不得启动 provider 或 runner', async () => {
  const root = await fixture('ocw-terminal-session-approval-strict-');
  let providerStarts = 0;
  const providerManager = createTerminalSessionManager({ root, sessionProvider: () => { providerStarts += 1; return { cancel() {} }; } });
  try {
    for (const approved of [1, 'yes', {}]) {
      await assert.rejects(() => providerManager.create({ argv: ['pwd'], approved }), (error) => error.code === 'APPROVAL_REQUIRED');
    }
    assert.equal(providerStarts, 0);
  } finally {
    await providerManager.close();
  }
  const runnerRoot = await fixture('ocw-terminal-session-approval-strict-runner-');
  let runnerCalls = 0;
  const runnerManager = createTerminalSessionManager({ root: runnerRoot, runCommand: async () => { runnerCalls += 1; return { code: 0, stdout: 'ok\n', stderr: '', cwd: runnerRoot }; } });
  try {
    await assert.rejects(() => runnerManager.create({ argv: ['pwd'], approved: 1 }), (error) => error.code === 'APPROVAL_REQUIRED');
    assert.equal(runnerCalls, 0);
  } finally {
    await runnerManager.close();
    await rm(root, { recursive: true, force: true });
    await rm(runnerRoot, { recursive: true, force: true });
  }
});

test('已是 manual_review 的快照恢复时统一清零能力位并保留原复核原因', async () => {
  const root = await fixture('ocw-terminal-session-manual-review-caps-');
  const id = '00000000-0000-4000-8000-000000000030';
  const directory = path.join(root, '.openclaw-workbench', 'terminal-sessions');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, status: 'manual_review', argv: ['pwd'], cwd: '.', capabilities: { pty: true, input: true, incrementalOutput: true }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), outputBytes: 0, chunks: [], error: { code: 'SESSION_STORE_FAILURE' } }), 'utf8');
    const manager = createTerminalSessionManager({ root });
    await manager.restore();
    const restored = await manager.get(id);
    assert.equal(restored.status, 'manual_review');
    assert.deepEqual(restored.capabilities, { pty: false, input: false, incrementalOutput: false });
    assert.equal(restored.error.code, 'SESSION_STORE_FAILURE');
    const onDisk = JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8'));
    assert.deepEqual(onDisk.capabilities, { pty: false, input: false, incrementalOutput: false });
    await manager.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('永不返回的 PTY provider 不会挂住创建，会话在超时内收敛且能力位为 false', async () => {
  const root = await fixture('ocw-terminal-session-provider-hang-');
  const manager = createTerminalSessionManager({ root, sessionProvider: () => new Promise(() => {}) });
  try {
    const startedAt = Date.now();
    const session = await manager.create({ argv: ['pwd'], timeoutMs: 30, approved: true });
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(session.status, 'timed_out');
    assert.equal(session.error.code, 'TIMEOUT');
    assert.deepEqual(session.capabilities, { pty: false, input: false, incrementalOutput: false });
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('迟到返回的 PTY 句柄会被取消且不更新已终态会话的能力位', async () => {
  const root = await fixture('ocw-terminal-session-provider-late-');
  let lateCancelled = 0;
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: () => new Promise((resolve) => setTimeout(() => resolve({ cancel() { lateCancelled += 1; }, capabilities: { pty: true, input: true, incrementalOutput: true } }), 80)),
  });
  try {
    const session = await manager.create({ argv: ['pwd'], timeoutMs: 20, approved: true });
    assert.equal(session.status, 'timed_out');
    await wait(200);
    assert.deepEqual((await manager.get(session.id)).capabilities, { pty: false, input: false, incrementalOutput: false });
    assert.equal(lateCancelled, 1);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
// Regression for the s1 review finding (Q23-4): the public view redacted
// argv through the path-aware helper, but the persisted snapshot and the
// restore path used the secret-only helper, so absolute paths survived on
// disk even though get() looked clean. All paths below are synthetic fakes
// that never appear on this machine; the old fixed-prefix pattern covered
// none of the POSIX forms here, and only the drive/UNC forms.
test('持久化快照与公开视图对未覆盖前缀的绝对路径 argv 脱敏一致，且执行参数保持原文', async () => {
  const root = await fixture('ocw-terminal-session-persist-redaction-');
  const seen = [];
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: ({ argv, onOutput }) => {
      seen.push([...argv]);
      onOutput({ stream: 'stdout', text: 'see http://example.com/x and a/b' });
      return { cancel() {} };
    },
  });
  const fakes = [
    '/workspace/fake-proj/secret.txt',
    '/opt/fake-vendor/tool.bin',
    '/srv/fake-data/file.txt',
    '/etc/fake-conf.conf',
    '/usr/local/fake/bin',
    'C:\\fake\\secret.txt',
    '\\\\fake-server\\fake-share\\file.txt',
  ];
  try {
    const session = await manager.create({ argv: ['pwd', ...fakes, '--opt=/workspace/fake-proj/other.txt'], approved: true });
    await wait();
    // The live command still receives the real arguments; only outward
    // copies are redacted.
    assert.deepEqual(seen[0], ['pwd', ...fakes, '--opt=/workspace/fake-proj/other.txt']);
    const shown = await manager.get(session.id);
    assert.deepEqual(shown.argv, ['pwd', ...fakes.map(() => '[path redacted]'), '--opt=[path redacted]']);
    assert.deepEqual(manager.list()[0].argv, shown.argv);
    // URLs and relative segments are not absolute paths and must survive.
    assert.equal((await manager.read(session.id)).chunks[0].text, 'see http://example.com/x and a/b');
    const file = path.join(root, '.openclaw-workbench', 'terminal-sessions', `${session.id}.json`);
    for (const raw of [await readFile(file, 'utf8')]) {
      // Disk assertions must compare parsed values, not raw bytes: a Windows
      // path leaks into JSON with doubled backslashes, so raw.includes(fake)
      // is false even when the leak is present. Check both the parsed values
      // and the JSON-escaped spelling of every fake.
      const parsed = JSON.parse(raw);
      const diskValues = [...parsed.argv, ...parsed.chunks.map((chunk) => chunk.text)];
      for (const fake of [...fakes, '/workspace/fake-proj/other.txt']) {
        assert.equal(diskValues.some((value) => String(value).includes(fake)), false);
        assert.equal(raw.includes(JSON.stringify(fake).slice(1, -1)), false);
      }
      assert.equal(raw.includes('[path redacted]'), true);
    }
    await manager.close();
    const afterClose = await readFile(file, 'utf8');
    const parsedAfterClose = JSON.parse(afterClose);
    const diskValuesAfterClose = [...parsedAfterClose.argv, ...parsedAfterClose.chunks.map((chunk) => chunk.text)];
    for (const fake of fakes) {
      assert.equal(diskValuesAfterClose.some((value) => String(value).includes(fake)), false);
      assert.equal(afterClose.includes(JSON.stringify(fake).slice(1, -1)), false);
    }
    assert.equal(afterClose.includes('[path redacted]'), true);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('恢复旧快照时磁盘 argv 与公开视图同步脱敏，二次恢复仍干净', async () => {
  const root = await fixture('ocw-terminal-session-restore-disk-redaction-');
  const id = '00000000-0000-4000-8000-000000000021';
  const directory = path.join(root, '.openclaw-workbench', 'terminal-sessions');
  const fakes = ['/workspace/fake-tool', '/opt/fake-data/file.txt', 'C:\\fake\\secret.txt', '/srv/fake-data/out.txt'];
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, status: 'exited', argv: fakes.slice(0, 3), cwd: '.', capabilities: { pty: false, input: false, incrementalOutput: false }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), outputBytes: 32, chunks: [{ sequence: 1, stream: 'stdout', text: `wrote ${fakes[3]}` }] }), 'utf8');
    const manager = createTerminalSessionManager({ root });
    await manager.restore();
    assert.deepEqual((await manager.get(id)).argv, ['[path redacted]', '[path redacted]', '[path redacted]']);
    assert.equal((await manager.read(id)).chunks[0].text.includes(fakes[3]), false);
    // close() re-persists every record, so the on-disk snapshot itself must
    // now be clean — checking get() alone would not prove this.
    await manager.close();
    const raw = await readFile(path.join(directory, `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    const diskValues = [...parsed.argv, ...parsed.chunks.map((chunk) => chunk.text)];
    for (const fake of fakes) {
      assert.equal(diskValues.some((value) => String(value).includes(fake)), false);
      assert.equal(raw.includes(JSON.stringify(fake).slice(1, -1)), false);
    }
    assert.equal(raw.includes('[path redacted]'), true);
    const second = createTerminalSessionManager({ root });
    await second.restore();
    assert.deepEqual((await second.get(id)).argv, ['[path redacted]', '[path redacted]', '[path redacted]']);
    await second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('含空格的工作区根路径在持久化与公开视图中整体脱敏', async () => {
  const spaced = path.join(tmpdir(), `ocw fake root-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(spaced, { recursive: true });
  const manager = createTerminalSessionManager({ root: spaced, sessionProvider: () => ({ cancel() {} }) });
  try {
    const session = await manager.create({ argv: ['pwd', `${spaced}/sub/secret.txt`], approved: true });
    // Exact equality: a prefix-only redaction would stop at the space and
    // leak the remainder of the root path.
    assert.equal((await manager.get(session.id)).argv[1], '[path redacted]');
    await manager.close();
    const raw = await readFile(path.join(spaced, '.openclaw-workbench', 'terminal-sessions', `${session.id}.json`), 'utf8');
    assert.equal(raw.includes(spaced), false);
    assert.equal(raw.includes('fake root'), false);
    assert.equal(raw.includes('[path redacted]'), true);
  } finally { await manager.close(); await rm(spaced, { recursive: true, force: true }); }
});

// Redline Q1: delimiters that used to pass paths through (`>`, `<`, `|`, `&`),
// forward-slash UNC, and a space-containing path whose continuation segment
// carries a separator must all redact as one placeholder; a closing `)` must
// survive instead of being swallowed. URLs and relative segments still pass.
test('定界符与 UNC 路径在输出中整体脱敏，网址与相对路径不受影响', async () => {
  const root = await fixture('ocw-terminal-session-delim-redaction-');
  const manager = createTerminalSessionManager({
    root,
    sessionProvider: ({ onOutput }) => {
      onOutput({ stream: 'stdout', text: 'a >/tmp/private.txt b </tmp/private2.txt c |/tmp/private3.txt d &/tmp/private4.txt e //server/share/file.txt f /opt/private dir/file g (see /tmp/private5.txt) h see http://example.com/x and a/b' });
      return { cancel() {} };
    },
  });
  try {
    const session = await manager.create({ argv: ['pwd'], approved: true });
    await wait();
    assert.equal((await manager.read(session.id)).chunks[0].text, 'a >[path redacted] b <[path redacted] c |[path redacted] d &[path redacted] e [path redacted] f [path redacted] g (see [path redacted]) h see http://example.com/x and a/b');
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

// Redline Q2: a sibling directory sharing the root prefix must never be
// partially replaced (`<root>2/...` used to become `[path redacted]2/...`),
// a root spelled with backslash separators must redact as one placeholder,
// and a space-containing sibling root must redact whole as well.
test('工作区根同名兄弟目录不被部分替换，反斜杠拼写根整体脱敏', async () => {
  const root = await fixture('ocw-terminal-session-root-boundary-');
  const manager = createTerminalSessionManager({ root, sessionProvider: () => ({ cancel() {} }) });
  try {
    const backslashRoot = root.replaceAll('/', '\\');
    const session = await manager.create({ argv: ['pwd', `${root}2/sub/file.txt`, `${backslashRoot}\\sub\\file.txt`, `pre${root}/sub/file.txt`], approved: true });
    assert.deepEqual((await manager.get(session.id)).argv, ['pwd', '[path redacted]', '[path redacted]', 'pre[path redacted]']);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
  const spaced = path.join(tmpdir(), `ocw fake root-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(spaced, { recursive: true });
  const spacedManager = createTerminalSessionManager({ root: spaced, sessionProvider: () => ({ cancel() {} }) });
  try {
    const session = await spacedManager.create({ argv: ['pwd', `${spaced}2/sub/file.txt`], approved: true });
    assert.equal((await spacedManager.get(session.id)).argv[1], '[path redacted]');
  } finally { await spacedManager.close(); await rm(spaced, { recursive: true, force: true }); }
});

// Redline Q4: a space-containing root appearing as a secret value used to be
// cut at the space by the secret rule before root matching ran, leaking the
// tail (`key=[redacted] fake root-.../file`). Root matching now runs first,
// and a placeholder after a key is not mangled by the secret rule.
test('秘密值中的含空格根路径整体脱敏，占位符不被秘密规则切断', async () => {
  const spaced = path.join(tmpdir(), `ocw fake root-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(spaced, { recursive: true });
  const manager = createTerminalSessionManager({ root: spaced, sessionProvider: () => ({ cancel() {} }) });
  try {
    const session = await manager.create({ argv: ['pwd', `key=${spaced}/sub/file.txt`, 'key=dummy', 'key=/tmp/plain-path.txt'], approved: true });
    assert.deepEqual((await manager.get(session.id)).argv, ['pwd', 'key=[path redacted]', 'key=[redacted]', 'key=[path redacted]']);
    await manager.close();
    const parsed = JSON.parse(await readFile(path.join(spaced, '.openclaw-workbench', 'terminal-sessions', `${session.id}.json`), 'utf8'));
    assert.equal(parsed.argv.some((value) => String(value).includes('fake root')), false);
  } finally { await manager.close(); await rm(spaced, { recursive: true, force: true }); }
});

// Redline Q7: the disk assertion itself must be able to catch a Windows-path
// leak. The old raw.includes(fake) check is false for a JSON-escaped leak, so
// this test asserts on parsed snapshot values and on the JSON-escaped
// spelling, for both argv and chunk text.
test('磁盘断言按解析后取值比对，含反斜杠路径泄露可被检出', async () => {
  const root = await fixture('ocw-terminal-session-disk-parsed-assert-');
  const id = '00000000-0000-4000-8000-000000000022';
  const directory = path.join(root, '.openclaw-workbench', 'terminal-sessions');
  const fakes = ['C:\\fake\\secret.txt', '\\\\fake-server\\fake-share\\file.txt'];
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ version: 1, id, status: 'exited', argv: fakes, cwd: '.', capabilities: { pty: false, input: false, incrementalOutput: false }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), outputBytes: 32, chunks: [{ sequence: 1, stream: 'stdout', text: `wrote ${fakes[0]}` }] }), 'utf8');
    const manager = createTerminalSessionManager({ root });
    await manager.restore();
    await manager.close();
    const raw = await readFile(path.join(directory, `${id}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    const diskValues = [...parsed.argv, ...parsed.chunks.map((chunk) => chunk.text)];
    for (const fake of fakes) {
      assert.equal(diskValues.some((value) => String(value).includes(fake)), false);
      assert.equal(raw.includes(JSON.stringify(fake).slice(1, -1)), false);
    }
    assert.equal(raw.includes('[path redacted]'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
