import { scanStartupRecovery } from './startup-recovery.mjs';

export { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';
export { classifyCommand, COMMAND_CLASSES } from './policy.mjs';
export { runControlledCommand, TerminalError } from './terminal.mjs';
export { claimCommandAction, scanCommandLedger, updateCommandAction } from './command-ledger.mjs';
export { createWorkbenchServer } from './http-server.mjs';
export { CHAT_MODES, SessionError, createChatSessionManager } from './session.mjs';

export async function startWorkbench({ root, audit, onStartupRecoveryAlert, onStartupScanError } = {}) {
  if (!root) throw new Error('root is required');
  let recovery;
  try {
    recovery = await scanStartupRecovery({ root, audit, onError: onStartupRecoveryAlert, onScanError: onStartupScanError });
  } catch (error) {
    return Object.freeze({ recovery: Object.freeze([]), summary: Object.freeze({ scanned: 0, finalized: 0, errors: 1, approvalsRequired: 0, blocked: 0 }), fatalError: Object.freeze({ code: error.code ?? 'STARTUP_FAILED', message: error.message, ...(error.details?.alertError ? { alertError: error.details.alertError } : {}) }) });
  }
  const summary = Object.freeze({
    scanned: recovery.length,
    finalized: recovery.filter((item) => item.finalized).length,
    errors: recovery.filter((item) => item.decision === 'error').length,
    approvalsRequired: recovery.filter((item) => item.decision === 'requires_approval').length,
    blocked: recovery.filter((item) => item.decision === 'blocked').length,
  });
  return Object.freeze({ recovery, summary });
}
