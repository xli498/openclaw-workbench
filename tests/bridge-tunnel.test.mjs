import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeTunnelAdapter } from '../runtime/bridge-tunnel.mjs';

const TOKEN = 'bridge-bearer-token-012345';
function fakeChild() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.emit('exit', 0); child.emit('close', 0); }; return child; }
function setup() { const children = []; const calls = []; const adapter = createBridgeTunnelAdapter({ provider: 'cloudflare-quick', command: 'cloudflared', args: ['tunnel', '--url'], localPort: 43123, token: TOKEN, startTimeoutMs: 100, spawnImpl: (command, args, options) => { calls.push({ command, args, options }); const child = fakeChild(); children.push(child); queueMicrotask(() => child.stdout.emit('data', '2026-01-01 https://random.example.trycloudflare.com\n')); return child; }, parsePublicUrl: (line) => line.match(/https:\/\/[^\s]+/)?.[0] }); return { adapter, calls, children }; }

test('tunnel adapter starts a controlled provider with bearer env, random route, and redacted public state', async () => {
  const { adapter, calls } = setup();
  const result = await adapter.start();
  assert.equal(result.state, 'ready');
  assert.match(result.endpoint, /^https:\/\/random\.example\.trycloudflare\.com\/[A-Za-z0-9_-]{24}$/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.OCW_BRIDGE_BEARER, TOKEN);
  assert.equal(calls[0].args.some((arg) => arg.includes(TOKEN)), false);
  assert.equal(JSON.stringify(adapter.status()).includes('https://'), false);
  assert.deepEqual(adapter.authHeaders(), { authorization: `Bearer ${TOKEN}` });
  await adapter.stop();
});

test('reset invalidates the old route and starts a fresh route', async () => {
  const { adapter } = setup();
  const first = await adapter.start();
  const oldRoute = first.endpoint;
  await adapter.reset();
  assert.equal(adapter.status().state, 'idle');
  const second = await adapter.start();
  assert.notEqual(second.endpoint, oldRoute);
  await adapter.stop();
});

test('invalid provider, shell command, and missing parser are rejected', () => {
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok-fixed', command: 'ngrok', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_PROVIDER_INVALID' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok', command: 'ngrok & whoami', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_COMMAND_INVALID' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok', command: 'ngrok', localPort: 1, token: TOKEN }), { code: 'TUNNEL_URL_PARSER_REQUIRED' });
});
