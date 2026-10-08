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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.attributes = {};
    this.handlers = new Map();
    this.classList = {
      add: (value) => { this.className += ` ${value}`; },
      remove: (value) => { this.className = this.className.split(/\s+/).filter((item) => item && item !== value).join(' '); },
    };
  }

  addEventListener(name, handler) { this.handlers.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  click(event = {}) { return this.handlers.get('click')?.({ preventDefault() {}, ...event }); }
  dispatch(name, event = {}) { return this.handlers.get(name)?.({ preventDefault() {}, ...event }); }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('desktop Ask workbench uses the Tauri runtime_request bridge for a read-only session flow', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  for (const marker of ['ask-runtime-warning', 'ask-session-select', 'new-ask-session', 'ask-messages', 'ask-message-form', 'ask-message-input', 'send-ask-message', 'ask-mode-state']) {
    assert.match(html, new RegExp(`id="${marker}"`), `missing ${marker}`);
  }
  assert.match(app, /runtime_request/);
  assert.match(app, /POST', '\/v1\/sessions'/);
  assert.match(app, /\/v1\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/messages/);
  assert.match(app, /mode: 'Ask'/);
  assert.doesNotMatch(app, /ask.*\/v1\/proposals/i, 'Ask UI must not create proposals');
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*token/i);

  const elements = new Map();
  const document = {
    querySelector(selector) {
      const id = selector.replace(/^#/, '');
      if (!elements.has(id)) elements.set(id, new Element(id));
      return elements.get(id);
    },
  };
  const storage = new Map();
  const calls = [];
  const sessions = [];
  const messages = new Map();
  let nextSession = 1;
  const invoke = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'runtime_status') return { state: 'ready', workspace: 'C:\\Projects\\demo', address: 'http://127.0.0.1:4312' };
    if (command !== 'runtime_request') throw new Error(`unexpected command: ${command}`);
    const request = args.request;
    const result = (status, body) => ({ status, body });
    if (request.method === 'GET' && request.path === '/v1/models') return result(200, { models: [] });
    if (request.method === 'GET' && request.path === '/v1/sessions') return result(200, { sessions });
    if (request.method === 'POST' && request.path === '/v1/sessions') {
      const session = { id: `ask-${nextSession++}`, mode: request.body.mode, actor: request.body.actor, status: 'active', createdAt: '2026-10-09T00:00:00.000Z', messageCount: 0 };
      sessions.push(session);
      messages.set(session.id, []);
      return result(201, { session });
    }
    const messagePath = request.path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messagePath && request.method === 'GET') return result(200, { messages: messages.get(messagePath[1]) ?? [] });
    if (messagePath && request.method === 'POST') {
      const history = messages.get(messagePath[1]);
      history.push({ role: 'user', content: request.body.message, createdAt: '2026-10-09T00:00:01.000Z' });
      history.push({ role: 'assistant', content: { text: '已完成只读检查，没有创建提案。' }, createdAt: '2026-10-09T00:00:02.000Z' });
      const session = sessions.find((item) => item.id === messagePath[1]);
      session.messageCount = history.length;
      return result(200, { session, message: history.at(-1) });
    }
    throw new Error(`unexpected runtime request: ${request.method} ${request.path}`);
  };

  const window = {
    __TAURI__: { core: { invoke }, dialog: { open: async () => null } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  const source = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  vm.runInNewContext(source, { window, document, URL, console: { log() {}, error() {} } });
  await settle();

  assert.equal(elements.get('ask-runtime-warning').hidden, true);
  assert.equal(elements.get('new-ask-session').disabled, false);
  assert.equal(elements.get('ask-session-status').textContent, '暂无 Ask 会话');

  await elements.get('new-ask-session').click();
  await settle();
  assert.equal(sessions.length, 1);
  assert.equal(elements.get('ask-session-select').value, 'ask-1');
  assert.equal(elements.get('ask-message-input').disabled, false);
  assert.match(elements.get('ask-session-status').textContent, /0 条消息/);

  elements.get('ask-message-input').value = '请阅读当前项目并总结主要风险';
  await elements.get('ask-message-form').dispatch('submit');
  await settle();
  assert.match(elements.get('ask-messages').innerHTML, /请阅读当前项目/);
  assert.match(elements.get('ask-messages').innerHTML, /已完成只读检查/);
  assert.match(elements.get('ask-feedback').textContent, /未创建修改提案/);
  const messageCall = calls.find(({ args }) => args.request?.method === 'POST' && /\/messages$/.test(args.request.path));
  assert.equal(messageCall.args.request.body.message, '请阅读当前项目并总结主要风险');
  assert.equal(Object.hasOwn(messageCall.args.request.body, 'approval'), false);
  assert.equal(calls.some(({ args }) => /\/v1\/proposals/.test(args.request?.path ?? '')), false);
  assert.equal([...storage.values()].some((value) => String(value).toLowerCase().includes('token')), false);
});

test('desktop Ask workbench makes the Runtime-not-started state actionable', async () => {
  const source = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  assert.match(source, /Runtime 未启动/);
  assert.match(source, /先启动 Runtime/);
  assert.match(source, /askRuntimeWarning\.hidden = runtimeReady/);
});
