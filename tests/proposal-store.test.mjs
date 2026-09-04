import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProposalStore, ProposalStoreError } from '../runtime/proposal-store.mjs';
import { symlinkOrSkip } from './test-support.mjs';

function proposal(status = 'awaiting_approval') {
  return { action: { id: 'proposal-1', status, actionHash: 'hash' }, command: { argv: ['node'] } };
}

test('未终态提案重启后进入 manual_review 且不能作为可执行内存提案恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-store-'));
  try {
    createProposalStore({ root }).put(proposal());
    const restored = createProposalStore({ root }).get('proposal-1');
    assert.equal(restored.recovery.state, 'manual_review');
    assert.equal(restored.recovery.reason, 'restarted_before_terminal');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('终态提案重启后仅作为可查看历史保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-terminal-'));
  try {
    const first = createProposalStore({ root });
    first.put(proposal());
    const claim = first.claim('proposal-1', 'hash');
    first.markTerminal('proposal-1', { id: 'proposal-1', status: 'verified', actionHash: 'hash' }, claim.claim.token);
    const restored = createProposalStore({ root }).get('proposal-1');
    assert.equal(restored.proposal.action.status, 'verified');
    assert.equal(restored.recovery, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('提案存储拒绝非法结构和非终态覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-invalid-'));
  try {
    const store = createProposalStore({ root });
    assert.throws(() => store.put({}), ProposalStoreError);
    store.put(proposal());
    assert.throws(() => store.markTerminal('proposal-1', { status: 'executing' }), ProposalStoreError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝重复提案 ID 和伪造恢复标记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-invalid-recovery-'));
  try {
    const storePath = join(root, '.openclaw-workbench', 'proposals.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(storePath, JSON.stringify({ version: 1, proposals: [
      { proposal: proposal(), recovery: { state: 'active', reason: 'skip-review' } },
      { proposal: proposal() },
    ] }));
    assert.throws(() => createProposalStore({ root }), { code: 'PROPOSAL_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝指向工作区外的提案快照符号链接', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-proposal-outside-'));
  try {
    await mkdir(join(root, '.openclaw-workbench'));
    const target = join(outside, 'proposals.json');
    await writeFile(target, JSON.stringify({ version: 1, proposals: [] }));
    if (!await symlinkOrSkip(t, target, join(root, '.openclaw-workbench', 'proposals.json'))) return;
    assert.throws(() => createProposalStore({ root }), { code: 'PROPOSAL_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('提案快照写入遇到已有锁时保守拒绝，不覆盖现有状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-lock-'));
  try {
    const store = createProposalStore({ root });
    await mkdir(`${store.snapshotPath}.lock`, { recursive: true });
    assert.throws(() => store.put(proposal()), { code: 'PROPOSAL_STORE_BUSY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('持久化 claim 只允许一个审批者执行且仅其可完成', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-claim-'));
  try {
    const store = createProposalStore({ root });
    store.put(proposal());
    const claim = store.claim('proposal-1', 'hash');
    assert.equal(store.get('proposal-1').proposal.action.status, 'executing');
    assert.throws(() => store.claim('proposal-1', 'hash'), { code: 'PROPOSAL_BUSY' });
    assert.throws(() => store.markTerminal('proposal-1', { id: 'proposal-1', status: 'verified', actionHash: 'hash' }, '00000000-0000-0000-0000-000000000000'), { code: 'CLAIM_MISMATCH' });
    store.markTerminal('proposal-1', { id: 'proposal-1', status: 'verified', actionHash: 'hash' }, claim.claim.token);
    assert.equal(store.get('proposal-1').proposal.action.status, 'verified');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('执行中的提案重启后进入 manual_review 且不重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-claim-restart-'));
  try {
    const first = createProposalStore({ root });
    first.put(proposal());
    first.claim('proposal-1', 'hash');
    const restored = createProposalStore({ root }).get('proposal-1');
    assert.equal(restored.recovery.state, 'manual_review');
    assert.equal(restored.proposal.action.status, 'manual_review');
    assert.equal(createProposalStore({ root }).recoverySummary().executing, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revision mismatch 和 ledger/audit 前置失败均持久化为不可执行 manual_review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-manual-review-'));
  try {
    const store = createProposalStore({ root }); store.put(proposal());
    const claim = store.claim('proposal-1', 'hash');
    store.markManualReview('proposal-1', claim.claim.token, new ProposalStoreError('LEDGER_PRECONDITION_FAILED', 'ledger/audit rejected revision mismatch'));
    const record = createProposalStore({ root }).get('proposal-1');
    assert.equal(record.proposal.action.status, 'manual_review');
    assert.equal(record.claim.actionHash, 'hash');
    assert.equal(record.recovery.error.code, 'LEDGER_PRECONDITION_FAILED');
    assert.throws(() => createProposalStore({ root }).claim('proposal-1', 'hash'), { code: 'PROPOSAL_MANUAL_REVIEW' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('两个提案 store 基于不同快照版本写入时拒绝后写者覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-proposal-conflict-'));
  try {
    const first = createProposalStore({ root });
    const stale = createProposalStore({ root });
    first.put(proposal());
    assert.throws(() => stale.put({ action: { id: 'proposal-2', status: 'awaiting_approval', actionHash: 'hash-2' } }), { code: 'PROPOSAL_STORE_CONFLICT' });
    assert.equal(stale.get('proposal-2'), null);
    assert.equal(createProposalStore({ root }).get('proposal-1').proposal.action.id, 'proposal-1');
  } finally { await rm(root, { recursive: true, force: true }); }
});
