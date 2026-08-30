import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

const TERMINAL = new Set(['verified', 'failed', 'timed_out', 'cancelled']);
const MANUAL_REVIEW = 'manual_review';

export class ProposalStoreError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ProposalStoreError'; this.code = code; this.details = details; }
}

function validProposal(proposal) {
  return proposal && typeof proposal === 'object' && proposal.action && typeof proposal.action.id === 'string' && typeof proposal.action.status === 'string' && typeof proposal.action.actionHash === 'string';
}

function validClaim(claim) {
  return claim && typeof claim === 'object' && typeof claim.token === 'string' && /^[0-9a-f-]{36}$/.test(claim.token) && Number.isSafeInteger(claim.startedAt) && typeof claim.actionHash === 'string';
}

function publicRecord(record) {
  return Object.freeze({ proposal: record.proposal, ...(record.claim ? { claim: { startedAt: record.claim.startedAt, actionHash: record.claim.actionHash } } : {}), ...(record.recovery ? { recovery: record.recovery } : {}) });
}

export function createProposalStore({ root, storePath = join(root ?? '', '.openclaw-workbench', 'proposals.json'), clock = () => Date.now() } = {}) {
  if (!root) throw new ProposalStoreError('ROOT_REQUIRED', 'root is required');
  const records = new Map();
  let persistedDigest = null;
  function persist() {
    persistedDigest = writeSnapshotAtomically({ root, storePath, payload: JSON.stringify({ version: 2, proposals: [...records.values()] }), expectedDigest: persistedDigest, ErrorType: ProposalStoreError, code: 'PROPOSAL_STORE_INVALID', message: 'proposal snapshot is invalid; refusing recovery', busyCode: 'PROPOSAL_STORE_BUSY', busyMessage: 'proposal snapshot write is already in progress', conflictCode: 'PROPOSAL_STORE_CONFLICT', conflictMessage: 'proposal snapshot changed outside this manager; refusing overwrite', temporaryName: randomUUID() });
  }
  function restore() {
    try {
      const stored = readSnapshot({ root, storePath, ErrorType: ProposalStoreError, code: 'PROPOSAL_STORE_INVALID', message: 'proposal snapshot is invalid; refusing recovery' });
      if (stored.content === null) return;
      persistedDigest = stored.digest;
      const snapshot = JSON.parse(stored.content);
      if (!snapshot || ![1, 2].includes(snapshot.version) || !Array.isArray(snapshot.proposals)) throw new Error('unsupported proposal snapshot');
      const ids = new Set();
      for (const record of snapshot.proposals) {
        if (!record || !validProposal(record.proposal) || ids.has(record.proposal.action.id)) throw new Error('invalid proposal snapshot');
        const action = record.proposal.action;
        ids.add(action.id);
        if (record.claim && !validClaim(record.claim)) throw new Error('invalid proposal claim');
        if (record.recovery && (record.recovery.state !== 'manual_review' || !['restarted_before_terminal', 'approval_precondition_failed'].includes(record.recovery.reason))) throw new Error('invalid proposal recovery');
        const recovery = TERMINAL.has(action.status) ? undefined : (record.recovery ?? { state: MANUAL_REVIEW, reason: 'restarted_before_terminal' });
        const proposal = recovery
          ? Object.freeze({ ...record.proposal, action: Object.freeze({ ...action, status: MANUAL_REVIEW }) })
          : record.proposal;
        records.set(action.id, Object.freeze({ proposal, ...(record.claim ? { claim: record.claim } : {}), ...(recovery ? { recovery } : {}) }));
      }
    } catch (error) {
      throw new ProposalStoreError('PROPOSAL_STORE_INVALID', 'proposal snapshot is invalid; refusing recovery');
    }
  }
  restore();
  function replace(id, next) {
    const previous = records.get(id);
    records.set(id, Object.freeze(next));
    try { persist(); } catch (error) { if (previous) records.set(id, previous); else records.delete(id); throw error; }
    return records.get(id);
  }
  function put(proposal) {
    if (!validProposal(proposal)) throw new ProposalStoreError('INVALID_PROPOSAL', 'proposal action is required');
    replace(proposal.action.id, { proposal });
    return publicRecord(records.get(proposal.action.id));
  }
  function claim(id, actionHash) {
    const record = records.get(id);
    if (!record) throw new ProposalStoreError('PROPOSAL_NOT_FOUND', 'proposal not found');
    if (record.proposal.action.status === MANUAL_REVIEW || record.recovery?.state === MANUAL_REVIEW) throw new ProposalStoreError('PROPOSAL_MANUAL_REVIEW', 'proposal was interrupted by restart; create a fresh proposal after review');
    if (record.proposal.action.actionHash !== actionHash) throw new ProposalStoreError('ACTION_HASH_MISMATCH', 'approval must bind the current action hash');
    if (record.proposal.action.status !== 'awaiting_approval' || record.claim) throw new ProposalStoreError('PROPOSAL_BUSY', 'proposal approval is already executing');
    const claim = Object.freeze({ token: randomUUID(), actionHash, startedAt: clock() });
    const proposal = Object.freeze({ ...record.proposal, action: Object.freeze({ ...record.proposal.action, status: 'executing' }) });
    replace(id, { proposal, claim });
    return Object.freeze({ proposal: record.proposal, claim: Object.freeze({ ...claim }) });
  }
  function markTerminal(id, action, claimToken) {
    const record = records.get(id);
    if (!record) throw new ProposalStoreError('PROPOSAL_NOT_FOUND', 'proposal not found');
    if (!TERMINAL.has(action?.status)) throw new ProposalStoreError('INVALID_TERMINAL_ACTION', 'action must be terminal');
    if (!record.claim || record.claim.token !== claimToken || record.claim.actionHash !== action.actionHash || record.proposal.action.status !== 'executing') throw new ProposalStoreError('CLAIM_MISMATCH', 'only the active approval claim may complete this proposal');
    const proposal = Object.freeze({ ...record.proposal, action: Object.freeze({ ...action }) });
    replace(id, { proposal });
    return publicRecord(records.get(id));
  }
  function markManualReview(id, claimToken, error) {
    const record = records.get(id);
    if (!record) throw new ProposalStoreError('PROPOSAL_NOT_FOUND', 'proposal not found');
    if (!record.claim || record.claim.token !== claimToken || record.proposal.action.status !== 'executing') throw new ProposalStoreError('CLAIM_MISMATCH', 'only the active approval claim may update this proposal');
    const recovery = Object.freeze({ state: MANUAL_REVIEW, reason: 'approval_precondition_failed', error: Object.freeze({ code: error?.code ?? 'APPROVAL_FAILED', message: String(error?.message ?? 'approval precondition failed').slice(0, 512) }) });
    const proposal = Object.freeze({ ...record.proposal, action: Object.freeze({ ...record.proposal.action, status: MANUAL_REVIEW }) });
    replace(id, { proposal, claim: record.claim, recovery });
    return publicRecord(records.get(id));
  }
  function get(id) { return records.has(id) ? publicRecord(records.get(id)) : null; }
  function recoverySummary() {
    const values = [...records.values()];
    return Object.freeze({ total: values.length, manualReview: values.filter((record) => record.proposal.action.status === MANUAL_REVIEW).length, executing: values.filter((record) => record.proposal.action.status === 'executing').length, terminal: values.filter((record) => TERMINAL.has(record.proposal.action.status)).length });
  }
  return Object.freeze({ put, claim, markTerminal, markManualReview, get, recoverySummary, snapshotPath: storePath });
}
