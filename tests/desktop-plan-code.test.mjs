import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop workbench exposes Plan and Code mode contracts', async () => {
  const html = await readFile(path.join(root, 'desktop', 'frontend', 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'desktop', 'frontend', 'app.js'), 'utf8');
  for (const id of ['mode-ask', 'mode-plan', 'mode-code', 'plan-panel', 'plan-question', 'run-plan', 'plan-result', 'code-panel', 'code-proposals']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(app, /mode: workMode/);
  assert.match(app, /\/plan/);
  assert.match(app, /\/tools\/proposals/);
  assert.match(app, /actionHash/);
  assert.match(app, /approve/);
  assert.match(app, /deny/);
  assert.match(app, /data-proposal-action="diff"/);
  assert.match(app, /modelRequest\('POST', path, \{ actionHash: hash \}, true\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*token/i);
});
