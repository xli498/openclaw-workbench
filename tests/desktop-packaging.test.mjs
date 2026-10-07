import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri bundle carries the Node runtime as explicit resources', async () => {
  const config = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  assert.deepEqual(config.bundle.resources, {
    '../bin': 'runtime/bin',
    '../runtime': 'runtime/runtime',
    '../package.json': 'runtime/package.json'
  });
  assert.deepEqual(config.bundle.targets, ['msi', 'nsis']);
});

test('desktop packaging docs distinguish development fallback from release resources', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /cargo tauri dev/);
  assert.match(docs, /debug build may use the checkout/);
  assert.match(docs, /compiled out of release builds/);
  assert.match(docs, /runtime\/bin\/workbench\.mjs/);
  assert.match(docs, /instead of falling back to a source checkout/);
});
