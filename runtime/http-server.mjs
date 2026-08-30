import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startWorkbench } from './index.mjs';
import { createPatchProposal, approveAndApplyPatch, createCommandProposal, approveAndRunCommand, WorkflowError } from './workflow.mjs';

const MAX_BODY_BYTES = 256 * 1024;

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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('request body must be valid JSON'); error.code = 'INVALID_JSON'; throw error; }
}

function errorResponse(error) {
  if (error instanceof WorkflowError) return { status: error.code === 'APPROVAL_REQUIRED' ? 403 : 400, body: { error: error.code, message: error.message, details: error.details } };
  return { status: error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'INVALID_JSON' ? 400 : 500, body: { error: error.code ?? 'INTERNAL_ERROR', message: error.message } };
}

function requireToken(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function publicProposal(proposal) {
  return { action: proposal.action, command: proposal.command, parsedPatch: proposal.parsedPatch, workspaceRevision: proposal.workspaceRevision, policy: proposal.policy, commandPolicy: proposal.commandPolicy };
}

export function createWorkbenchServer({ root, audit, token, host = '127.0.0.1', port = 0 } = {}) {
  if (!root) throw new Error('root is required');
  const proposals = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    const requestId = request.headers['x-request-id'] ?? randomUUID();
    response.setHeader('x-request-id', requestId);
    try {
      if (!requireToken(request, token)) return json(response, 401, { error: 'UNAUTHORIZED', message: 'bearer token required' });
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, service: 'openclaw-workbench' });
      if (request.method === 'GET' && url.pathname === '/v1/status') return json(response, 200, { ...(await startWorkbench({ root, audit })), root });
      if (request.method === 'POST' && url.pathname === '/v1/proposals/patch') {
        const input = await bodyOf(request);
        const proposal = await createPatchProposal({ ...input, root, audit });
        proposals.set(proposal.action.id, proposal);
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/proposals/command') {
        const input = await bodyOf(request);
        const proposal = createCommandProposal({ ...input, root, audit });
        proposals.set(proposal.action.id, proposal);
        return json(response, 201, { proposal: publicProposal(proposal) });
      }
      const approval = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approval) {
        const proposal = proposals.get(approval[1]);
        if (!proposal) return json(response, 404, { error: 'PROPOSAL_NOT_FOUND', message: 'proposal not found' });
        const input = await bodyOf(request);
        if (proposal.command) {
          const result = await approveAndRunCommand({ proposal, ...input, root, approved: true, audit });
          return json(response, 200, result);
        }
        const result = await approveAndApplyPatch({ proposal, ...input, root, approved: true, audit });
        return json(response, 200, result);
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
