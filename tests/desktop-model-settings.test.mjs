import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repoRoot, 'desktop', 'frontend');

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.dataset = {};
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.tabIndex = 0;
    this.attributes = {};
    this.handlers = new Map();
    this.classList = { add: (value) => { this.className += ` ${value}`; } };
  }

  addEventListener(name, handler) { this.handlers.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  click(event = {}) { return this.handlers.get('click')?.({ preventDefault() {}, ...event }); }
  change(event = {}) { return this.handlers.get('change')?.(event); }
}

test('desktop model setup stores the key separately and gates registration and enablement behind approval', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  for (const marker of ['model-id', 'model-provider', 'model-endpoint', 'model-name', 'model-api-key', 'save-model', 'model-profile-picker', 'model-profile-list', 'model-proposal', 'approve-model', 'enable-model', 'test-model']) {
    assert.match(html, new RegExp(`id="${marker}"`), `missing ${marker}`);
  }
  assert.match(html, /type="password"[^>]*id="model-api-key"|id="model-api-key"[^>]*type="password"/);
  assert.match(app, /runtime_request/);

  const elements = new Map();
  const document = {
    querySelector(selector) {
      const id = selector.replace(/^#/, '');
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  const storage = new Map();
  const calls = [];
  let profile = null;
  let pendingProposal = null;
  let health = { status: 'unknown' };
  const invoke = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'runtime_status') return { state: 'ready', workspace: 'C:\\Projects\\demo', address: 'http://127.0.0.1:4312' };
    if (command !== 'runtime_request') throw new Error(`unexpected command: ${command}`);
    const request = args.request;
    const result = (status, body) => ({ status, body });
    if (request.method === 'GET' && request.path === '/v1/models') return result(200, { models: profile ? [{ ...profile, health }] : [] });
    if (request.method === 'POST' && request.path === '/v1/secrets') return result(200, { configured: true });
    if (request.method === 'POST' && request.path === '/v1/models') {
      pendingProposal = { action: { id: 'register-action', actionHash: 'register-hash', type: 'model.register', preview: { id: 'primary', provider: 'Example', protocol: 'openai-compatible', model: 'demo', endpoint: 'https://provider.example/v1', capabilities: ['text', 'tool_calling'], secretRef: 'keychain:workbench.model.primary' } } };
      return result(201, { proposal: pendingProposal });
    }
    if (request.method === 'POST' && request.path === '/v1/models/register-action/approve') {
      profile = { id: 'primary', provider: 'Example', model: 'demo', endpoint: 'https://provider.example/v1', secretRef: 'keychain:workbench.model.primary', enabled: false, configHash: 'profile-hash' };
      pendingProposal = null;
      return result(200, { profile });
    }
    if (request.method === 'POST' && request.path === '/v1/models/primary/enable') {
      pendingProposal = { action: { id: 'enable-action', actionHash: 'enable-hash', type: 'model.set_enabled', preview: { profileId: 'primary', enabled: true } } };
      return result(201, { proposal: pendingProposal });
    }
    if (request.method === 'POST' && request.path === '/v1/models/enable-action/approve') {
      profile = { ...profile, enabled: true, configHash: 'enabled-hash' };
      pendingProposal = null;
      return result(200, { profile });
    }
    if (request.method === 'POST' && request.path === '/v1/models/primary/health') {
      health = { status: 'ready', checkedAt: '2026-10-08T00:00:00.000Z' };
      return result(200, { profile, health });
    }
    throw new Error(`unexpected runtime request: ${request.method} ${request.path}`);
  };
  const window = {
    __TAURI__: { core: { invoke }, dialog: { open: async () => null } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  const source = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  vm.runInNewContext(source, { window, document, URL, console: { log() {}, error() {} } });
  await new Promise((resolve) => setImmediate(resolve));

  document.querySelector('#model-id').value = 'primary';
  document.querySelector('#model-provider').value = 'Example';
  document.querySelector('#model-endpoint').value = 'https://provider.example/v1';
  document.querySelector('#model-name').value = 'demo';
  document.querySelector('#model-api-key').value = 'secret-model-key-123';
  await document.querySelector('#save-model').click();

  const secretWrite = calls.find(({ args }) => args.request?.path === '/v1/secrets');
  const profileCreate = calls.find(({ args }) => args.request?.path === '/v1/models' && args.request?.method === 'POST');
  assert.equal(secretWrite.args.request.body.value, 'secret-model-key-123');
  assert.equal(profileCreate.args.request.body.secretRef, 'keychain:workbench.model.primary');
  assert.equal(JSON.stringify(profileCreate.args.request.body).includes('secret-model-key-123'), false);
  assert.equal(document.querySelector('#model-api-key').value, '');
  assert.equal([...storage.values()].some((value) => String(value).includes('secret-model-key-123')), false);
  assert.equal(document.querySelector('#save-model').disabled, true);
  assert.equal(document.querySelector('#enable-model').disabled, true);
  assert.equal(document.querySelector('#test-model').disabled, true);
  assert.match(document.querySelector('#model-proposal-summary').textContent, /primary|provider\.example|openai-compatible|tool_calling/);
  assert.doesNotMatch(document.querySelector('#model-proposal-summary').textContent, /secret-model-key-123/);

  await document.querySelector('#approve-model').click();
  await document.querySelector('#enable-model').click();
  await document.querySelector('#approve-model').click();
  await document.querySelector('#test-model').click();

  const protectedCalls = calls.filter(({ args }) => {
    const request = args.request;
    return request?.path?.endsWith('/approve') || request?.path?.endsWith('/health');
  });
  assert.equal(protectedCalls.length, 3);
  assert.ok(protectedCalls.every(({ args }) => args.request.approval === true));
  assert.match(document.querySelector('#model-profile-list').textContent, /ready|已连接/i);
  assert.equal(pendingProposal, null);

  const beforeDuplicate = calls.length;
  document.querySelector('#model-id').value = 'primary';
  document.querySelector('#model-api-key').value = 'replacement-key-456';
  await document.querySelector('#save-model').click();
  assert.equal(calls.length, beforeDuplicate, 'duplicate IDs must be blocked before sending a secret');
  assert.match(document.querySelector('#model-feedback').textContent, /已存在/);
  assert.equal(document.querySelector('#model-api-key').value, '');
  assert.equal([...elements.values()].some((element) => `${element.textContent}\n${element.innerHTML}`.includes('secret-model-key-123')), false);
});
