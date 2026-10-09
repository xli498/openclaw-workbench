import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeTunnelAdapter } from '../runtime/bridge-tunnel.mjs';

const TOKEN = 'bridge-bearer-token-012345';
function fakeChild() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.emit('exit', 0); child.emit('close', 0); }; return child; }
function setup() { const children = []; const calls = []; const adapter = createBridgeTunnelAdapter({ provider: 'cloudflare-quick', command: 'cloudflared', args: ['tunnel', '--url'], localPort: 43123, token: TOKEN, startTimeoutMs: 100, spawnImpl: (command, args, options) => { calls.push({ command, args, options }); const child = fakeChild(); children.push(child); queueMicrotask(() => child.stdout.emit('data', '2026-01-01 https://random.example.trycloudflare.com\n')); return child; }, parsePublicUrl: (line) => line.match(/https:\/\/[^\s]+/)?.[0] }); return { adapter, calls, children }; }
function providerSetup(overrides = {}) { const calls = []; const { publicUrl = 'https://public.example.test', ...adapterOverrides } = overrides; const adapter = createBridgeTunnelAdapter({ provider: 'cloudflare-named', command: 'cloudflared', localPort: 43123, token: TOKEN, tunnelName: 'home-workbench', startTimeoutMs: 100, spawnImpl: (command, args, options) => { calls.push({ command, args, options }); const child = fakeChild(); queueMicrotask(() => child.stdout.emit('data', `${publicUrl}\n`)); return child; }, parsePublicUrl: (line) => line.match(/https:\/\/[^\s]+/)?.[0], ...adapterOverrides }); return { adapter, calls }; }

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
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok-fixed-other', command: 'ngrok', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_PROVIDER_INVALID' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok', command: 'ngrok & whoami', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_COMMAND_INVALID' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok', command: 'ngrok', localPort: 1, token: TOKEN }), { code: 'TUNNEL_URL_PARSER_REQUIRED' });
});

test('Cloudflare Named Tunnel requires a safe name and uses the named run command', async () => {
  const { adapter, calls } = providerSetup();
  const result = await adapter.start();
  assert.equal(result.state, 'ready');
  assert.deepEqual(calls[0].args.slice(0, 3), ['tunnel', 'run', 'home-workbench']);
  assert.equal(calls[0].args.some((arg) => arg.includes(TOKEN)), false);
  await adapter.stop();
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'cloudflare-named', command: 'cloudflared', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_NAME_REQUIRED' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'cloudflare-named', command: 'cloudflared', tunnelName: '../escape', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_NAME_INVALID' });
});

test('ngrok fixed-domain mode validates the hostname and binds it after the HTTP subcommand', async () => {
  const { adapter, calls } = providerSetup({ provider: 'ngrok-fixed', command: 'ngrok', hostname: 'workbench.example.com', tunnelName: undefined, publicUrl: 'https://workbench.example.com' });
  const result = await adapter.start();
  assert.equal(result.state, 'ready');
  assert.deepEqual(calls[0].args.slice(0, 4), ['http', '--domain', 'workbench.example.com', '127.0.0.1:43123']);
  assert.equal(calls[0].args[3], '127.0.0.1:43123');
  await adapter.stop();
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok-fixed', command: 'ngrok', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_HOSTNAME_REQUIRED' });
  assert.throws(() => createBridgeTunnelAdapter({ provider: 'ngrok-fixed', command: 'ngrok', hostname: 'https://evil.test', localPort: 1, token: TOKEN, parsePublicUrl() {} }), { code: 'TUNNEL_HOSTNAME_INVALID' });
});

test('ngrok fixed-domain mode rejects a provider URL that does not match the configured hostname', async () => {
  const { adapter } = providerSetup({ provider: 'ngrok-fixed', command: 'ngrok', hostname: 'workbench.example.com', tunnelName: undefined, publicUrl: 'https://other.example.com' });
  await assert.rejects(() => adapter.start(), { code: 'TUNNEL_URL_TIMEOUT' });
});

test('ngrok ephemeral mode uses the ngrok HTTP subcommand and local target', async () => {
  const { adapter, calls } = providerSetup({ provider: 'ngrok', command: 'ngrok', tunnelName: undefined, publicUrl: 'https://random.ngrok.app' });
  const result = await adapter.start();
  assert.equal(result.state, 'ready');
  assert.deepEqual(calls[0].args.slice(0, 2), ['http', '127.0.0.1:43123']);
  await adapter.stop();
});

test('provider list exposes all explicit tunnel variants', async () => {
  const { BRIDGE_TUNNEL_PROVIDERS } = await import('../runtime/bridge-tunnel.mjs');
  assert.deepEqual([...BRIDGE_TUNNEL_PROVIDERS].sort(), ['cloudflare-named', 'cloudflare-quick', 'ngrok', 'ngrok-fixed']);
});
