import { createPatchProposal, createCommandProposal, WorkflowError } from './workflow.mjs';
import { createWorkspace } from './workspace.mjs';

export const CODE_TOOLS = Object.freeze(['patch', 'command']);

export async function createCodeToolProposal({ mode, tool, input, root, audit } = {}) {
  if (mode !== 'Code') throw new WorkflowError('MODE_INSUFFICIENT', 'Code tools require a Code session');
  if (!CODE_TOOLS.includes(tool)) throw new WorkflowError('TOOL_NOT_ALLOWED', `tool must be one of ${CODE_TOOLS.join(', ')}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkflowError('INVALID_TOOL_INPUT', 'tool input must be an object');
  const sessionId = input.sessionId;
  if (!sessionId) throw new WorkflowError('SESSION_REQUIRED', 'sessionId is required');
  const workspace = await createWorkspace(root);
  const currentRevision = await workspace.workspaceRevision();
  if (tool === 'patch') return createPatchProposal({ ...input, root, audit, mode: 'Code', currentRevision });
  return createCommandProposal({ ...input, root, audit, mode: 'Terminal', currentRevision });
}
