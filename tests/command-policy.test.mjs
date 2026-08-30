import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../runtime/policy.mjs';
import { createCommandProposal, approveAndRunCommand } from '../runtime/workflow.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('命令策略只允许明确列出的只读命令', () => {
  assert.equal(classifyCommand(['git', 'status']).class, 'readonly');
  assert.equal(classifyCommand(['git', 'status', '--porcelain']).class, 'readonly');
  assert.equal(classifyCommand(['node', '--version']).reason, 'not_allowlisted');
  assert.equal(classifyCommand(['python3', '-c', 'print(1)']).reason, 'not_allowlisted');
  assert.equal(classifyCommand(['rm', '-rf', '.']).class, 'blocked');
  assert.equal(classifyCommand(['git', 'push', 'origin', 'main']).reason, 'destructive_git_operation');
  assert.equal(classifyCommand(['git', 'reset', '--hard']).reason, 'destructive_git_operation');
  assert.equal(classifyCommand(['npm', 'publish']).reason, 'package_publish');
  assert.equal(classifyCommand(['node', '--version', '&&']).reason, 'shell_syntax');
  assert.equal(classifyCommand(['/tmp/git', 'status']).reason, 'command_path_not_allowed');
  assert.equal(classifyCommand(['git', 'show', 'HEAD:.env']).reason, 'git_arguments_not_allowlisted');
  assert.equal(classifyCommand(['git', 'diff', '--no-index', '.env', '/etc/passwd']).reason, 'git_arguments_not_allowlisted');
});

test('明确禁止命令在提案阶段即被阻断，不能靠审批绕过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-command-policy-'));
  assert.throws(() => createCommandProposal({ root, argv: ['rm', '-rf', '.'], sessionId: 's' }), (error) => error.code === 'COMMAND_POLICY_DENIED');
  const proposal = createCommandProposal({ root, argv: ['git', 'status'], sessionId: 's', currentRevision: 'r1' });
  const tampered = { ...proposal, command: { ...proposal.command, argv: ['rm', '-rf', '.'] } };
  await assert.rejects(() => approveAndRunCommand({ proposal: tampered, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'COMMAND_POLICY_DENIED');
});

test('提案和审批审计包含策略判定，策略变化时拒绝执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-command-audit-'));
  const audit = { events: [], append(event) { this.events.push(event); } };
  const proposal = createCommandProposal({ root, argv: ['git', 'status'], sessionId: 's', currentRevision: 'r1', audit });
  assert.equal(audit.events[0].policy.class, 'readonly');
  assert.equal(proposal.action.preview.policy.class, 'readonly');
  const altered = { ...proposal, commandPolicy: { class: 'blocked', command: 'git', reason: 'changed' } };
  await assert.rejects(() => approveAndRunCommand({ proposal: altered, root, approved: true, currentRevision: 'r1', audit }), (error) => error.code === 'COMMAND_POLICY_CHANGED');
});

test('命令参数被替换时 action hash 校验拒绝执行', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-command-hash-'));
  const proposal = createCommandProposal({ root, argv: ['git', 'status'], sessionId: 's', currentRevision: 'r1' });
  const altered = { ...proposal, command: { ...proposal.command, timeoutMs: 1 } };
  await assert.rejects(() => approveAndRunCommand({ proposal: altered, root, approved: true, currentRevision: 'r1' }), (error) => error.code === 'ACTION_HASH_MISMATCH');
});
