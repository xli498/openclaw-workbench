import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { approveAndApplyPatch, createPatchProposal, WorkflowError } from '../runtime/workflow.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-workflow-'));
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  return root;
}

const patch = `--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n`;

test('Patch 提案绑定 revision 和 action hash，未审批不能应用', async () => {
  const root = await fixture();
  const proposal = await createPatchProposal({ root, patch, sessionId: 'session-1', declaredPaths: ['a.txt'], mode: 'Code', currentRevision: 'r1' });
  assert.equal(proposal.action.status, 'awaiting_approval');
  assert.equal(typeof proposal.action.actionHash, 'string');
  await assert.rejects(() => approveAndApplyPatch({ proposal, root, declaredPaths: ['a.txt'], currentRevision: 'r1' }), (error) => error instanceof WorkflowError && error.code === 'APPROVAL_REQUIRED');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
});

test('明确审批后完成 Patch 应用并返回 verified action', async () => {
  const root = await fixture();
  const events = [];
  const audit = { async append(event) { events.push(event); } };
  const proposal = await createPatchProposal({ root, patch, sessionId: 'session-2', declaredPaths: ['a.txt'], currentRevision: 'r1', audit });
  const result = await approveAndApplyPatch({ proposal, root, declaredPaths: ['a.txt'], approved: true, currentRevision: 'r1', audit });
  assert.equal(result.action.status, 'verified');
  assert.equal(result.transaction.files[0].relativePath, 'a.txt');
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n');
  assert.deepEqual(events.map((event) => event.type), ['action.proposed', 'action.approved', 'transaction.prepared', 'transaction.committing', 'transaction.committed', 'action.verified']);
});

test('审批后 revision 变化时拒绝应用', async () => {
  const root = await fixture();
  const proposal = await createPatchProposal({ root, patch, sessionId: 'session-3', declaredPaths: ['a.txt'], currentRevision: 'r1' });
  await assert.rejects(() => approveAndApplyPatch({ proposal, root, declaredPaths: ['a.txt'], approved: true, currentRevision: 'r2' }), (error) => error instanceof WorkflowError && error.code === 'REVISION_MISMATCH');
});

test('Ask 模式不能创建修改提案', async () => {
  const root = await fixture();
  await assert.rejects(() => createPatchProposal({ root, patch, sessionId: 'session-4', declaredPaths: ['a.txt'], mode: 'Ask', currentRevision: 'r1' }), (error) => error.code === 'MODE_INSUFFICIENT');
});
