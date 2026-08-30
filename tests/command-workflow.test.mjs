import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approveAndRunCommand, createCommandProposal, WorkflowError } from '../runtime/workflow.mjs';

async function fixture() { return mkdtemp(path.join(tmpdir(), 'ocw-command-workflow-')); }

test('命令提案必须处于 Terminal 模式并经明确审批', async () => {
  const root = await fixture();
  assert.throws(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', mode: 'Code' }), (error) => error.code === 'MODE_INSUFFICIENT');
  const proposal = createCommandProposal({ root, argv: [process.execPath, '-e', 'console.log("ok")'], sessionId: 's', currentRevision: 'r1' });
  await assert.rejects(() => approveAndRunCommand({ proposal, root, currentRevision: 'r1' }), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.throws(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', timeoutMs: 600001 }), (error) => error.code === 'INVALID_TIMEOUT');
  assert.throws(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', maxOutputBytes: 16 * 1024 * 1024 + 1 }), (error) => error.code === 'INVALID_OUTPUT_LIMIT');
});

test('审批后执行命令并进入 verified', async () => {
  const root = await fixture();
  const events = [];
  const proposal = createCommandProposal({ root, argv: [process.execPath, '-e', 'console.log("ok")'], sessionId: 's', currentRevision: 'r1', audit: { append(event) { events.push(event); } } });
  const result = await approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1', audit: { append(event) { events.push(event); } } });
  assert.equal(result.action.status, 'verified');
  assert.equal(result.result.stdout.trim(), 'ok');
  assert.deepEqual(events.map((event) => event.type), ['command.proposed', 'command.approved', 'command.verified']);
  await assert.rejects(() => approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_REPLAYED');
});

test('命令失败、超时和取消会返回带终态 action 的错误', async () => {
  const root = await fixture();
  const make = (argv, extra = {}) => createCommandProposal({ root, argv, sessionId: Math.random().toString(), currentRevision: 'r1', ...extra });
  await assert.rejects(() => approveAndRunCommand({ proposal: make([process.execPath, '-e', 'process.exit(3)']), root, approved: true, currentRevision: 'r1' }), (error) => error instanceof WorkflowError && error.code === 'PROCESS_FAILED' && error.details.action.status === 'failed');
  await assert.rejects(() => approveAndRunCommand({ proposal: make([process.execPath, '-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 20 }), root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'TIMEOUT' && error.details.action.status === 'timed_out');
  const controller = new AbortController();
  const pending = approveAndRunCommand({ proposal: make([process.execPath, '-e', 'setTimeout(() => {}, 1000)']), root, approved: true, currentRevision: 'r1', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === 'ABORTED' && error.details.action.status === 'cancelled');
});

test('命令 action 跨进程持久化防重放且启动不自动执行', async () => {
  const root = await fixture();
  const proposal = createCommandProposal({ root, argv: [process.execPath, '-e', 'process.exit(0)'], sessionId: 'persistent-replay', currentRevision: 'r1' });
  await approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' });
  const freshProposal = { ...proposal, action: { ...proposal.action }, command: { ...proposal.command } };
  await assert.rejects(() => approveAndRunCommand({ proposal: freshProposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_REPLAYED');
});
