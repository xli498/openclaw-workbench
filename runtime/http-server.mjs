import http from 'node:http';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { startWorkbench } from './index.mjs';
import { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';
import { createChatSessionManager, SessionError } from './session.mjs';
import { createCodeToolProposal } from './code-tools.mjs';
import { createEventBus, EventBusError } from './event-bus.mjs';
import { createProposalStore, ProposalStoreError } from './proposal-store.mjs';
import { scanCommandLedger } from './command-ledger.mjs';
import { createWorkspace, WorkspaceError } from './workspace.mjs';
import { controlPanelHtml } from './control-panel.mjs';
import { transition } from './action.mjs';
import { createAction } from './action.mjs';
import { AdapterError, createOpenClawAgentRunner, inspectOpenClaw, inspectOpenClawMcp } from './openclaw-adapter.mjs';
import { createFileAuditLog } from './audit.mjs';
import { PlanError } from './plan.mjs';
import { RecoveryError, decideRecovery, inspectPendingTransaction, scanPendingTransactions } from './recovery.mjs';
import { ConfigError, readConfig, importConfig, rollbackConfig, validateBackupId } from './config-store.mjs';
import { snapshotDigest } from './snapshot-store.mjs';
import { McpRegistryError, createMcpRegistry, normalizeMcpServer } from './mcp-registry.mjs';
import { ModelRegistryError, createModelRegistry, normalizeModelProfile } from './model-registry.mjs';
import { McpRuntimeError, createMcpServerRuntime } from './mcp-runtime.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONFIG_PROPOSALS = 32;
const MAX_CONFIG_PROPOSAL_BYTES = 8 * 1024 * 1024;
const MAX_MCP_PROPOSALS = 64;
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
  if (error instanceof RecoveryError) return { status: ['SCAN_FAILED', 'MANIFEST_INVALID'].includes(error.code) ? 500 : 400, body: safe(error.code, error.message) };
  if (error instanceof ConfigError) return { status: ['CONFIG_CONFLICT', 'CONFIG_ACTION_HASH_MISMATCH', 'CONFIG_BUSY', 'BACKUP_TARGET_MISMATCH'].includes(error.code) ? 409 : error.code === 'APPROVAL_AUTH_REQUIRED' ? 403 : error.code === 'CONFIG_PROPOSAL_LIMIT' ? 429 : 400, body: safe(error.code, error.message) };
  if (error instanceof McpRegistryError) return { status: ['MCP_CONFLICT', 'MCP_DUPLICATE', 'MCP_REGISTRY_BUSY', 'MCP_ACTION_HASH_MISMATCH', 'MCP_PROPOSAL_BUSY'].includes(error.code) ? 409 : error.code === 'MCP_NOT_FOUND' ? 404 : error.code === 'MCP_PROPOSAL_LIMIT' ? 429 : 400, body: safe(error.code, error.message) };
  if (error instanceof McpRuntimeError) return { status: ['MCP_CONFLICT', 'MCP_NOT_RUNNING', 'MCP_SERVER_DISABLED', 'MCP_REQUEST_ABORTED', 'MCP_TRANSPORT_CLOSED'].includes(error.code) ? 409 : error.code === 'MCP_NOT_FOUND' ? 404 : ['MCP_APPROVAL_REQUIRED', 'MCP_TOOL_NOT_AUTHORIZED'].includes(error.code) ? 403 : ['MCP_START_FAILED', 'MCP_REQUEST_FAILED', 'MCP_HTTP_STATUS', 'MCP_REMOTE_ERROR', 'MCP_PROCESS_ERROR', 'MCP_PROCESS_CLOSED', 'MCP_STDIN_ERROR', 'MCP_SEND_FAILED'].includes(error.code) ? 502 : error.code === 'MCP_REQUEST_TIMEOUT' ? 504 : 400, body: safe(error.code, error.message) };
  if (error instanceof ModelRegistryError) return { status: ['MODEL_CONFLICT', 'MODEL_DUPLICATE', 'MODEL_REGISTRY_BUSY', 'MODEL_ACTION_HASH_MISMATCH'].includes(error.code) ? 409 : error.code === 'MODEL_NOT_FOUND' ? 404 : error.code === 'MODEL_PROPOSAL_LIMIT' ? 429 : 400, body: safe(error.code, error.message) };
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

function publicConfigProposal(proposal) {
  return { action: proposal.action, config: { relativePath: proposal.config.relativePath, operation: proposal.config.operation, ...(proposal.config.operation === 'import' ? { contentHash: proposal.config.contentHash, contentBytes: proposal.config.contentBytes } : { backupId: proposal.config.backupId }) } };
}

function publicMcpProposal(proposal) {
  if (typeof proposal.operation === 'string' && proposal.operation.startsWith('runtime_')) {
    return { action: proposal.action, operation: proposal.operation, server: { id: proposal.server.id, name: proposal.server.name }, ...(proposal.tool ? { tool: proposal.tool } : {}), ...(Number.isSafeInteger(proposal.inputBytes) ? { inputBytes: proposal.inputBytes } : {}) };
  }
  return { action: proposal.action, server: proposal.server, ...(proposal.operation ? { operation: proposal.operation } : {}) };
}

function publicModelProposal(proposal) {
  return { action: proposal.action, profile: proposal.profile };
}

function publicAuditEvent(event) {
  const safe = {};
  for (const field of ['id', 'timestamp', 'type', 'actor', 'sessionId', 'actionId', 'actionHash', 'transactionId', 'serverId', 'profileId', 'operation', 'status', 'code', 'state']) {
    if (typeof event?.[field] === 'string' && event[field].length <= 256) safe[field] = event[field];
  }
  if (Array.isArray(event?.files)) {
    const files = event.files.filter((file) => typeof file === 'string' && file.length <= 512).slice(0, 128);
    if (files.length) safe.files = files;
  }
  return safe;
}

function createLazyAuditLog(root) {
  let ready;
  const get = () => (ready ??= createFileAuditLog({ root, filePath: '.openclaw-workbench/audit.jsonl' }));
  return Object.freeze({
    append(event) { return get().then((log) => log.append(event)); },
    list() { return get().then((log) => log.list()); },
  });
}

export function createWorkbenchServer({ root, audit, token, approvalToken, host = '127.0.0.1', port = 0, runAgentFn, adapter, inspectOpenClawFn, inspectOpenClawMcpFn, inspectMcpServerFn, inspectModelProfileFn, eventBus, mcpRuntime, mcpTransportFactory, __testHooks } = {}) {
  if (!root) throw new Error('root is required');
  root = realpathSync(root);
  eventBus ??= createEventBus({ root });
  if (typeof token !== 'string' || token.length < 16) throw new Error('token must be at least 16 characters');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('host must be loopback');
  const proposals = new Map();
  const configProposals = new Map();
  const configReservations = new Map();
  const mcpProposals = new Map();
  const mcpReservations = new Set();
  const mcpClaims = new Set();
  const modelProposals = new Map();
  const modelReservations = new Set();
  const MAX_MODEL_PROPOSALS = 64;
  const modelRegistry = createModelRegistry({ root });
  const mcpRegistry = createMcpRegistry({ root });
  const runtime = mcpRuntime ?? createMcpServerRuntime({ registry: mcpRegistry, transportFactory: mcpTransportFactory });
  const effectiveAudit = audit ?? createLazyAuditLog(root);
  const proposalStore = createProposalStore({ root });
  const adapterConfig = adapter ? { ...adapter, command: adapter.command ?? 'openclaw' } : null;
  const agentRunner = runAgentFn ?? (adapterConfig ? createOpenClawAgentRunner(adapterConfig) : undefined);
  const inspect = inspectOpenClawFn ?? ((options) => inspectOpenClaw(options));
  const inspectMcp = inspectOpenClawMcpFn ?? ((options) => inspectOpenClawMcp(options));
  const inspectMcpServer = inspectMcpServerFn ?? (async () => ({ status: 'unavailable', code: 'NOT_CONFIGURED' }));
  const inspectModelProfile = inspectModelProfileFn ?? (async () => ({ status: 'unavailable', code: 'NOT_CONFIGURED' }));
  const sessions = createChatSessionManager({ root, runAgentFn: agentRunner });
  const startupState = startWorkbench({ root, audit: effectiveAudit });
  const currentWorkspaceRevision = async () => (await createWorkspace(root)).workspaceRevision();
  const liveStreams = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    const requestId = requestIdOf(request.headers['x-request-id']);
    response.setHeader('x-request-id', requestId);
    try {
      if (!requireToken(request, token)) return json(response, 401, { error: 'UNAUTHORIZED', message: 'bearer token required' });
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/ui')) {
        const nonce = randomBytes(18).toString('base64');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
        return response.end(controlPanelHtml(nonce));
      }
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'openclaw-workbench' });
      if (request.method === 'GET' && url.pathname === '/v1/openclaw/diagnostics') return json(response, 200, await inspect({ command: adapterConfig?.command ?? 'openclaw' }));
      if (request.method === 'GET' && url.pathname === '/v1/openclaw/mcp') return json(response, 200, await inspectMcp({ command: adapterConfig?.command ?? 'openclaw' }));
      if (request.method === 'GET' && url.pathname === '/v1/mcp/servers') return json(response, 200, { servers: mcpRegistry.list() });
      if (request.method === 'GET' && url.pathname === '/v1/mcp/runtimes') return json(response, 200, { runtimes: runtime.status() });
      if (request.method === 'GET' && url.pathname === '/v1/models') return json(response, 200, { models: modelRegistry.list() });
      const modelHealth = url.pathname.match(/^\/v1\/models\/([^/]+)\/health$/);
      if (request.method === 'GET' && modelHealth) {
        const profile = modelRegistry.get(modelHealth[1]);
        if (!profile) return json(response, 404, { error: 'MODEL_NOT_FOUND', message: 'model profile not found' });
        let result; try { result = await inspectModelProfile({ profile }); } catch (error) { result = { status: 'error', code: error.code ?? 'MODEL_HEALTH_FAILED' }; }
        const health = { status: ['ready', 'unavailable', 'error', 'unknown'].includes(result?.status) ? result.status : 'error', ...(typeof result?.code === 'string' && result.code.length <= 128 ? { code: result.code } : {}) };
        const updated = modelRegistry.updateHealth(profile.id, health);
        if (effectiveAudit) await effectiveAudit.append({ type: 'model.health.checked', actor: 'system', profileId: updated.id, status: health.status, code: health.code ?? null });
        return json(response, 200, { profile: { id: updated.id, provider: updated.provider, model: updated.model, enabled: updated.enabled }, health });
      }
      if (request.method === 'POST' && url.pathname === '/v1/models') {
        const input = await bodyOf(request);
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new ModelRegistryError('MODEL_SESSION_REQUIRED', 'sessionId is required');
        if (modelProposals.size + modelReservations.size >= MAX_MODEL_PROPOSALS) throw new ModelRegistryError('MODEL_PROPOSAL_LIMIT', 'too many pending model proposals');
        const profile = normalizeModelProfile(input);
        const action = transition(transition(createAction({ type: 'model.register', sessionId: input.sessionId, workspaceRevision: profile.configHash, target: profile.id, preview: profile, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, profile }); modelReservations.add(action.id);
        try { if (effectiveAudit) await effectiveAudit.append({ type: 'model.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, profileId: profile.id }); } catch (error) { modelReservations.delete(action.id); throw error; }
        modelReservations.delete(action.id); modelProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicModelProposal(proposal) });
      }
      const modelApproval = url.pathname.match(/^\/v1\/models\/([^/]+)\/approve$/);
      if (request.method === 'POST' && modelApproval) {
        if (!requireApprovalToken(request, approvalToken)) return json(response, 403, { error: 'APPROVAL_AUTH_REQUIRED', message: 'separate approval token required' });
        const proposal = modelProposals.get(modelApproval[1]); if (!proposal) return json(response, 404, { error: 'MODEL_PROPOSAL_NOT_FOUND', message: 'model proposal not found' });
        const input = await bodyOf(request); if (input.actionHash !== proposal.action.actionHash) throw new ModelRegistryError('MODEL_ACTION_HASH_MISMATCH', 'approval must bind the current model action hash');
        const approved = transition(proposal.action, 'approved', { expectedHash: proposal.action.actionHash });
        try { const profile = modelRegistry.register(proposal.profile); const verified = transition(transition(approved, 'executing'), 'verified'); modelProposals.delete(proposal.action.id); if (effectiveAudit) await effectiveAudit.append({ type: 'model.verified', actor: 'system', actionId: verified.id, sessionId: verified.sessionId, actionHash: verified.actionHash, profileId: profile.id }); return json(response, 200, { action: verified, profile }); }
        catch (error) { modelProposals.delete(proposal.action.id); if (effectiveAudit) await effectiveAudit.append({ type: 'model.failed', actor: 'system', actionId: proposal.action.id, sessionId: proposal.action.sessionId, actionHash: proposal.action.actionHash, profileId: proposal.profile.id, code: error.code ?? 'MODEL_FAILED' }); throw error; }
      }
      const mcpHealth = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/health$/);
      if (request.method === 'GET' && mcpHealth) {
        const serverRecord = mcpRegistry.get(mcpHealth[1]);
        if (!serverRecord) return json(response, 404, { error: 'MCP_NOT_FOUND', message: 'MCP server not found' });
        let result;
        try { result = await inspectMcpServer({ server: serverRecord }); }
        catch (error) { result = { status: 'error', code: error.code ?? 'MCP_HEALTH_FAILED' }; }
        const health = { status: ['ready', 'unavailable', 'error', 'unknown'].includes(result?.status) ? result.status : 'error', ...(typeof result?.code === 'string' && result.code.length <= 128 ? { code: result.code } : {}) };
        const updated = mcpRegistry.updateHealth(serverRecord.id, health);
        if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.health.checked', actor: 'system', serverId: updated.id, status: health.status, code: health.code ?? null });
        return json(response, 200, { server: { id: updated.id, name: updated.name, enabled: updated.enabled }, health });
      }
      if (request.method === 'POST' && url.pathname === '/v1/mcp/servers') {
        const input = await bodyOf(request);
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new McpRegistryError('MCP_SESSION_REQUIRED', 'sessionId is required');
        if (mcpProposals.size + mcpReservations.size >= MAX_MCP_PROPOSALS) throw new McpRegistryError('MCP_PROPOSAL_LIMIT', 'too many pending MCP proposals');
        const serverConfig = normalizeMcpServer(input);
        const action = transition(transition(createAction({ type: 'mcp.register', sessionId: input.sessionId, workspaceRevision: serverConfig.configHash, target: serverConfig.id, preview: serverConfig, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, server: serverConfig, operation: 'register' });
        mcpReservations.add(action.id);
        try { if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, serverId: serverConfig.id, operation: 'register' }); }
        catch (error) { mcpReservations.delete(action.id); throw error; }
        mcpReservations.delete(action.id);
        mcpProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicMcpProposal(proposal) });
      }
      const mcpAuthorize = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/authorize$/);
      if (request.method === 'POST' && mcpAuthorize) {
        const input = await bodyOf(request);
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new McpRegistryError('MCP_SESSION_REQUIRED', 'sessionId is required');
        if (mcpProposals.size + mcpReservations.size >= MAX_MCP_PROPOSALS) throw new McpRegistryError('MCP_PROPOSAL_LIMIT', 'too many pending MCP proposals');
        if (!Array.isArray(input.tools)) throw new McpRegistryError('MCP_TOOLS_INVALID', 'tools must be an array');
        const serverConfig = mcpRegistry.get(mcpAuthorize[1]);
        if (!serverConfig) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
        const nextTools = normalizeMcpServer({ ...serverConfig, tools: input.tools }).tools;
        const preview = { serverId: serverConfig.id, expectedConfigHash: input.configHash, tools: nextTools };
        const action = transition(transition(createAction({ type: 'mcp.authorize_tools', sessionId: input.sessionId, workspaceRevision: serverConfig.configHash, target: serverConfig.id, preview, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, server: serverConfig, operation: 'authorize_tools', expectedConfigHash: input.configHash, tools: nextTools });
        mcpReservations.add(action.id);
        try { if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, serverId: serverConfig.id, operation: 'authorize_tools' }); }
        catch (error) { mcpReservations.delete(action.id); throw error; }
        mcpReservations.delete(action.id);
        mcpProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicMcpProposal(proposal) });
      }
      const mcpToggle = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/(enable|disable)$/);
      if (request.method === 'POST' && mcpToggle) {
        const input = await bodyOf(request);
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new McpRegistryError('MCP_SESSION_REQUIRED', 'sessionId is required');
        if (typeof input.configHash !== 'string' || !input.configHash) throw new McpRegistryError('MCP_CONFLICT', 'configHash is required');
        if (mcpProposals.size + mcpReservations.size >= MAX_MCP_PROPOSALS) throw new McpRegistryError('MCP_PROPOSAL_LIMIT', 'too many pending MCP proposals');
        const serverConfig = mcpRegistry.get(mcpToggle[1]);
        if (!serverConfig) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
        const enabled = mcpToggle[2] === 'enable';
        const preview = { serverId: serverConfig.id, expectedConfigHash: input.configHash, enabled };
        const action = transition(transition(createAction({ type: 'mcp.set_enabled', sessionId: input.sessionId, workspaceRevision: serverConfig.configHash, target: serverConfig.id, preview, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, server: serverConfig, operation: 'set_enabled', expectedConfigHash: input.configHash, enabled });
        mcpReservations.add(action.id);
        try { if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, serverId: serverConfig.id, operation: 'set_enabled', enabled }); }
        catch (error) { mcpReservations.delete(action.id); throw error; }
        mcpReservations.delete(action.id);
        mcpProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicMcpProposal(proposal) });
      }
      const mcpRuntimeAction = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/(start|stop|call)$/);
      if (request.method === 'POST' && mcpRuntimeAction) {
        const input = await bodyOf(request);
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new McpRegistryError('MCP_SESSION_REQUIRED', 'sessionId is required');
        if (typeof input.configHash !== 'string' || !input.configHash) throw new McpRegistryError('MCP_CONFLICT', 'configHash is required');
        if (mcpProposals.size + mcpReservations.size >= MAX_MCP_PROPOSALS) throw new McpRegistryError('MCP_PROPOSAL_LIMIT', 'too many pending MCP proposals');
        const serverConfig = mcpRegistry.get(mcpRuntimeAction[1]);
        if (!serverConfig) throw new McpRegistryError('MCP_NOT_FOUND', 'MCP server not found');
        const operation = `runtime_${mcpRuntimeAction[2]}`;
        let tool;
        let callInput;
        let inputBytes;
        let inputHash;
        if (mcpRuntimeAction[2] === 'call') {
          if (typeof input.tool !== 'string' || !input.tool || input.tool.length > 128) throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'tool is required');
          if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'input must be an object');
          let encoded;
          try { encoded = JSON.stringify(input.input); } catch { throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'input must be JSON serializable'); }
          inputBytes = Buffer.byteLength(encoded, 'utf8');
          if (inputBytes > MAX_BODY_BYTES) throw new McpRuntimeError('MCP_TOOL_INPUT_INVALID', 'input is too large');
          tool = input.tool;
          callInput = input.input;
          inputHash = snapshotDigest(encoded);
        }
        const preview = { serverId: serverConfig.id, expectedConfigHash: input.configHash, operation, ...(tool ? { tool } : {}), ...(Number.isSafeInteger(inputBytes) ? { inputBytes, inputHash } : {}) };
        const action = transition(transition(createAction({ type: 'mcp.runtime', sessionId: input.sessionId, workspaceRevision: serverConfig.configHash, target: serverConfig.id, preview, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, server: serverConfig, operation, expectedConfigHash: input.configHash, ...(tool ? { tool, input: callInput, inputBytes } : {}) });
        mcpReservations.add(action.id);
        try { if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, serverId: serverConfig.id, operation, ...(tool ? { tool, inputBytes } : {}) }); }
        catch (error) { mcpReservations.delete(action.id); throw error; }
        mcpReservations.delete(action.id);
        mcpProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicMcpProposal(proposal) });
      }
      const mcpApproval = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/approve$/);
      if (request.method === 'POST' && mcpApproval) {
        if (!requireApprovalToken(request, approvalToken)) return json(response, 403, { error: 'APPROVAL_AUTH_REQUIRED', message: 'separate approval token required' });
        const proposal = mcpProposals.get(mcpApproval[1]);
        if (!proposal) return json(response, 404, { error: 'MCP_PROPOSAL_NOT_FOUND', message: 'MCP proposal not found' });
        const input = await bodyOf(request);
        if (input.actionHash !== proposal.action.actionHash) throw new McpRegistryError('MCP_ACTION_HASH_MISMATCH', 'approval must bind the current MCP action hash');
        const approved = transition(proposal.action, 'approved', { expectedHash: proposal.action.actionHash });
        if (mcpClaims.has(proposal.action.id)) throw new McpRegistryError('MCP_PROPOSAL_BUSY', 'MCP proposal is already executing');
        mcpClaims.add(proposal.action.id);
        try {
          let server = proposal.server;
          let runtimeResult;
          let toolResult;
          if (proposal.operation === 'register') server = mcpRegistry.register(proposal.server);
          else if (proposal.operation === 'authorize_tools') server = mcpRegistry.authorizeTools(proposal.server.id, proposal.tools, proposal.expectedConfigHash);
          else if (proposal.operation === 'set_enabled') server = mcpRegistry.setEnabled(proposal.server.id, proposal.enabled, proposal.expectedConfigHash);
          else if (proposal.operation === 'runtime_start') runtimeResult = await runtime.start(proposal.server.id, { expectedConfigHash: proposal.expectedConfigHash, approved: true });
          else if (proposal.operation === 'runtime_stop') {
            const current = mcpRegistry.get(proposal.server.id);
            if (!current || current.configHash !== proposal.expectedConfigHash) throw new McpRuntimeError('MCP_CONFLICT', 'MCP server configuration changed');
            runtimeResult = await runtime.stop(proposal.server.id);
          } else if (proposal.operation === 'runtime_call') toolResult = await runtime.callTool(proposal.server.id, proposal.tool, proposal.input, { expectedConfigHash: proposal.expectedConfigHash, approved: true });
          else throw new McpRuntimeError('MCP_RUNTIME_OPERATION_INVALID', 'MCP runtime operation is invalid');
          const verified = transition(transition(approved, 'executing'), 'verified');
          mcpProposals.delete(proposal.action.id);
          if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.verified', actor: 'system', actionId: verified.id, sessionId: verified.sessionId, actionHash: verified.actionHash, serverId: server.id, operation: proposal.operation });
          return json(response, 200, { action: verified, ...(proposal.operation.startsWith('runtime_') ? { ...(runtimeResult ? { runtime: runtimeResult } : {}), ...(toolResult !== undefined ? { result: toolResult } : {}) } : { server }) });
        } catch (error) {
          mcpProposals.delete(proposal.action.id);
          if (effectiveAudit) await effectiveAudit.append({ type: 'mcp.failed', actor: 'system', actionId: proposal.action.id, sessionId: proposal.action.sessionId, actionHash: proposal.action.actionHash, serverId: proposal.server.id, operation: proposal.operation, code: error.code ?? 'MCP_FAILED' });
          throw error;
        } finally {
          mcpClaims.delete(proposal.action.id);
        }
      }
      if (request.method === 'GET' && url.pathname === '/v1/config') return json(response, 200, { config: await readConfig({ root }) });
      if (request.method === 'POST' && (url.pathname === '/v1/config/import' || url.pathname === '/v1/config/rollback')) {
        const input = await bodyOf(request);
        const operation = url.pathname.endsWith('/import') ? 'import' : 'rollback';
        if (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 128) throw new ConfigError('SESSION_REQUIRED', 'sessionId is required');
        const expectedHash = input.expectedHash ?? null;
        const current = await readConfig({ root, relativePath: input.relativePath ?? 'openclaw.json' });
        if (expectedHash !== current.hash) throw new ConfigError('CONFIG_CONFLICT', 'config changed before proposal', { expectedHash, actualHash: current.hash });
        const config = operation === 'import'
          ? { operation, relativePath: current.relativePath, content: input.content, contentHash: typeof input.content === 'string' ? snapshotDigest(input.content) : null, contentBytes: typeof input.content === 'string' ? Buffer.byteLength(input.content) : 0, expectedHash }
          : { operation, relativePath: current.relativePath, backupId: validateBackupId(input.backupId), expectedHash };
        if (operation === 'import' && (typeof config.content !== 'string' || config.contentBytes > 256 * 1024)) throw new ConfigError('CONFIG_CONTENT_INVALID', 'config content must be a string below the request limit');
        const pendingBytes = [...configProposals.values()].reduce((total, item) => total + (item.config.contentBytes ?? 0), 0) + [...configReservations.values()].reduce((total, bytes) => total + bytes, 0);
        if (configProposals.size + configReservations.size >= MAX_CONFIG_PROPOSALS || pendingBytes + (config.contentBytes ?? 0) > MAX_CONFIG_PROPOSAL_BYTES) throw new ConfigError('CONFIG_PROPOSAL_LIMIT', 'too many pending config proposals');
        const preview = operation === 'import' ? { operation, relativePath: current.relativePath, contentHash: config.contentHash, contentBytes: config.contentBytes, expectedHash: config.expectedHash } : { operation, relativePath: current.relativePath, backupId: config.backupId, expectedHash: config.expectedHash };
        const action = transition(transition(createAction({ type: 'config', sessionId: input.sessionId, workspaceRevision: current.hash ?? 'missing', target: current.relativePath, preview, risk: 'high' }), 'inspected'), 'awaiting_approval');
        const proposal = Object.freeze({ action, config });
        configReservations.set(action.id, config.contentBytes ?? 0);
        try {
          if (effectiveAudit) await effectiveAudit.append({ type: 'config.proposed', actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash, operation, relativePath: current.relativePath, contentHash: config.contentHash ?? null });
        } catch (error) {
          configReservations.delete(action.id);
          throw error;
        }
        configReservations.delete(action.id);
        configProposals.set(action.id, proposal);
        return json(response, 201, { proposal: publicConfigProposal(proposal) });
      }
      const configApproval = url.pathname.match(/^\/v1\/config\/([^/]+)\/approve$/);
      if (request.method === 'POST' && configApproval) {
        if (!requireApprovalToken(request, approvalToken)) return json(response, 403, { error: 'APPROVAL_AUTH_REQUIRED', message: 'separate approval token required' });
        const proposal = configProposals.get(configApproval[1]);
        if (!proposal) return json(response, 404, { error: 'CONFIG_PROPOSAL_NOT_FOUND', message: 'config proposal not found' });
        const input = await bodyOf(request);
        if (input.actionHash !== proposal.action.actionHash) throw new ConfigError('CONFIG_ACTION_HASH_MISMATCH', 'approval must bind the current config action hash');
        const approved = transition(proposal.action, 'approved', { expectedHash: proposal.action.actionHash });
        if (effectiveAudit) await effectiveAudit.append({ type: 'config.approved', actor: 'user', actionId: approved.id, sessionId: approved.sessionId, actionHash: approved.actionHash, operation: proposal.config.operation });
        try {
          const result = proposal.config.operation === 'import'
            ? await importConfig({ root, relativePath: proposal.config.relativePath, expectedHash: proposal.config.expectedHash, content: proposal.config.content })
            : await rollbackConfig({ root, relativePath: proposal.config.relativePath, backupId: proposal.config.backupId, expectedHash: proposal.config.expectedHash });
          const verified = transition(transition(approved, 'executing'), 'verified');
          configProposals.delete(proposal.action.id);
          if (effectiveAudit) await effectiveAudit.append({ type: 'config.verified', actor: 'system', actionId: verified.id, sessionId: verified.sessionId, actionHash: verified.actionHash, operation: proposal.config.operation, beforeHash: result.beforeHash, afterHash: result.afterHash, backupId: result.backupId ?? null });
          const { backupPath: _backupPath, ...publicResult } = result;
          return json(response, 200, { action: verified, config: publicResult });
        } catch (error) {
          configProposals.delete(proposal.action.id);
          if (effectiveAudit) await effectiveAudit.append({ type: 'config.failed', actor: 'system', actionId: proposal.action.id, sessionId: proposal.action.sessionId, actionHash: proposal.action.actionHash, operation: proposal.config.operation, code: error.code ?? 'CONFIG_FAILED' });
          throw error;
        }
      }
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
      if (request.method === 'GET' && url.pathname === '/v1/audit') {
        const records = typeof effectiveAudit?.list === 'function' ? await effectiveAudit.list() : [];
        const limit = Math.min(500, singleQueryInteger(url.searchParams, 'limit', 100));
        return json(response, 200, { events: (limit === 0 ? [] : records.slice(-limit)).map(publicAuditEvent) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/recovery') {
        const manifests = await scanPendingTransactions({ root, tolerateInvalid: true });
        const transactions = [];
        for (const manifest of manifests) {
          if (manifest.invalid) {
            transactions.push({ transactionId: manifest.transactionId, state: manifest.state, decision: 'blocked', reason: manifest.invalid.code, invalid: manifest.invalid });
            continue;
          }
          try {
            const report = await inspectPendingTransaction({ root, manifest });
            const decision = decideRecovery(report);
            transactions.push({ transactionId: manifest.transactionId, state: manifest.state, decision: decision.decision, reason: decision.reason ?? null, states: decision.states, report });
          } catch (error) {
            transactions.push({ transactionId: manifest.transactionId, state: manifest.state, decision: 'blocked', reason: error.code ?? 'RECOVERY_INSPECTION_FAILED', invalid: { code: error.code ?? 'RECOVERY_INSPECTION_FAILED', message: String(error.message ?? 'recovery inspection failed').slice(0, 512) } });
          }
        }
        return json(response, 200, { transactions });
      }
      if (request.method === 'GET' && url.pathname === '/v1/commands') {
        const sessionId = url.searchParams.get('sessionId');
        const actionHash = url.searchParams.get('actionHash');
        const records = await scanCommandLedger({ root });
        const storedCommands = proposalStore.list().filter((record) => record.proposal.action.type === 'command').map((record) => ({
          actionId: record.proposal.action.id,
          actionHash: record.proposal.action.actionHash,
          sessionId: record.proposal.action.sessionId,
          status: record.proposal.action.status,
          command: record.proposal.command,
          ...(record.recovery ? { error: { code: 'PROPOSAL_MANUAL_REVIEW', message: record.recovery.reason } } : {})
        }));
        const mergedCommands = [...records, ...storedCommands.filter((stored) => !records.some((record) => record.actionHash === stored.actionHash))];
        return json(response, 200, { commands: mergedCommands
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
        const proposal = await createCodeToolProposal({ mode: session.mode, tool: input.tool, input: { ...input.input, sessionId: session.id }, root, audit: effectiveAudit });
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
        const proposal = await createPatchProposal({ ...input, root, audit: effectiveAudit, currentRevision: await currentWorkspaceRevision() });
        proposals.set(proposal.action.id, proposal);
        proposalStore.put(proposal);
        eventBus.publish({ type: 'proposal.created', sessionId: proposal.action.sessionId, actionId: proposal.action.id, requestId, data: { actionType: proposal.action.type, status: proposal.action.status } });
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/proposals/command') {
        const input = await bodyOf(request);
        const proposal = await createCommandProposal({ ...input, root, audit: effectiveAudit, currentRevision: await currentWorkspaceRevision() });
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
          await __testHooks?.onProposalClaimed?.(claim);
          const result = proposal.command
            ? await approveAndRunCommand({ proposal: claim.proposal, root, approved: true, audit: effectiveAudit, getCurrentRevision: currentWorkspaceRevision })
            : await approveAndApplyPatch({ proposal: claim.proposal, root, approved: true, audit: effectiveAudit, getCurrentRevision: currentWorkspaceRevision });
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
        if (effectiveAudit) await effectiveAudit.append({ type: `action.${verb}`, actor: 'user', actionId: action.id, sessionId: action.sessionId, actionHash: action.actionHash });
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
      await runtime.close();
      for (const stream of liveStreams) stream.end();
      liveStreams.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}
