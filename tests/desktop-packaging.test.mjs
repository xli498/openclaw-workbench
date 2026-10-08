import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Tauri bundle carries the Node runtime as explicit resources', async () => {
  const config = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  assert.deepEqual(config.bundle.resources, {
    '../bin': 'runtime/bin',
    '../runtime': 'runtime/runtime',
    '../package.json': 'runtime/package.json',
    'node-runtime': 'runtime/node'
  });
  assert.deepEqual(config.bundle.targets, ['msi', 'nsis']);
});

test('desktop source documents the CI-provided Node runtime without checking in binaries', async () => {
  const placeholder = await readFile(path.join(repoRoot, 'desktop', 'node-runtime', 'README.md'), 'utf8');
  assert.match(placeholder, /v22[.]19[.]0/);
  assert.match(placeholder, /download|CI/i);
  assert.match(placeholder, /not.*commit|binary|out of Git/i);
});

test('Windows bundle includes the required ICO application icon', async () => {
  const icon = await readFile(path.join(repoRoot, 'desktop', 'icons', 'icon.ico'));
  assert.ok(icon.length > 22);
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok((await stat(path.join(repoRoot, 'desktop', 'icons', 'icon.ico'))).isFile());
});

test('desktop packaging docs distinguish development fallback from release resources', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /cargo tauri dev/);
  assert.match(docs, /debug build (?:may use the checkout|first looks for)/);
  assert.match(docs, /compiled out of release builds/);
  assert.match(docs, /runtime\/bin\/workbench\.mjs/);
  assert.match(docs, /instead of falling back to a source checkout/);
});

test('desktop packaging docs provide a non-global Tauri preflight and explain MSVC linker failures', async () => {
  const docs = await readFile(path.join(repoRoot, 'desktop', 'README.md'), 'utf8');
  assert.match(docs, /npx --yes @tauri-apps\/cli@2\.12\.1 info/);
  assert.match(docs, /npx --yes @tauri-apps\/cli@2\.12\.1 build --ci/);
  assert.match(docs, /does not install.*global|without.*global.*install/i);
  assert.match(docs, /link\.exe/);
  assert.match(docs, /Microsoft C\+\+ Build Tools/);
  assert.match(docs, /Windows (?:10|11).*SDK|Windows SDK/i);
});
