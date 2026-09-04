import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide } from '../runtime/policy.mjs';
import { actionHash, assertWorkspaceRevision, createAction, transition } from '../runtime/action.mjs';
import { createAuditLog, createFileAuditLog, verifyAuditChain } from '../runtime/audit.mjs';
import { AdapterError, buildAgentArgv, parseAgentJson, runAgent } from '../runtime/openclaw-adapter.mjs';
import { createEventBus } from '../runtime/event-bus.mjs';
import { symlinkOrSkip } from './test-support.mjs';

test('Adapter 使用 argv 参数，不启用 shell，并要求明确会话目标', () => {
  const argv = buildAgentArgv({ message: '只输出状态', sessionKey: 'workbench-test', thinking: 'minimal', local: true });
  assert.deepEqual(argv, ['agent', '--json', '--message', '只输出状态', '--session-key', 'workbench-test', '--thinking', 'minimal', '--local']);
  assert.throws(() => buildAgentArgv({ message: 'x' }), /sessionKey or agent/);
});

test('Adapter 只接受 JSON 对象响应，并分类坏响应', () => {
  assert.deepEqual(parseAgentJson('{"payloads":[]}'), { payloads: [] });
  assert.throws(() => parseAgentJson('not-json'), (error) => error instanceof AdapterError && error.code === 'INVALID_RESPONSE');
});

test('Adapter 在启动前收到取消信号时不创建子进程', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runAgent({ message: 'x', agent: 'main' }, { signal: controller.signal }), (error) => error.code === 'ABORTED');
});

test('Adapter 超时会终止执行组，而不是等待其后代自然退出', { timeout: 5_000 }, async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(path.join(tmpdir(), 'ocw-adapter-timeout-'));
  const command = path.join(dir, 'agent-stub');
  try {
    await writeFile(command, '#!/bin/sh\nsleep 2 &\nwait\n');
    await chmod(command, 0o700);
    const startedAt = Date.now();
    await assert.rejects(() => runAgent({ message: 'x', agent: 'main' }, { command, timeoutMs: 50 }), (error) => error instanceof AdapterError && error.code === 'TIMEOUT');
    assert.ok(Date.now() - startedAt < 1_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('事件总线支持订阅实时事件并可安全取消订阅', () => {
  const bus = createEventBus();
  const received = [];
  const unsubscribe = bus.subscribe((event) => received.push(event.type));
  bus.publish({ type: 'stream.test' });
  unsubscribe();
  bus.publish({ type: 'stream.after' });
  assert.deepEqual(received, ['stream.test']);
});

test('Ask 只能读取，Plan 不能修改，Code 修改必须审批', () => {
  assert.deepEqual(decide({ mode: 'Ask', actionType: 'read' }).allowed, true);
  assert.equal(decide({ mode: 'Ask', actionType: 'patch' }).reason, 'mode_insufficient');
  assert.equal(decide({ mode: 'Plan', actionType: 'patch' }).reason, 'mode_insufficient');
  assert.equal(decide({ mode: 'Code', actionType: 'patch' }).reason, 'approval_required');
  assert.equal(decide({ mode: 'Code', actionType: 'patch', approved: true }).allowed, true);
});

test('敏感目标即使只读也需要审批', () => {
  assert.equal(decide({ mode: 'Ask', actionType: 'read', targetSensitive: true }).reason, 'approval_required');
});

test('Action 必须按状态机推进，终态不可继续修改', () => {
  const action = createAction({ type: 'patch', sessionId: 's1', workspaceRevision: 'r1', target: ['a.txt'], preview: 'diff', now: new Date('2026-08-29T00:00:00Z') });
  assert.equal(action.status, 'proposed');
  const inspected = transition(action, 'inspected');
  const waiting = transition(inspected, 'awaiting_approval');
  const approved = transition(waiting, 'approved');
  const executing = transition(approved, 'executing');
  const verified = transition(executing, 'verified');
  assert.throws(() => transition(verified, 'executing'), /action_terminal/);
  assert.throws(() => transition(action, 'executing'), /invalid_transition/);
});

test('Action hash 绑定不可变输入，hash 不匹配时拒绝', () => {
  const input = { type: 'command', sessionId: 's1', workspaceRevision: 'r1', target: 'npm test', preview: '' };
  const a = createAction(input);
  assert.equal(a.actionHash, actionHash({ ...input, risk: 'medium' }));
  assert.throws(() => transition(a, 'inspected', { expectedHash: 'bad' }), /action_hash_mismatch/);
  assert.equal(assertWorkspaceRevision(a, 'r1'), true);
  assert.throws(() => transition(a, 'inspected', { currentWorkspaceRevision: 'r2' }), /workspace_revision_mismatch/);
});

test('持久化审计日志追加哈希链，并可重新加载', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-audit-'));
  const filePath = path.join(root, 'audit.jsonl');
  const first = await createFileAuditLog({ root, filePath: 'audit.jsonl', clock: () => new Date('2026-08-29T00:00:00Z') });
  const a = await first.append({ type: 'action.created', actor: 'user', actionId: 'a1' });
  assert.equal(a.previousHash, 'GENESIS');
  const second = await createFileAuditLog({ root, filePath: 'audit.jsonl', clock: () => new Date('2026-08-29T00:00:01Z') });
  const b = await second.append({ type: 'action.approved', actor: 'user', actionId: 'a1' });
  assert.equal(b.previousHash, a.recordHash);
  const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const records = await second.list();
  assert.equal(records.length, 2);
  assert.equal(verifyAuditChain(records), true);
  records[1] = { ...records[1], actor: 'tampered' };
  assert.equal(verifyAuditChain(records), false);
});

test('verifyAuditChain 接受空链并拒绝断链、篡改和缺少 recordHash', () => {
  assert.equal(verifyAuditChain([]), true);
  assert.equal(verifyAuditChain([{ previousHash: 'wrong', recordHash: 'x' }]), false);
  assert.equal(verifyAuditChain([{ previousHash: 'GENESIS', recordHash: 'x', type: 'test' }]), false);
  assert.equal(verifyAuditChain([{ previousHash: 'GENESIS' }]), false);
});

test('审计日志追加后不可通过 list 结果反向修改内部状态', () => {
  const log = createAuditLog({ clock: () => new Date('2026-08-29T00:00:00Z') });
  log.append({ type: 'action.created', actor: 'user', actionId: 'a1' });
  const copy = log.list();
  assert.equal(copy.length, 1);
  assert.throws(() => log.append({ actor: 'user' }), /audit_event_requires_type/);
  copy.length = 0;
  assert.equal(log.list().length, 1);
});

test('文件审计日志并发追加保持单一哈希链', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-audit-concurrent-'));
  const filePath = path.join(root, 'audit.jsonl');
  const logs = await Promise.all(Array.from({ length: 8 }, () => createFileAuditLog({ root, filePath: 'audit.jsonl' })));
  await Promise.all(logs.map((log, index) => log.append({ type: 'concurrent.test', actor: `worker-${index}` })));
  const records = await logs[0].list();
  assert.equal(records.length, 8);
  assert.equal(verifyAuditChain(records), true);
});

test('文件审计日志可接管已过期且进程不存在的锁', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-audit-stale-lock-'));
  const lockPath = path.join(root, 'audit.jsonl.lock');
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, token: 'stale-owner-token', createdAt: Date.now() - 120_000 }));
  const log = await createFileAuditLog({ root, filePath: 'audit.jsonl' });
  await log.append({ type: 'stale-lock.recovered', actor: 'test' });
  const records = await log.list();
  assert.equal(records.length, 1);
  assert.equal(verifyAuditChain(records), true);
});

test('文件审计日志拒绝路径逃逸和已存在的符号链接', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-audit-safe-'));
  await assert.rejects(() => createFileAuditLog({ root, filePath: '../outside.jsonl' }), /audit_invalid_path/);
  const outside = path.join(root, 'outside.jsonl');
  await writeFile(outside, '');
  if (!await symlinkOrSkip(t, outside, path.join(root, 'audit-link.jsonl'))) return;
  await assert.rejects(() => createFileAuditLog({ root, filePath: 'audit-link.jsonl' }), /audit_path_escape/);
});
