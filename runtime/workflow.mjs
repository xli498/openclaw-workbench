import { createWorkspace } from './workspace.mjs';
import { parseUnifiedPatch, validatePatchTargets } from './patch-engine.mjs';
import { classifyCommand, decide } from './policy.mjs';
import { actionHash, createAction, transition } from './action.mjs';
import { applyPatchTransaction, TransactionError } from './change-transaction.mjs';
import { runControlledCommand, validateCommandLimits } from './terminal.mjs';
import { claimCommandAction, updateCommandAction } from './command-ledger.mjs';

export class WorkflowError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'WorkflowError'; this.code = code; this.details = details; }
}

function revisionForAction(revision) {
  return revision ?? 'working-tree';
}

export async function createPatchProposal({ root, patch, sessionId, declaredPaths, mode = 'Code', expectedRevision, currentRevision, audit } = {}) {
  if (!sessionId) throw new WorkflowError('SESSION_REQUIRED', 'sessionId is required');
  const policy = decide({ mode, actionType: 'patch' });
  if (policy.reason === 'mode_insufficient') throw new WorkflowError('MODE_INSUFFICIENT', 'current mode cannot create a patch proposal');
  const parsedPatch = parseUnifiedPatch(patch);
  validatePatchTargets(parsedPatch, declaredPaths);
  const workspace = await createWorkspace(root);
  const actualRevision = revisionForAction(currentRevision ?? await workspace.gitRevision());
  if (expectedRevision !== undefined && actualRevision !== expectedRevision) throw new WorkflowError('REVISION_MISMATCH', 'workspace changed before proposal');
  const immutable = { type: 'patch', sessionId, workspaceRevision: actualRevision, target: parsedPatch.paths, preview: patch, risk: 'medium' };
  const action = createAction(immutable);
  const inspected = transition(action, 'inspected');
  const awaitingApproval = transition(inspected, 'awaiting_approval');
  if (audit) await audit.append({ type: 'action.proposed', actor: 'user', actionId: awaitingApproval.id, sessionId, actionHash: awaitingApproval.actionHash, files: parsedPatch.paths });
  return Object.freeze({ action: awaitingApproval, parsedPatch, workspaceRevision: actualRevision, policy });
}

export async function approveAndApplyPatch({ proposal, root, declaredPaths, approved = false, audit, getCurrentRevision, currentRevision, snapshotDir, transactionDir, renameFile } = {}) {
  if (!proposal?.action || !proposal?.parsedPatch) throw new WorkflowError('PROPOSAL_INVALID', 'patch proposal is required');
  if (!approved) throw new WorkflowError('APPROVAL_REQUIRED', 'patch application requires explicit approval');
  const action = proposal.action;
  const current = revisionForAction(currentRevision ?? (getCurrentRevision ? await getCurrentRevision() : proposal.workspaceRevision));
  if (current !== action.workspaceRevision) throw new WorkflowError('REVISION_MISMATCH', 'workspace changed after approval');
  const approvedAction = transition(action, 'approved', { expectedHash: actionHash({ type: action.type, sessionId: action.sessionId, workspaceRevision: action.workspaceRevision, target: action.target, preview: action.preview, risk: action.risk },) });
  if (audit) await audit.append({ type: 'action.approved', actor: 'user', actionId: approvedAction.id, sessionId: approvedAction.sessionId, actionHash: approvedAction.actionHash });
  const executing = transition(approvedAction, 'executing');
  let result;
  try {
    result = await applyPatchTransaction({ root, parsedPatch: proposal.parsedPatch, declaredPaths, expectedRevision: action.workspaceRevision, currentRevision: current, getCurrentRevision, snapshotDir, transactionDir, audit, renameFile });
  } catch (error) {
    if (audit) await audit.append({ type: 'action.failed', actor: 'system', actionId: action.id, code: error.code ?? 'PATCH_APPLY_FAILED' });
    throw new WorkflowError(error.code ?? 'PATCH_APPLY_FAILED', error.message, { cause: error, action: executing });
  }
  const verified = transition(executing, 'verified');
  if (audit) await audit.append({ type: 'action.verified', actor: 'system', actionId: verified.id, transactionId: result.transactionId });
  return Object.freeze({ action: verified, transaction: result });
}

export function createCommandProposal({ root, argv, sessionId, mode = 'Terminal', cwd = '.', timeoutMs, maxOutputBytes, currentRevision = 'working-tree', audit } = {}) {
  if (!sessionId) throw new WorkflowError('SESSION_REQUIRED', 'sessionId is required');
  const policy = decide({ mode, actionType: 'command' });
  if (policy.reason === 'mode_insufficient') throw new WorkflowError('MODE_INSUFFICIENT', 'current mode cannot create a command proposal');
  try { validateCommandLimits({ argv, timeoutMs, maxOutputBytes }); } catch (error) { throw new WorkflowError(error.code, error.message, error.details); }
  const commandPolicy = classifyCommand(argv);
  if (commandPolicy.class === 'blocked') throw new WorkflowError('COMMAND_POLICY_DENIED', `command is blocked by policy: ${commandPolicy.command ?? 'invalid'}`, { commandPolicy });
  const preview = Object.freeze({ argv: [...argv], cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) });
  const actionPreview = Object.freeze({ ...preview, policy: commandPolicy });
  const action = transition(transition(createAction({ type: 'command', sessionId, workspaceRevision: revisionForAction(currentRevision), target: cwd, preview: actionPreview, risk: 'high' }), 'inspected'), 'awaiting_approval');
  if (audit) audit.append({ type: 'command.proposed', actor: 'user', actionId: action.id, sessionId, actionHash: action.actionHash, preview, policy: commandPolicy });
  return Object.freeze({ action, command: preview, workspaceRevision: revisionForAction(currentRevision), policy, commandPolicy, root });
}

export async function approveAndRunCommand({ proposal, root = proposal?.root, approved = false, audit, currentRevision = proposal?.workspaceRevision, signal } = {}) {
  if (!proposal?.action || !proposal?.command) throw new WorkflowError('PROPOSAL_INVALID', 'command proposal is required');
  if (!approved) throw new WorkflowError('APPROVAL_REQUIRED', 'terminal execution requires explicit approval');
  const action = proposal.action;
  try { validateCommandLimits(proposal.command); } catch (error) { throw new WorkflowError(error.code, error.message, error.details); }
  if (revisionForAction(currentRevision) !== action.workspaceRevision) throw new WorkflowError('REVISION_MISMATCH', 'workspace changed after approval');
  const commandPolicy = classifyCommand(proposal.command.argv);
  if (commandPolicy.class === 'blocked') throw new WorkflowError('COMMAND_POLICY_DENIED', `command is blocked by policy: ${commandPolicy.command ?? 'invalid'}`, { commandPolicy });
  if (proposal.commandPolicy && JSON.stringify(proposal.commandPolicy) !== JSON.stringify(commandPolicy)) throw new WorkflowError('COMMAND_POLICY_CHANGED', 'command policy changed after proposal', { proposed: proposal.commandPolicy, current: commandPolicy });
  if (action.preview?.policy && JSON.stringify(action.preview.policy) !== JSON.stringify(commandPolicy)) throw new WorkflowError('COMMAND_POLICY_CHANGED', 'action policy binding does not match command', { proposed: action.preview.policy, current: commandPolicy });
  const expectedPreview = Object.freeze({ ...proposal.command, policy: commandPolicy });
  const expectedActionHash = actionHash({ type: action.type, sessionId: action.sessionId, workspaceRevision: action.workspaceRevision, target: action.target, preview: expectedPreview, risk: action.risk });
  if (expectedActionHash !== action.actionHash) throw new WorkflowError('ACTION_HASH_MISMATCH', 'command proposal was modified after approval', { expectedHash: expectedActionHash, actualHash: action.actionHash });
  try {
    const claim = await claimCommandAction({ root, action });
    if (!claim.claimed) throw new WorkflowError('COMMAND_REPLAYED', 'command action has already been consumed', { record: claim.record });
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('COMMAND_LEDGER_FAILED', error.message, { cause: error });
  }
  const approvedAction = transition(action, 'approved', { expectedHash: expectedActionHash, currentWorkspaceRevision: action.workspaceRevision });
  if (audit) await audit.append({ type: 'command.approved', actor: 'user', actionId: approvedAction.id, sessionId: approvedAction.sessionId, actionHash: approvedAction.actionHash, policy: commandPolicy });
  const executing = transition(approvedAction, 'executing');
  await updateCommandAction({ root, actionHash: action.actionHash, status: 'executing' });
  try {
    const result = await runControlledCommand({ root, ...proposal.command, approved: true, signal });
    const verified = transition(executing, 'verified');
    await updateCommandAction({ root, actionHash: action.actionHash, status: 'verified', result: { code: result.code, cwd: result.cwd } });
    if (audit) await audit.append({ type: 'command.verified', actor: 'system', actionId: verified.id });
    return Object.freeze({ action: verified, result });
  } catch (error) {
    const terminalStatus = error.code === 'TIMEOUT' ? 'timed_out' : error.code === 'ABORTED' ? 'cancelled' : 'failed';
    const failed = transition(executing, terminalStatus);
    await updateCommandAction({ root, actionHash: action.actionHash, status: terminalStatus, error: { code: error.code, message: error.message } });
    if (audit) await audit.append({ type: 'command.failed', actor: 'system', actionId: failed.id, code: error.code });
    throw new WorkflowError(error.code ?? 'COMMAND_FAILED', error.message, { cause: error, action: failed });
  }
}

export { actionHash };
