import { scanStartupRecovery } from './startup-recovery.mjs';

export { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';
export { classifyCommand, COMMAND_CLASSES } from './policy.mjs';
export { runControlledCommand, TerminalError } from './terminal.mjs';
export { claimCommandAction, scanCommandLedger, updateCommandAction } from './command-ledger.mjs';
export { createWorkbenchServer } from './http-server.mjs';
export { CHAT_MODES, SessionError, createChatSessionManager } from './session.mjs';
export { PlanError, runPlanReview, runPlanDebate } from './plan.mjs';
export { CODE_TOOLS, createCodeToolProposal } from './code-tools.mjs';
export { EventBusError, createEventBus } from './event-bus.mjs';
export { ProposalStoreError, createProposalStore } from './proposal-store.mjs';
export { inspectOpenClaw } from './openclaw-adapter.mjs';
export { ConfigError, readConfig, importConfig, rollbackConfig, validateBackupId } from './config-store.mjs';
export { McpRegistryError, createMcpRegistry, normalizeMcpServer } from './mcp-registry.mjs';
export { ModelRegistryError, createModelRegistry, normalizeModelProfile } from './model-registry.mjs';
export { GatewayAdapterError, createGatewayAdapter } from './gateway-adapter.mjs';
export { McpTransportError, createMcpStdioTransport } from './mcp-transport.mjs';
export { McpHttpTransportError, createMcpHttpTransport } from './mcp-http-transport.mjs';
export { McpRuntimeError, createMcpServerRuntime } from './mcp-runtime.mjs';

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
