import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repoRoot, 'desktop', 'frontend');

test('desktop first screen exposes project, runtime, connection, and console controls', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');

  for (const marker of [
    'project-path',
    'runtime-state',
    'connection-state',
    'console-link',
    'save-project',
    'runtime-address'
  ]) {
    assert.match(html, new RegExp(`(?:id|for)="${marker}"`), `missing ${marker}`);
  }

  assert.match(html, /app\.js/, 'page should load the frontend behavior module');
  assert.match(app, /localStorage/, 'project selection should survive a page reload');
  assert.match(html, /Runtime 尚未接入桌面进程/, 'unavailable runtime must be communicated honestly');
});

test('desktop first screen does not call unregistered Tauri commands', async () => {
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /__TAURI__|invoke\s*\(/, 'frontend must not call commands that Rust does not expose');
});
