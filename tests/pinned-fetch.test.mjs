import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createPinnedLookup, createPinnedHttpsFetch } from '../runtime/pinned-fetch.mjs';

const fixtureKey = readFileSync(new URL('./fixtures/pinned-fetch-key.pem', import.meta.url));
const fixtureCertificate = readFileSync(new URL('./fixtures/pinned-fetch-cert.pem', import.meta.url));

async function listen(handler) {
  const server = https.createServer({ key: fixtureKey, cert: fixtureCertificate }, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

function localLookup(onCall) {
  const pinned = createPinnedLookup([{ address: '127.0.0.1', family: 4 }]);
  return (hostname, options, callback) => {
    onCall({ hostname, options });
    return pinned(hostname, options, callback);
  };
}

test('pinned HTTPS transport uses the checked address while preserving TLS SNI and response streaming', async () => {
  const server = await listen((request, response) => {
    const chunks = [];
    request.setEncoding('utf8');
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.host, `provider.test:${server.address().port}`);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.socket.servername, 'provider.test');
      assert.equal(request.url, '/stream?part=1');
      assert.equal(chunks.join(''), '{"probe":true}');
      response.writeHead(200, { 'content-type': 'text/plain', 'x-fixture': 'ok' });
      response.write('hello ');
      setTimeout(() => response.end('provider'), 10);
    });
  });
  try {
    const calls = [];
    const fetch = createPinnedHttpsFetch();
    const response = await fetch(`https://provider.test:${server.address().port}/stream?part=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"probe":true}',
      ca: fixtureCertificate,
      lookup: localLookup((call) => calls.push(call)),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fixture'), 'ok');
    assert.equal(await response.text(), 'hello provider');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, 'provider.test');
  } finally {
    await close(server);
  }
});

test('pinned HTTPS transport aborts an in-flight response body and rejects its Web reader', async () => {
  let connectionClosed;
  const closed = new Promise((resolve) => { connectionClosed = resolve; });
  const server = await listen((_request, response) => {
    response.on('close', connectionClosed);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first');
  });
  try {
    const controller = new AbortController();
    const fetch = createPinnedHttpsFetch();
    const result = await fetch(`https://provider.test:${server.address().port}/slow`, {
      ca: fixtureCertificate,
      lookup: localLookup(() => {}),
      signal: controller.signal,
    });
    const reader = result.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first');
    const pending = reader.read();
    controller.abort();
    await assert.rejects(() => pending, (error) => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('server response stayed open after abort')), 500))]);
  } finally {
    await close(server);
  }
});

test('pinned HTTPS transport rejects before headers when the request signal is aborted', async () => {
  const server = await listen((_request, response) => {
    setTimeout(() => response.end('late'), 200);
  });
  try {
    const controller = new AbortController();
    const fetch = createPinnedHttpsFetch();
    const request = fetch(`https://provider.test:${server.address().port}/late`, {
      ca: fixtureCertificate,
      lookup: localLookup(() => {}),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(() => request, (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  } finally {
    await close(server);
  }
});
