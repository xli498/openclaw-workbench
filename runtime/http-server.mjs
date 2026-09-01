import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { startWorkbench } from './index.mjs';
import { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';
import { createChatSessionManager, SessionError } from './session.mjs';
import { createCodeToolProposal } from './code-tools.mjs';
import { createEventBus, EventBusError } from './event-bus.mjs';
import { createProposalStore, ProposalStoreError } from './proposal-store.mjs';
import { scanCommandLedger } from './command-ledger.mjs';
import { createWorkspace, WorkspaceError } from './workspace.mjs';
import { CONTROL_PANEL_HTML } from './control-panel.mjs';
import { transition } from './action.mjs';
import { AdapterError, createOpenClawAgentRunner } from './openclaw-adapter.mjs';
import { PlanError } from './plan.mjs';

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

function safePlanFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.slice(0, 32).map((failure) => {
    const safe = {};
    for (const field of ['model', 'stage', 'code']) {
      if (typeof failure?.[field] === 'string' && failure[field].length <= 256) safe[field] = failure[field];
    }
    if (typeof failure?.message === 'string') {
      // Failure text is model/provider controlled. Keep it useful for the UI,
      // but never return paths, credentials, or an unbounded provider error.
      const message = failure.message.replace(/(?:bearer|token|password|secret|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/(?:[A-Za-z]:)?(?:\\|\/)[^\s,;]*/g, '[path redacted]');
      safe.message = message.length <= 256 ? message : `${message.slice(0, 253)}...`;
    }
    return safe;
  });
}

function errorResponse(error) {
  const safe = (code, message) => ({ error: code, message: message && message.length <= 256 ? message : 'request failed' });
  if (error instanceof WorkflowError) return { status: error.code === 'APPROVAL_REQUIRED' ? 403 : 400, body: safe(error.code, error.message) };
  if (error instanceof AdapterError) return { status: error.code === 'TIMEOUT' ? 504 : error.code === 'ABORTED' ? 409 : 502, body: safe(error.code, error.message) };
  if (error instanceof SessionError) return { status: error.code === 'SESSION_NOT_FOUND' ? 404 : error.code === 'SESSION_BUSY' ? 409 : 400, body: safe(error.code, error.message) };
  if (error?.code === 'ABORTED') return { status: 409, body: { error: 'TURN_ABORTED', message: 'agent turn was cancelled' } };
  if (error instanceof PlanError || error?.name === 'PlanError') {
    const body = safe(error.code, error.message);
    const failures = safePlanFailures(error.details?.failures);
    if (failures.length) body.failures = failures;
    return { status: error.code === 'PLAN_FAILED' ? 502 : 400, body };
  }
  if (error instanceof EventBusError) return { status: 400, body: safe(error.code, 'event request failed') };
  if (error instanceof ProposalStoreError) return { status: error.code === 'PROPOSAL_NOT_FOUND' ? 404 : ['PROPOSAL_BUSY', 'PROPOSAL_MANUAL_REVIEW', 'ACTION_HASH_MISMATCH', 'CLAIM_MISMATCH'].includes(error.code) ? 409 : 400, body: safe(error.code, 'proposal request failed') };
  if (error instanceof WorkspaceError) return { status: ['INVALID_PATH', 'PATH_ESCAPE', 'SENSITIVE_PATH', 'SYMLINK_ESCAPE', 'NOT_A_FILE', 'READ_LIMIT', 'TREE_LIMIT'].includes(error.code) ? 400 : 404, body: safe(error.code, error.message) };
  return { status: error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'INVALID_JSON' || error.code === 'INVALID_BODY' || error.code === 'INVALID_QUERY_INTEGER' || error.code === 'DUPLICATE_QUERY_PARAMETER' ? 400 : 500, body: safe(error.code ?? 'INTERNAL_ERROR', error.message) };
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

function requestAbortSignal(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // IncomingMessage emits `close` after the request body has been consumed as
  // well as when the client aborts. Only the explicit aborted signal is a
  // reliable request-side cancellation source.
  const requestClose = () => { if (request.aborted) abort(); };
  const responseClose = () => { if (!response.writableEnded) abort(); };
  const socketClose = () => { if (!response.writableEnded) abort(); };
  request.once('aborted', abort);
  request.once('close', requestClose);
  response.once('close', responseClose);
  request.socket?.once('close', socketClose);
  return Object.freeze({ signal: controller.signal, cleanup() { request.off('aborted', abort); request.off('close', requestClose); response.off('close', responseClose); request.socket?.off('close', socketClose); } });
}

function publicProposal(proposal) {
  return { action: proposal.action, command: proposal.command, parsedPatch: proposal.parsedPatch, workspaceRevision: proposal.workspaceRevision, policy: proposal.policy, commandPolicy: proposal.commandPolicy };
}

export function createWorkbenchServer({ root, audit, token, approvalToken, host = '127.0.0.1', port = 0, runAgentFn, adapter, eventBus = createEventBus({ root }) } = {}) {
  if (!root) throw new Error('root is required');
  if (typeof token !== 'string' || token.length < 16) throw new Error('token must be at least 16 characters');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('host must be loopback');
  const proposals = new Map();
  const proposalStore = createProposalStore({ root });
  const agentRunner = runAgentFn ?? (adapter ? createOpenClawAgentRunner(adapter) : undefined);
  const sessions = createChatSessionManager({ root, runAgentFn: agentRunner });
  const startupState = startWorkbench({ root, audit });
  const currentWorkspaceRevision = async () => (await createWorkspace(root)).workspaceRevision();
  const liveStreams = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    const requestId = requestIdOf(request.headers['x-request-id']);
    response.setHeader('x-request-id', requestId);
    try {
      if (!requireToken(request, token)) return json(response, 401, { error: 'UNAUTHORIZED', message: 'bearer token required' });
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        return response.end(CONTROL_PANEL_HTML);
      }
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'openclaw-workbench' });
      await startupState;
      if (request.method === 'GET' && url.pathname === '/v1/events/stream') {
        const after = singleQueryInteger(url.searchParams, 'after', 0);
        const stream = eventBus.subscribeFrom((event) => { if (!response.destroyed && !response.writableEnded) response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); }, { after, limit: Math.min(100, eventBus.retentionLimit ?? 100) });
        const { page, unsubscribe } = stream;
        if (page.cursorExpired) { unsubscribe(); return json(response, 409, { error: 'EVENT_CURSOR_EXPIRED', message: 'event cursor is older than retained history', earliestSequence: page.earliestSequence, latestSequence: page.latestSequence }); }
        liveStreams.add(response);
        const initial = page.events;
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive' });
        for (const event of initial) if (!response.destroyed) response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keep-alive\n\n'); }, 15_000);
        let cleaned = false;
        const cleanup = () => { if (cleaned) return; cleaned = true; clearInterval(heartbeat); unsubscribe(); liveStreams.delete(response); };
        request.on('close', cleanup);
        response.on('close', cleanup);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') return json(response, 200, eventBus.list({ after: singleQueryInteger(url.searchParams, 'after', 0), limit: singleQueryInteger(url.searchParams, 'limit', 100) }));
      if (request.method === 'GET' && url.pathname === '/v1/status') return json(response, 200, { ...(await startupState), persistedState: { sessions: sessions.recoverySummary(), proposals: proposalStore.recoverySummary(), events: { recovered: eventBus.recovered, latestSequence: eventBus.list({ after: 0, limit: 1 }).latestSequence } } });
      if (request.method === 'GET' && url.pathname === '/v1/commands') {
        const sessionId = url.searchParams.get('sessionId');
        const actionHash = url.searchParams.get('actionHash');
        const records = await scanCommandLedger({ root });
        return json(response, 200, { commands: records
          .filter((record) => (sessionId === null || record.sessionId === sessionId) && (actionHash === null || record.actionHash === actionHash))
          .sort((left, right) => String(right.updatedAt ?? right.claimedAt ?? '').localeCompare(String(left.updatedAt ?? left.claimedAt ?? '')))
          .map(({ ledgerPath, ...record }) => record) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/workspace/read') {
        const relativePath = url.searchParams.get('path');
        if (!relativePath) return json(response, 400, { error: 'INVALID_PATH', message: 'path query parameter is required' });
        const workspace = await createWorkspace(root);
        const [content, metadata] = await Promise.all([workspace.read(relativePath), workspace.inspect(relativePath)]);
        return json(response, 200, { file: { ...metadata, content } });
      }
      if (request.method === 'GET' && url.pathname === '/v1/workspace/tree') {
        const workspace = await createWorkspace(root);
        const maxEntries = singleQueryInteger(url.searchParams, 'maxEntries', 2_000);
        const maxDepth = singleQueryInteger(url.searchParams, 'maxDepth', 8);
        return json(response, 200, { root: { path: '', type: 'directory', children: await workspace.tree({ maxEntries, maxDepth }) } });
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') return json(response, 200, { sessions: sessions.listSessions({ status: url.searchParams.get('status') ?? undefined }) });
      if (request.method === 'POST' && url.pathname === '/v1/sessions') { const session = sessions.createSession(await bodyOf(request)); eventBus.publish({ type: 'session.created', sessionId: session.id, requestId, data: { mode: session.mode } }); return json(response, 201, { session }); }
      const sessionMessages = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && sessionMessages) return json(response, 200, { messages: sessions.listMessages(sessionMessages[1]) });
      if (request.method === 'POST' && sessionMessages) { const input = await bodyOf(request); const lifecycle = requestAbortSignal(request, response); try { const result = await sessions.sendMessage({ sessionId: sessionMessages[1], ...input, signal: lifecycle.signal }); eventBus.publish({ type: 'chat.completed', sessionId: sessionMessages[1], requestId, data: { messageCount: result.session.messageCount } }); return json(response, 200, result); } finally { lifecycle.cleanup(); } }
      const sessionCancel = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && sessionCancel) { const result = sessions.cancelTurn(sessionCancel[1]); eventBus.publish({ type: 'turn.cancel.requested', sessionId: sessionCancel[1], requestId, data: { cancelled: true } }); return json(response, 202, result); }
      const sessionPlan = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/plan$/);
      if (request.method === 'GET' && sessionPlan) return json(response, 200, { results: sessions.listPlanResults(sessionPlan[1]) });
      if (request.method === 'POST' && sessionPlan) { const input = await bodyOf(request); const lifecycle = requestAbortSignal(request, response); try { const result = await sessions.planReview({ sessionId: sessionPlan[1], ...input, signal: lifecycle.signal, onStage: (data) => eventBus.publish({ type: `plan.stage.${data.status}`, sessionId: sessionPlan[1], requestId, data: { stage: data.stage, ...data } }) }); eventBus.publish({ type: 'plan.completed', sessionId: sessionPlan[1], requestId, data: { agreement: result.synthesis.agreement, requiresHumanReview: result.synthesis.requiresHumanReview } }); return json(response, 200, result); } finally { lifecycle.cleanup(); } }
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
        const proposal = await createCommandProposal({ ...input, root, audit, currentRevision: await currentWorkspaceRevision() });
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
        const claim = proposalStore.claim(proposal.action.id, input.actionHash);
        try {
          const result = proposal.command
            ? await approveAndRunCommand({ proposal: claim.proposal, root, approved: true, audit, getCurrentRevision: currentWorkspaceRevision })
            : await approveAndApplyPatch({ proposal: claim.proposal, root, approved: true, audit, getCurrentRevision: currentWorkspaceRevision });
          proposalStore.markTerminal(proposal.action.id, result.action, claim.claim.token);
          proposals.delete(proposal.action.id);
          eventBus.publish({ type: 'proposal.verified', sessionId: result.action.sessionId, actionId: result.action.id, requestId, data: { actionType: result.action.type, status: result.action.status } });
          return json(response, 200, result);
        } catch (error) {
          if (error instanceof WorkflowError && error.details?.action) proposalStore.markTerminal(proposal.action.id, error.details.action, claim.claim.token);
          else {
            // Pre-execution checks (revision, ledger, policy or audit) can fail
            // after a durable claim. Never leave an unclaimable executing record.
            proposalStore.markManualReview(proposal.action.id, claim.claim.token, error);
            proposals.delete(proposal.action.id);
          }
          throw error;
        }
      }
      const reject = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/(deny|cancel)$/);
      if (request.method === 'POST' && reject) {
        if (!requireApprovalToken(request, approvalToken)) return json(response, 403, { error: 'APPROVAL_AUTH_REQUIRED', message: 'separate approval token required' });
        const proposal = proposals.get(reject[1]) ?? proposalStore.get(reject[1])?.proposal;
        if (!proposal) return json(response, 404, { error: 'PROPOSAL_NOT_FOUND', message: 'proposal not found' });
        const nextStatus = reject[2] === 'deny' ? 'denied' : 'cancelled';
        let action;
        try { action = transition(proposal.action, nextStatus); }
        catch (error) { const wrapped = new ProposalStoreError(error.message.startsWith('invalid_transition') ? 'PROPOSAL_BUSY' : 'ACTION_HASH_MISMATCH', error.message); throw wrapped; }
        const record = proposalStore.reject(proposal.action.id, action);
        proposals.delete(proposal.action.id);
        const verb = reject[2] === 'deny' ? 'denied' : 'cancelled';
        eventBus.publish({ type: `proposal.${verb}`, sessionId: action.sessionId, actionId: action.id, requestId, data: { actionType: action.type, status: action.status } });
        if (audit) await audit.append({ type: `action.${verb}`, actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash });
        return json(response, 200, { proposal: publicProposal(record.proposal) });
      }
      const proposalDiff = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/diff$/);
      if (request.method === 'GET' && proposalDiff) {
        const record = proposalStore.get(proposalDiff[1]);
        if (!record) return json(response, 404, { error: 'PROPOSAL_NOT_FOUND', message: 'proposal not found' });
        const proposal = record.proposal;
        if (proposal.action.type !== 'patch' || typeof proposal.action.preview !== 'string') {
          return json(response, 400, { error: 'NOT_PATCH_PROPOSAL', message: 'proposal does not contain a patch diff' });
        }
        return json(response, 200, {
          diff: {
            actionId: proposal.action.id,
            actionHash: proposal.action.actionHash,
            status: proposal.action.status,
            workspaceRevision: proposal.workspaceRevision,
            paths: Array.isArray(proposal.parsedPatch?.paths) ? proposal.parsedPatch.paths : [],
            patch: proposal.action.preview,
            parsedPatch: proposal.parsedPatch,
          },
        });
      }
      const proposalGet = url.pathname.match(/^\/v1\/proposals\/([^/]+)$/);
      if (request.method === 'GET' && url.pathname === '/v1/proposals') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        return json(response, 200, { proposals: proposalStore.list({ status: url.searchParams.get('status') ?? undefined })
          .filter((record) => sessionId === undefined || record.proposal.action.sessionId === sessionId)
          .map((record) => ({ ...publicProposal(record.proposal), ...(record.recovery ? { recovery: record.recovery } : {}) })) });
      }
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
  let closing = false;
  return Object.freeze({
    server,
    startup: startupState,
    async listen() { await new Promise((resolve) => server.listen(port, host, resolve)); return server.address(); },
    async close() {
      if (closing) return;
      closing = true;
      sessions.cancelAllTurns();
      for (const stream of liveStreams) stream.end();
      liveStreams.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}
