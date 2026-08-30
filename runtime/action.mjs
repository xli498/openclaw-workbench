import { createHash, randomUUID } from 'node:crypto';

const TERMINAL = new Set(['denied', 'cancelled', 'timed_out', 'failed', 'verified', 'rolled_back']);
const TRANSITIONS = Object.freeze({
  proposed: new Set(['inspected', 'denied']),
  inspected: new Set(['awaiting_approval', 'denied']),
  awaiting_approval: new Set(['approved', 'denied']),
  approved: new Set(['executing', 'denied']),
  executing: new Set(['verified', 'cancelled', 'timed_out', 'failed']),
  verified: new Set(['rolled_back']),
  failed: new Set(['rolled_back']),
});

export function actionHash(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createAction({ type, sessionId, workspaceRevision, target, preview, risk = 'medium', now = new Date() }) {
  if (!type || !sessionId || !workspaceRevision) throw new Error('type, sessionId and workspaceRevision are required');
  const immutable = { type, sessionId, workspaceRevision, target, preview, risk };
  return { id: randomUUID(), ...immutable, actionHash: actionHash(immutable), status: 'proposed', createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

export function assertWorkspaceRevision(action, currentWorkspaceRevision) {
  if (action.workspaceRevision !== currentWorkspaceRevision) throw new Error('workspace_revision_mismatch');
  return true;
}

export function transition(action, nextStatus, { now = new Date(), expectedHash, currentWorkspaceRevision } = {}) {
  if (expectedHash && expectedHash !== action.actionHash) throw new Error('action_hash_mismatch');
  if (currentWorkspaceRevision !== undefined) assertWorkspaceRevision(action, currentWorkspaceRevision);
  if (TERMINAL.has(action.status)) throw new Error(`action_terminal:${action.status}`);
  if (!TRANSITIONS[action.status]?.has(nextStatus)) throw new Error(`invalid_transition:${action.status}->${nextStatus}`);
  return { ...action, status: nextStatus, updatedAt: now.toISOString() };
}
