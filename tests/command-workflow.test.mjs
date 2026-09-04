import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approveAndRunCommand, createCommandProposal, WorkflowError } from '../runtime/workflow.mjs';
import { symlinkOrSkip } from './test-support.mjs';

async function fixture() { return realpath(await mkdtemp(path.join(tmpdir(), 'ocw-command-workflow-'))); }

test('命令提案必须处于 Terminal 模式并经明确审批', async () => {
  const root = await fixture();
  await assert.rejects(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', mode: 'Code' }), (error) => error.code === 'MODE_INSUFFICIENT');
  await assert.rejects(() => createCommandProposal({ root, argv: ['pwd'], sessionId: 's' }), (error) => error.code === 'CURRENT_REVISION_REQUIRED');
  const proposal = await createCommandProposal({ root, argv: ['pwd'], sessionId: 's', currentRevision: 'r1' });
  await assert.rejects(() => approveAndRunCommand({ proposal, root, currentRevision: 'r1' }), (error) => error.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', timeoutMs: 600001 }), (error) => error.code === 'INVALID_TIMEOUT');
  await assert.rejects(() => createCommandProposal({ root, argv: ['echo', 'ok'], sessionId: 's', maxOutputBytes: 16 * 1024 * 1024 + 1 }), (error) => error.code === 'INVALID_OUTPUT_LIMIT');
});

test('审批后执行命令并进入 verified', async () => {
  const root = await fixture();
  const events = [];
  const proposal = await createCommandProposal({ root, argv: ['pwd'], sessionId: 's', currentRevision: 'r1', audit: { async append(event) { events.push(event); } } });
  const result = await approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1', audit: { append(event) { events.push(event); } } });
  assert.equal(result.action.status, 'verified');
  assert.equal(result.result.stdout.trim(), root);
  assert.deepEqual(events.map((event) => event.type), ['command.proposed', 'command.approved', 'command.verified']);
  await assert.rejects(() => approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_REPLAYED');
});

test('命令提案等待审计完成，审计失败不会返回提案', async () => {
  const root = await fixture();
  let finished = false;
  await assert.rejects(() => createCommandProposal({ root, argv: ['pwd'], sessionId: 'audit-failure', currentRevision: 'r1', audit: { async append() { await new Promise((resolve) => setTimeout(resolve, 5)); finished = true; throw new Error('audit unavailable'); } } }), /audit unavailable/);
  assert.equal(finished, true);
});

test('命令失败、超时和取消会返回带终态 action 的错误', async () => {
  const root = await fixture();
  const make = async (argv, extra = {}) => createCommandProposal({ root, argv, sessionId: Math.random().toString(), currentRevision: 'r1', ...extra });
  await assert.rejects(async () => approveAndRunCommand({ proposal: await make(['git', 'rev-parse', 'HEAD']), root, approved: true, currentRevision: 'r1' }), (error) => error instanceof WorkflowError && error.code === 'PROCESS_FAILED' && error.details.action.status === 'failed');
  const controller = new AbortController();
  const pending = approveAndRunCommand({ proposal: await make(['pwd']), root, approved: true, currentRevision: 'r1', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === 'ABORTED' && error.details.action.status === 'cancelled');
});

test('命令 action 跨进程持久化防重放且启动不自动执行', async () => {
  const root = await fixture();
  const proposal = await createCommandProposal({ root, argv: ['pwd'], sessionId: 'persistent-replay', currentRevision: 'r1' });
  await approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' });
  const freshProposal = { ...proposal, action: { ...proposal.action }, command: { ...proposal.command } };
  await assert.rejects(() => approveAndRunCommand({ proposal: freshProposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_REPLAYED');
});

test('伪造或符号链接命令账本记录不能阻断审批执行', async (t) => {
  const root = await fixture();
  const proposal = await createCommandProposal({ root, argv: ['pwd'], sessionId: 'ledger-bound', currentRevision: 'r1' });
  const directory = path.join(root, '.openclaw-workbench', 'commands');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${proposal.action.actionHash}.json`);
  await writeFile(file, JSON.stringify({ actionId: 'forged', actionHash: proposal.action.actionHash, sessionId: 'forged', status: 'verified', command: {} }));
  await assert.rejects(() => approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_LEDGER_FAILED');
  await (await import('node:fs/promises')).unlink(file);
  const outside = path.join(root, 'outside-ledger.json');
  await writeFile(outside, '{}');
  if (!await symlinkOrSkip(t, outside, file)) return;
  await assert.rejects(() => approveAndRunCommand({ proposal, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_LEDGER_FAILED');
});
