import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeToolProposal } from '../runtime/code-tools.mjs';

test('Code 工具编排只生成审批提案，不直接执行', async () => {
  const proposal = await createCodeToolProposal({ mode: 'Code', tool: 'command', root: process.cwd(), input: { sessionId: 'code-session', argv: ['git', 'status'] } });
  assert.equal(proposal.action.status, 'awaiting_approval');
  assert.deepEqual(proposal.command.argv.slice(0, 1), ['git']);
});

test('非 Code 会话和未知工具在编排层直接阻断', async () => {
  await assert.rejects(() => createCodeToolProposal({ mode: 'Plan', tool: 'command', input: { sessionId: 's', argv: ['pwd'] } }), { code: 'MODE_INSUFFICIENT' });
  await assert.rejects(() => createCodeToolProposal({ mode: 'Code', tool: 'terminal', input: { sessionId: 's' } }), { code: 'TOOL_NOT_ALLOWED' });
});
