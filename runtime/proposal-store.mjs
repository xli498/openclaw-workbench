import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  function persist() {
    mkdirSync(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, proposals: [...records.values()] }), { mode: 0o600 });
    renameSync(temporary, storePath);
  }
  function restore() {
    try {
      const snapshot = JSON.parse(readFileSync(storePath, 'utf8'));
      if (snapshot?.version !== 1 || !Array.isArray(snapshot.proposals)) throw new Error('unsupported proposal snapshot');
      for (const record of snapshot.proposals) {
        if (!record || !validProposal(record.proposal)) throw new Error('invalid proposal snapshot');
        const action = record.proposal.action;
        const recovery = TERMINAL.has(action.status) ? record.recovery : { state: 'manual_review', reason: 'restarted_before_terminal' };
        records.set(action.id, Object.freeze({ proposal: record.proposal, ...(recovery ? { recovery } : {}) }));
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new ProposalStoreError('PROPOSAL_STORE_INVALID', 'proposal snapshot is invalid; refusing recovery');
    }
  }
  restore();
  function put(proposal) {
    if (!validProposal(proposal)) throw new ProposalStoreError('INVALID_PROPOSAL', 'proposal action is required');
    records.set(proposal.action.id, Object.freeze({ proposal }));
    persist();
    return publicRecord(records.get(proposal.action.id));
  }
  function markTerminal(id, action) {
    const record = records.get(id);
    if (!record) throw new ProposalStoreError('PROPOSAL_NOT_FOUND', 'proposal not found');
    if (!TERMINAL.has(action?.status)) throw new ProposalStoreError('INVALID_TERMINAL_ACTION', 'action must be terminal');
    const proposal = Object.freeze({ ...record.proposal, action });
    records.set(id, Object.freeze({ proposal }));
    persist();
    return publicRecord(records.get(id));
  }
  function get(id) { return records.has(id) ? publicRecord(records.get(id)) : null; }
  return Object.freeze({ put, markTerminal, get, snapshotPath: storePath });
}
