import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { startWorkbench } from './index.mjs';
import { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';
import { createChatSessionManager, SessionError } from './session.mjs';
import { createCodeToolProposal } from './code-tools.mjs';
import { createEventBus, EventBusError } from './event-bus.mjs';
import { createProposalStore, ProposalStoreError } from './proposal-store.mjs';
import { createWorkspace } from './workspace.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function requestIdOf(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

function decimalIntegerOf(value, fallback, field) {
  if (value === null) return fallback;
  if (!DECIMAL_INTEGER_PATTERN.test(value)) {
    const error = new Error(`${field} must be a decimal integer`);
    error.code = 'INVALID_QUERY_INTEGER';
    throw error;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    const error = new Error(`${field} must be a safe integer`);
    error.code = 'INVALID_QUERY_INTEGER';
    throw error;
  }
  return parsed;
}

function singleQueryInteger(searchParams, field, fallback) {
  const values = searchParams.getAll(field);
  if (values.length > 1) {
    const error = new Error(`${field} must not be repeated`);
    error.code = 'DUPLICATE_QUERY_PARAMETER';
    throw error;
  }
  return decimalIntegerOf(values[0] ?? null, fallback, field);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { const error = new Error('request body too large'); error.code = 'BODY_TOO_LARGE'; throw error; }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('request body must be valid JSON'); error.code = 'INVALID_JSON'; throw error; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('request body must be a JSON object');
    error.code = 'INVALID_BODY';
    throw error;
  }
  return body;
}

function errorResponse(error) {
  if (error instanceof WorkflowError) return { status: error.code === 'APPROVAL_REQUIRED' ? 403 : 400, body: { error: error.code, message: error.message, details: error.details } };
  if (error instanceof SessionError) return { status: error.code === 'SESSION_NOT_FOUND' ? 404 : error.code === 'SESSION_BUSY' ? 409 : 400, body: { error: error.code, message: error.message, details: error.details } };
  if (error?.name === 'PlanError') return { status: error.code === 'PLAN_FAILED' ? 502 : 400, body: { error: error.code, message: error.message, details: error.details } };
  if (error instanceof EventBusError) return { status: 400, body: { error: error.code, message: error.message } };
  if (error instanceof ProposalStoreError) return { status: error.code === 'PROPOSAL_NOT_FOUND' ? 404 : 400, body: { error: error.code, message: error.message } };
  return { status: error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'INVALID_JSON' || error.code === 'INVALID_BODY' || error.code === 'INVALID_QUERY_INTEGER' || error.code === 'DUPLICATE_QUERY_PARAMETER' ? 400 : 500, body: { error: error.code ?? 'INTERNAL_ERROR', message: error.message } };
}

function requireToken(request, token) {
  if (typeof token !== 'string' || token.length < 16) return false;
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const received = createHash('sha256').update(request.headers.authorization ?? '').digest();
  return timingSafeEqual(expected, received);
}

function requireApprovalToken(request, token) {
  if (typeof token !== 'string' || token.length < 16) return false;
  const expected = createHash('sha256').update(token).digest();
  const received = createHash('sha256').update(request.headers['x-approval-token'] ?? '').digest();
  return timingSafeEqual(expected, received);
}

function publicProposal(proposal) {
  return { action: proposal.action, command: proposal.command, parsedPatch: proposal.parsedPatch, workspaceRevision: proposal.workspaceRevision, policy: proposal.policy, commandPolicy: proposal.commandPolicy };
}

export function createWorkbenchServer({ root, audit, token, approvalToken, host = '127.0.0.1', port = 0, runAgentFn, eventBus = createEventBus({ root }) } = {}) {
  if (!root) throw new Error('root is required');
  if (typeof token !== 'string' || token.length < 16) throw new Error('token must be at least 16 characters');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('host must be loopback');
  const proposals = new Map();
  const proposalStore = createProposalStore({ root });
  const sessions = createChatSessionManager({ root, runAgentFn });
  const startupState = startWorkbench({ root, audit });
  const currentWorkspaceRevision = async () => (await createWorkspace(root)).workspaceRevision();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    const requestId = requestIdOf(request.headers['x-request-id']);
    response.setHeader('x-request-id', requestId);
    try {
      if (!requireToken(request, token)) return json(response, 401, { error: 'UNAUTHORIZED', message: 'bearer token required' });
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'openclaw-workbench' });
      await startupState;
      if (request.method === 'GET' && url.pathname === '/v1/events') return json(response, 200, eventBus.list({ after: singleQueryInteger(url.searchParams, 'after', 0), limit: singleQueryInteger(url.searchParams, 'limit', 100) }));
      if (request.method === 'GET' && url.pathname === '/v1/status') return json(response, 200, { ...(await startupState), root, persistedState: { sessions: sessions.recoverySummary(), proposals: proposalStore.recoverySummary(), events: { recovered: eventBus.recovered, latestSequence: eventBus.list({ after: 0, limit: 1 }).latestSequence } } });
      if (request.method === 'POST' && url.pathname === '/v1/sessions') { const session = sessions.createSession(await bodyOf(request)); eventBus.publish({ type: 'session.created', sessionId: session.id, requestId, data: { mode: session.mode } }); return json(response, 201, { session }); }
      const sessionMessages = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && sessionMessages) return json(response, 200, { messages: sessions.listMessages(sessionMessages[1]) });
      if (request.method === 'POST' && sessionMessages) { const result = await sessions.sendMessage({ sessionId: sessionMessages[1], ...await bodyOf(request) }); eventBus.publish({ type: 'chat.completed', sessionId: sessionMessages[1], requestId, data: { messageCount: result.session.messageCount } }); return json(response, 200, result); }
      const sessionPlan = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/plan$/);
      if (request.method === 'POST' && sessionPlan) { const result = await sessions.planReview({ sessionId: sessionPlan[1], ...await bodyOf(request) }); eventBus.publish({ type: 'plan.completed', sessionId: sessionPlan[1], requestId, data: { agreement: result.synthesis.agreement, requiresHumanReview: result.synthesis.requiresHumanReview } }); return json(response, 200, result); }
      const sessionTool = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools\/proposals$/);
      if (request.method === 'POST' && sessionTool) {
        const session = sessions.getSession(sessionTool[1]);
        const input = await bodyOf(request);
        const proposal = await createCodeToolProposal({ mode: session.mode, tool: input.tool, input: { ...input.input, sessionId: session.id }, root, audit });
        proposals.set(proposal.action.id, proposal);
        proposalStore.put(proposal);
        eventBus.publish({ type: 'proposal.created', sessionId: session.id, actionId: proposal.action.id, requestId, data: { tool: input.tool, actionType: proposal.action.type, status: proposal.action.status } });
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      const sessionClose = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/close$/);
      if (request.method === 'POST' && sessionClose) return json(response, 200, { session: sessions.closeSession(sessionClose[1]) });
      const sessionReview = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/review$/);
      if (request.method === 'POST' && sessionReview) {
        const session = sessions.reviewSession(sessionReview[1], await bodyOf(request));
        eventBus.publish({ type: 'session.reviewed', sessionId: session.id, requestId, data: { status: session.status } });
        return json(response, 200, { session });
      }
      if (request.method === 'POST' && url.pathname === '/v1/proposals/patch') {
        const input = await bodyOf(request);
        const proposal = await createPatchProposal({ ...input, root, audit, currentRevision: await currentWorkspaceRevision() });
        proposals.set(proposal.action.id, proposal);
        proposalStore.put(proposal);
        eventBus.publish({ type: 'proposal.created', sessionId: proposal.action.sessionId, actionId: proposal.action.id, requestId, data: { actionType: proposal.action.type, status: proposal.action.status } });
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/proposals/command') {
        const input = await bodyOf(request);
        const proposal = createCommandProposal({ ...input, root, audit, currentRevision: await currentWorkspaceRevision() });
        proposals.set(proposal.action.id, proposal);
        proposalStore.put(proposal);
        eventBus.publish({ type: 'proposal.created', sessionId: proposal.action.sessionId, actionId: proposal.action.id, requestId, data: { actionType: proposal.action.type, status: proposal.action.status } });
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      const approval = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approval) {
        if (!requireApprovalToken(request, approvalToken)) return json(response, 403, { error: 'APPROVAL_AUTH_REQUIRED', message: 'separate approval token required' });
        const proposal = proposals.get(approval[1]);
        if (!proposal) {
          const recovered = proposalStore.get(approval[1]);
          if (recovered?.recovery?.state === 'manual_review') return json(response, 409, { error: 'PROPOSAL_MANUAL_REVIEW', message: 'proposal was interrupted by restart; create a fresh proposal after review' });
          return json(response, 404, { error: 'PROPOSAL_NOT_FOUND', message: 'proposal not found' });
        }
        const input = await bodyOf(request);
        if (input.actionHash !== proposal.action.actionHash) return json(response, 409, { error: 'ACTION_HASH_MISMATCH', message: 'approval must bind the current action hash' });
        if (proposal.command) {
          try {
            const result = await approveAndRunCommand({ proposal, root, approved: true, audit, getCurrentRevision: currentWorkspaceRevision });
            proposalStore.markTerminal(proposal.action.id, result.action);
            eventBus.publish({ type: 'proposal.verified', sessionId: result.action.sessionId, actionId: result.action.id, requestId, data: { actionType: result.action.type, status: result.action.status } });
            return json(response, 200, result);
          } catch (error) {
            if (error instanceof WorkflowError && error.details?.action) proposalStore.markTerminal(proposal.action.id, error.details.action);
            throw error;
          }
        }
        try {
          const result = await approveAndApplyPatch({ proposal, root, approved: true, audit, getCurrentRevision: currentWorkspaceRevision });
          proposalStore.markTerminal(proposal.action.id, result.action);
          eventBus.publish({ type: 'proposal.verified', sessionId: result.action.sessionId, actionId: result.action.id, requestId, data: { actionType: result.action.type, status: result.action.status } });
          return json(response, 200, result);
        } catch (error) {
          if (error instanceof WorkflowError && error.details?.action) proposalStore.markTerminal(proposal.action.id, error.details.action);
          throw error;
        }
      }
      const proposalGet = url.pathname.match(/^\/v1\/proposals\/([^/]+)$/);
      if (request.method === 'GET' && proposalGet) {
        const record = proposalStore.get(proposalGet[1]);
        if (!record) return json(response, 404, { error: 'PROPOSAL_NOT_FOUND', message: 'proposal not found' });
        return json(response, 200, { proposal: publicProposal(record.proposal), ...(record.recovery ? { recovery: record.recovery } : {}) });
      }
      return json(response, 404, { error: 'NOT_FOUND', message: 'route not found' });
    } catch (error) {
      const mapped = errorResponse(error);
      return json(response, mapped.status, mapped.body);
    }
  });
  return Object.freeze({
    server,
    async listen() { await new Promise((resolve) => server.listen(port, host, resolve)); return server.address(); },
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  });
}
