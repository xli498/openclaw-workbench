import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchServer } from '../runtime/http-server.mjs';
import { importConfig } from '../runtime/config-store.mjs';

const TOKEN = 'test-token-012345';
const APPROVAL = 'approve-token-012345';

async function request(address, pathname, options = {}) {
  const response = await fetch(`http://${address.address}:${address.port}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

test('红队攻击：配置写入请求不带审批只能创建提案且不修改文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-red-team-config-gap-'));
  await writeFile(path.join(root, 'openclaw.json'), '{"mode":"old"}\n');
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const response = await request(address, '/v1/config/import', { method: 'POST', body: JSON.stringify({ sessionId: 'red-team', relativePath: 'openclaw.json', expectedHash: '3c2d7f4c1d5a8e7e3f9f09ed7f76f3aaf0e9b1e1ebd8d5d1b6b5a31d89e2d7a1', content: '{"mode":"new"}\n' }) });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'CONFIG_CONFLICT');
    assert.equal(await readFile(path.join(root, 'openclaw.json'), 'utf8'), '{"mode":"old"}\n');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('红队基线：控制 token 不能替代 approval token 执行 Patch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-red-team-approval-'));
  await writeFile(path.join(root, 'README.md'), 'before\n');
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const created = await request(address, '/v1/proposals/patch', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'red-team', patch: '--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-before\n+after\n', declaredPaths: ['README.md'] }),
    });
    assert.equal(created.status, 201);
    const response = await request(address, `/v1/proposals/${created.body.proposal.action.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ actionHash: created.body.proposal.action.actionHash }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'APPROVAL_AUTH_REQUIRED');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('红队攻击：配置 actionHash 不能篡改或重放，审批凭据不能互换', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-red-team-replay-'));
  await writeFile(path.join(root, 'openclaw.json'), '{"mode":"old"}\n');
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    const current = await request(address, '/v1/config');
    const proposal = await request(address, '/v1/config/import', { method: 'POST', body: JSON.stringify({ sessionId: 'red-replay', expectedHash: current.body.config.hash, content: '{"mode":"new"}\n' }) });
    const swapped = await request(address, `/v1/config/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': TOKEN }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(swapped.status, 403);
    assert.equal(swapped.body.error, 'APPROVAL_AUTH_REQUIRED');
    const tampered = await request(address, `/v1/config/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: '0'.repeat(64) }) });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.error, 'CONFIG_ACTION_HASH_MISMATCH');
    const approved = await request(address, `/v1/config/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(approved.status, 200);
    const replay = await request(address, `/v1/config/${proposal.body.proposal.action.id}/approve`, { method: 'POST', headers: { 'x-approval-token': APPROVAL }, body: JSON.stringify({ actionHash: proposal.body.proposal.action.actionHash }) });
    assert.equal(replay.status, 404);
    assert.equal(JSON.stringify((await request(address, '/v1/audit')).body).includes('mode":"new'), false);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：配置路径穿越、绝对路径和备份伪造均被拒绝', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-red-team-paths-'));
  await writeFile(path.join(root, 'openclaw.json'), '{"mode":"old"}\n');
  const app = createWorkbenchServer({ root, token: TOKEN, approvalToken: APPROVAL });
  const address = await app.listen();
  try {
    for (const relativePath of ['../openclaw.json', 'C:/outside.json', '.openclaw-workbench/config.json', '.OpenClaw-Workbench/config.json', 'notes.txt']) {
      const response = await request(address, '/v1/config', { headers: {}, });
      assert.equal(response.status, 200);
      const proposal = await request(address, '/v1/config/import', { method: 'POST', body: JSON.stringify({ sessionId: 'red-path', relativePath, expectedHash: response.body.config.hash, content: '{}' }) });
      assert.equal(proposal.status, 400, relativePath);
      assert.equal(proposal.body.error, 'CONFIG_PATH_INVALID', relativePath);
    }
    const forged = await request(address, '/v1/config/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 'red-path', backupId: '../escape.json', expectedHash: (await request(address, '/v1/config')).body.config.hash }) });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, 'BACKUP_PATH_INVALID');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('红队攻击：并发配置提案 reservation 也受数量上限约束', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ocw-red-team-limit-'));
  await writeFile(path.join(root, 'openclaw.json'), '{"mode":"old"}\n');
  const imported = await importConfig({ root, relativePath: 'openclaw.json', expectedHash: createHash('sha256').update('{"mode":"old"}\n').digest('hex'), content: '{"mode":"new"}\n' });
  let audits = 0;
  const app = createWorkbenchServer({
    root,
    token: TOKEN,
    approvalToken: APPROVAL,
    audit: { append: async () => { audits += 1; await new Promise((resolve) => setTimeout(resolve, 75)); } },
  });
  const address = await app.listen();
  try {
    const expectedHash = imported.afterHash;
    const requests = Array.from({ length: 33 }, () => request(address, '/v1/config/rollback', { method: 'POST', body: JSON.stringify({ sessionId: 'red-limit', expectedHash, backupId: imported.backupId }) }));
    const responses = await Promise.all(requests);
    assert.ok(responses.some((response) => response.status === 429), `expected at least one limit response, got ${responses.map((response) => response.status).join(',')}`);
    assert.equal(audits <= 32, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
