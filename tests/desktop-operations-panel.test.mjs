import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.match(app, /Runtime 未启动/);
});
