import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repoRoot, 'desktop', 'frontend');

test('desktop MCP panel exposes list, proposal entries, and re-enable notice without sensitive fields', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  for (const marker of [
    'mcp-title', 'refresh-mcp', 'mcp-state', 'mcp-list', 'mcp-feedback',
    'mcp-proposal', 'mcp-proposal-summary', 'approve-mcp', 'deny-mcp', 'cancel-mcp',
    'mcp-update-form', 'mcp-update-target', 'mcp-update-name', 'submit-mcp-update',
    'mcp-update-transport', 'mcp-update-command', 'mcp-update-args', 'mcp-update-endpoint',
    'mcp-update-envkeys', 'mcp-update-tools', 'mcp-update-perm-fs', 'mcp-update-perm-net'
  ]) assert.match(html, new RegExp(`id="${marker}"`), `missing ${marker}`);
  for (const endpoint of ['/v1/mcp/servers', '/v1/mcp/runtimes', '/tools', '/update', '/remove', '/approve']) {
    assert.ok(app.includes(endpoint), `missing ${endpoint}`);
  }
  // Deny/cancel reach the server as the verb of the shared reject helper.
  assert.ok(app.includes("rejectMcpProposal('deny')") && app.includes("rejectMcpProposal('cancel')"), 'missing deny/cancel proposal actions');
  // Enable/disable reach the server only as proposal submissions built
  // from the action name, never as literal direct-effect routes.
  assert.ok(app.includes("action === 'enable'") && app.includes("action === 'disable'"), 'missing enable/disable proposal actions');
  assert.match(html, /列出不等于授权/);
  assert.match(html, /拒绝\/撤销的提案不得再被批准/);
  assert.match(app, /批准后需重新启用/);
  assert.match(app, /renderMcpProposal\(result\.proposal\)/);
  assert.match(app, /escapeHtml\(server\.name/);
  // Boundary, narrowed by the full-config editor: the LIST renderer must
  // never interpolate transport details, but the editor may read them
  // into form inputs for a new proposal. The proposal summary must never
  // carry them either (it shows only target name/id and status).
  assert.doesNotMatch(app, /proposal\.server\.(command|args|envKeys|endpoint)/);
  // No direct-effect MCP route: start/stop/call never appear as desktop
  // MCP actions. Enable/disable appear only as proposal submissions
  // (approval=false on submit; approval=true only on approve/deny/cancel
  // of the resulting proposal action id).
  assert.doesNotMatch(app, /\/v1\/mcp\/servers\/.*\/(start|stop|call)/);
  assert.match(app, /rejectMcpProposal/);
});

test('MCP list hides config material, update/remove stay proposals, and hash drift shows stale', async () => {
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  const elements = new Map();
  class FakeElement {
    constructor() { this.listeners = new Map(); this.dataset = {}; this.classList = { add() {}, toggle() {} }; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.className = ''; this.disabled = false; this.hidden = false; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute() {}
    focus() {}
  }
  const document = { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new FakeElement()); return elements.get(selector); } };
  const requests = [];
  let phase = 0;
  const serverV1 = { id: 'srv-a', name: 'Alpha', enabled: true, health: { status: 'ready' }, tools: ['read_file'], configHash: 'hash-1', command: '/bin/secret-cmd', args: ['--api-key', 'SECRET-VALUE'], envKeys: ['API_KEY'], endpoint: 'https://secret.example/x' };
  const serverV2 = { id: 'srv-a', name: 'Alpha New', enabled: false, health: { status: 'unknown' }, tools: ['read_file'], configHash: 'hash-2', command: '/bin/secret-cmd', args: ['--api-key', 'SECRET-VALUE'], envKeys: ['API_KEY'], endpoint: 'https://secret.example/x' };
  const window = {
    localStorage: { getItem: () => '', setItem: () => {} },
    __TAURI__: { core: { invoke: async (command, args) => {
      if (command === 'runtime_status') return { state: 'stopped' };
      const request = args.request;
      requests.push(request);
      const result = (status, body) => ({ status, body });
      if (request.method === 'GET' && request.path === '/v1/mcp/servers') return result(200, { servers: [phase === 0 ? serverV1 : serverV2] });
      if (request.method === 'GET' && request.path === '/v1/mcp/runtimes') return result(200, { runtimes: [] });
      if (request.method === 'GET' && request.path === '/v1/mcp/servers/srv-a/tools') {
        return phase === 0 ? result(200, { id: 'srv-a', tools: [{ name: 'read_file', authorized: true }, { name: 'exec', authorized: false }] }) : result(409, { error: 'MCP_NOT_RUNNING' });
      }
      if (request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/update') {
        return result(201, { proposal: { action: { id: 'upd-action', actionHash: 'upd-hash', status: 'awaiting_approval', type: 'mcp.update' }, server: { id: 'srv-a', name: 'Alpha New', command: '/bin/secret-cmd' }, operation: 'update' } });
      }
      if (request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/remove') {
        return result(201, { proposal: { action: { id: 'rm-action', actionHash: 'rm-hash', status: 'awaiting_approval', type: 'mcp.remove' }, server: { id: 'srv-a', name: 'Alpha New' }, operation: 'remove' } });
      }
      if (request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/enable') {
        if (request.approval !== false) throw new Error('enable submission must be a proposal, not an approval');
        return result(201, { proposal: { action: { id: 'en-action', actionHash: 'en-hash', status: 'awaiting_approval', type: 'mcp.set_enabled' }, server: { id: 'srv-a', name: 'Alpha New' }, operation: 'set_enabled' } });
      }
      if (request.method === 'POST' && (request.path.endsWith('/deny') || request.path.endsWith('/cancel'))) {
        if (request.approval !== true) throw new Error('approval token required');
        return result(200, { action: { id: 'denied', status: request.path.endsWith('/deny') ? 'denied' : 'cancelled' } });
      }
      if (request.method === 'POST' && request.path.endsWith('/approve')) {
        if (request.approval !== true) throw new Error('approval token required');
        phase = 1;
        return result(200, { action: { id: 'verified', status: 'verified' } });
      }
      throw new Error(`unexpected runtime request: ${request.method} ${request.path}`);
    } } },
  };
  const context = vm.createContext({ document, window, URL, console: { log() {}, error() {} } });
  vm.runInContext(app, context);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  // Let the load-time refreshRuntime settle while wasReady is still false;
  // otherwise it would later observe the test's runtimeReady=true alongside
  // a stale 'stopped' status and clear the panel mid-test.
  await flush();
  vm.runInContext('runtimeReady = true;', context);
  const listHtml = () => elements.get('#mcp-list').innerHTML;

  // Rendering a record that carries config material must not leak it.
  vm.runInContext(`renderMcpServers({ servers: [{ id: 'srv-a', name: 'Alpha', enabled: true, health: { status: 'ready' }, tools: ['read_file'], configHash: 'hash-1', command: '/bin/secret-cmd', args: ['--api-key', 'SECRET-VALUE'], envKeys: ['API_KEY'], endpoint: 'https://secret.example/x' }] })`, context);
  assert.match(listHtml(), /Alpha/);
  assert.match(listHtml(), /已启用/);
  assert.match(listHtml(), /read_file · 已授权/);
  for (const leaked of ['/bin/secret-cmd', '--api-key', 'SECRET-VALUE', 'API_KEY', 'secret.example']) {
    assert.equal(listHtml().includes(leaked), false, `rendered sensitive value: ${leaked}`);
  }

  // Refresh shows the live tool list with authorized markers.
  await vm.runInContext('refreshMcp()', context);
  assert.match(listHtml(), /read_file · 已授权/);
  assert.match(listHtml(), /exec · 未授权/);
  assert.ok(requests.some((request) => request.method === 'GET' && request.path === '/v1/mcp/servers'));
  assert.ok(requests.some((request) => request.method === 'GET' && request.path === '/v1/mcp/runtimes'));
  assert.ok(requests.some((request) => request.method === 'GET' && request.path === '/v1/mcp/servers/srv-a/tools'));

  // Update entry opens the full-config editor, prefilled from the record;
  // submitting only creates a proposal.
  const listClick = elements.get('#mcp-list').listeners.get('click');
  listClick({ target: { closest: (selector) => selector === '[data-mcp-action]' ? { dataset: { mcpAction: 'update', serverId: 'srv-a' }, disabled: false } : null } });
  assert.equal(elements.get('#mcp-update-form').hidden, false);
  assert.match(elements.get('#mcp-update-target').textContent, /Alpha/);
  assert.equal(elements.get('#mcp-update-name').value, 'Alpha');
  assert.equal(elements.get('#mcp-update-command').value, '/bin/secret-cmd');
  assert.equal(elements.get('#mcp-update-args').value, '--api-key\nSECRET-VALUE');
  assert.equal(elements.get('#mcp-update-envkeys').value, 'API_KEY');
  elements.get('#mcp-update-name').value = 'Alpha New';
  elements.get('#submit-mcp-update').listeners.get('click')();
  await flush();
  const updateRequest = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/update');
  assert.ok(updateRequest, 'update proposal was not submitted');
  assert.equal(updateRequest.body.sessionId, 'desktop-mcp');
  assert.equal(updateRequest.body.configHash, 'hash-1');
  assert.equal(updateRequest.body.server.name, 'Alpha New');
  assert.equal(updateRequest.approval, false);
  const summary = elements.get('#mcp-proposal-summary').textContent;
  assert.match(summary, /更新提案/);
  assert.match(summary, /Alpha New/);
  assert.match(summary, /批准后需重新启用/);
  assert.equal(summary.includes('/bin/secret-cmd'), false, 'proposal summary leaked config material');
  assert.equal(requests.some((request) => /\/start|\/stop|\/call/.test(request.path ?? '')), false, 'a direct-effect MCP route was called');

  // Approving the update refreshes to the disabled, hash-changed record:
  // the panel must show the stale instance notice and the re-enable prompt.
  await elements.get('#approve-mcp').listeners.get('click')();
  const approveUpdate = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/upd-action/approve');
  assert.ok(approveUpdate, 'update approval was not submitted');
  assert.equal(approveUpdate.approval, true);
  assert.equal(approveUpdate.body.actionHash, 'upd-hash');
  assert.match(elements.get('#mcp-feedback').textContent, /需重新启用/);
  assert.match(listHtml(), /未启用/);
  assert.match(listHtml(), /配置已变化，旧实例已失效，需重新启用/);

  // Remove likewise stays a proposal until independent approval.
  listClick({ target: { closest: (selector) => selector === '[data-mcp-action]' ? { dataset: { mcpAction: 'remove', serverId: 'srv-a' }, disabled: false } : null } });
  await flush();
  const removeRequest = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/remove');
  assert.ok(removeRequest, 'remove proposal was not submitted');
  assert.equal(removeRequest.body.configHash, 'hash-2');
  assert.match(elements.get('#mcp-proposal-summary').textContent, /移除提案/);
  assert.match(elements.get('#mcp-feedback').textContent, /批准前服务器保持原状/);
  await elements.get('#approve-mcp').listeners.get('click')();
  const approveRemove = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/rm-action/approve');
  assert.ok(approveRemove, 'remove approval was not submitted');
  assert.equal(approveRemove.approval, true);
  assert.match(elements.get('#mcp-feedback').textContent, /MCP 变更已批准/);

  // Re-enable entry after the update approval: submitting an enable
  // proposal (approval=false), then denying it (approval=true + hash).
  // A denied proposal is cleared, so it cannot be approved afterwards.
  listClick({ target: { closest: (selector) => selector === '[data-mcp-action]' ? { dataset: { mcpAction: 'enable', serverId: 'srv-a' }, disabled: false } : null } });
  await flush();
  const enableRequest = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/srv-a/enable');
  assert.ok(enableRequest, 'enable proposal was not submitted');
  assert.equal(enableRequest.approval, false);
  assert.equal(enableRequest.body.configHash, 'hash-2');
  assert.match(elements.get('#mcp-feedback').textContent, /启用提案已提交/);
  elements.get('#deny-mcp').listeners.get('click')();
  await flush();
  const denyRequest = requests.find((request) => request.method === 'POST' && request.path === '/v1/mcp/servers/en-action/deny');
  assert.ok(denyRequest, 'deny was not submitted');
  assert.equal(denyRequest.approval, true);
  assert.equal(denyRequest.body.actionHash, 'en-hash');
  assert.match(elements.get('#mcp-feedback').textContent, /已拒绝，不会执行/);
  assert.equal(elements.get('#mcp-proposal').hidden, true);
});
