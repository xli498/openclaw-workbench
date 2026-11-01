import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repoRoot, 'desktop', 'frontend');

test('desktop operations panel exposes diagnostics, recovery, audit, and persisted status', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  for (const marker of [
    'refresh-operations', 'diagnostics-list', 'recovery-list',
    'audit-list', 'status-list', 'operations-feedback'
  ]) assert.match(html, new RegExp(`id="${marker}"`), `missing ${marker}`);
  for (const endpoint of ['/v1/status', '/v1/diagnostics', '/v1/recovery', '/v1/audit?limit=50']) {
    assert.match(app, new RegExp(endpoint.replace(/[.?]/g, '\\$&')), `missing ${endpoint}`);
  }
  assert.match(app, /Promise\.all\(\[/);
  assert.match(app, /renderDiagnostics\(diagnostics\)/);
  assert.match(app, /renderRecovery\(recovery\)/);
  assert.match(app, /renderAudit\(audit\)/);
  assert.match(app, /renderStatus\(status\)/);
  assert.match(app, /重启后未完成动作不会自动重放/);
  assert.match(app, /\/v1\/recovery\//);
  assert.match(app, /\/proposals/);
  assert.match(app, /批准并执行恢复/);
  assert.match(app, /申请继续完成/);
  assert.match(app, /申请回滚/);
  assert.match(app, /relativePath/);
  assert.match(app, /modelRequest\('POST'.*true/);
  assert.match(app, /Runtime 未启动/);
});

test('recovery 显示更多可抵达并操作第 21 项事务', async () => {
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  const elements = new Map();
  const requests = [];
  class FakeElement {
    constructor() { this.listeners = new Map(); this.dataset = {}; this.classList = { add() {}, toggle() {} }; this.value = ''; this.disabled = false; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute() {}
    focus() {}
  }
  const document = { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new FakeElement()); return elements.get(selector); } };
  const window = {
    localStorage: { getItem: () => '', setItem: () => {} },
    __TAURI__: { core: { invoke: async (command, args) => {
      if (command === 'runtime_status') return { state: 'stopped' };
      const request = args.request;
      requests.push(request);
      const body = request.path === '/v1/recovery' ? { transactions: [] } : request.path === '/v1/audit?limit=50' ? { events: [] } : {};
      return { status: request.method === 'POST' ? 201 : 200, body };
    } } },
  };
  const context = vm.createContext({ document, window });
  vm.runInContext(app, context);
  vm.runInContext('runtimeReady = true;', context);
  context.transactions = Array.from({ length: 25 }, (_, index) => ({
    transactionId: `tx-${index + 1}`,
    state: 'committing',
    decision: 'requires_approval',
    canResume: true,
    canRollback: false,
    report: { files: [] },
  }));
  vm.runInContext('renderRecovery({ transactions })', context);
  const recoveryList = elements.get('#recovery-list');
  assert.equal(recoveryList.innerHTML.includes('tx-20'), true);
  assert.equal(recoveryList.innerHTML.includes('tx-21'), false);
  assert.match(recoveryList.innerHTML, /data-recovery-show-more/);

  const click = recoveryList.listeners.get('click');
  click({ target: { closest: (selector) => selector === '[data-recovery-show-more]' ? {} : null } });
  assert.equal(recoveryList.innerHTML.includes('tx-21'), true);
  const actionButton = { dataset: { recoveryAction: 'propose', transactionId: 'tx-21', recoveryMode: 'resume' }, disabled: false };
  click({ target: { closest: (selector) => selector === '[data-recovery-action]' ? actionButton : null } });
  assert.ok(requests.some((request) => request.method === 'POST' && request.path === '/v1/recovery/tx-21/proposals'));
});
