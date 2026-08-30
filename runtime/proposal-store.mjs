import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

const TERMINAL = new Set(['verified', 'failed', 'timed_out', 'cancelled']);

export class ProposalStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'ProposalStoreError'; this.code = code; }
}

function validProposal(proposal) {
  return proposal && typeof proposal === 'object' && proposal.action && typeof proposal.action.id === 'string' && typeof proposal.action.status === 'string';
}

function publicRecord(record) {
  return Object.freeze({ proposal: record.proposal, recovery: record.recovery });
}

export function createProposalStore({ root, storePath = join(root ?? '', '.openclaw-workbench', 'proposals.json') } = {}) {
  if (!root) throw new ProposalStoreError('ROOT_REQUIRED', 'root is required');
  const records = new Map();
  let persistedDigest = null;
  function persist() {
    persistedDigest = writeSnapshotAtomically({ root, storePath, payload: JSON.stringify({ version: 1, proposals: [...records.values()] }), expectedDigest: persistedDigest, ErrorType: ProposalStoreError, code: 'PROPOSAL_STORE_INVALID', message: 'proposal snapshot is invalid; refusing recovery', busyCode: 'PROPOSAL_STORE_BUSY', busyMessage: 'proposal snapshot write is already in progress', conflictCode: 'PROPOSAL_STORE_CONFLICT', conflictMessage: 'proposal snapshot changed outside this manager; refusing overwrite', temporaryName: randomUUID() });
  }
  function restore() {
    try {
      const stored = readSnapshot({ root, storePath, ErrorType: ProposalStoreError, code: 'PROPOSAL_STORE_INVALID', message: 'proposal snapshot is invalid; refusing recovery' });
      if (stored.content === null) return;
      persistedDigest = stored.digest;
      const snapshot = JSON.parse(stored.content);
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.proposals)) throw new Error('unsupported proposal snapshot');
      const ids = new Set();
      for (const record of snapshot.proposals) {
        if (!record || !validProposal(record.proposal) || ids.has(record.proposal.action.id)) throw new Error('invalid proposal snapshot');
        const action = record.proposal.action;
        ids.add(action.id);
        if (record.recovery && (record.recovery.state !== 'manual_review' || record.recovery.reason !== 'restarted_before_terminal')) throw new Error('invalid proposal recovery');
        const recovery = TERMINAL.has(action.status) ? undefined : { state: 'manual_review', reason: 'restarted_before_terminal' };
        records.set(action.id, Object.freeze({ proposal: record.proposal, ...(recovery ? { recovery } : {}) }));
      }
    } catch (error) {
      throw new ProposalStoreError('PROPOSAL_STORE_INVALID', 'proposal snapshot is invalid; refusing recovery');
    }
  }
  restore();
  function put(proposal) {
    if (!validProposal(proposal)) throw new ProposalStoreError('INVALID_PROPOSAL', 'proposal action is required');
    const previous = records.get(proposal.action.id);
    records.set(proposal.action.id, Object.freeze({ proposal }));
    try { persist(); } catch (error) { if (previous) records.set(proposal.action.id, previous); else records.delete(proposal.action.id); throw error; }
    return publicRecord(records.get(proposal.action.id));
  }
  function markTerminal(id, action) {
    const record = records.get(id);
    if (!record) throw new ProposalStoreError('PROPOSAL_NOT_FOUND', 'proposal not found');
    if (!TERMINAL.has(action?.status)) throw new ProposalStoreError('INVALID_TERMINAL_ACTION', 'action must be terminal');
    const proposal = Object.freeze({ ...record.proposal, action });
    records.set(id, Object.freeze({ proposal }));
    try { persist(); } catch (error) { records.set(id, record); throw error; }
    return publicRecord(records.get(id));
  }
  function get(id) { return records.has(id) ? publicRecord(records.get(id)) : null; }
  function recoverySummary() {
    const values = [...records.values()];
    return Object.freeze({ total: values.length, manualReview: values.filter((record) => record.recovery?.state === 'manual_review').length, terminal: values.filter((record) => TERMINAL.has(record.proposal.action.status)).length });
  }
  return Object.freeze({ put, markTerminal, get, recoverySummary, snapshotPath: storePath });
}
