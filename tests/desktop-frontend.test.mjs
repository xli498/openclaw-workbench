import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(repoRoot, 'desktop', 'frontend');

async function readDesktopRustSources() {
  const sourceRoot = path.join(repoRoot, 'desktop', 'src');
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const rustFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.rs'));
  return (await Promise.all(rustFiles.map((entry) => readFile(path.join(sourceRoot, entry.name), 'utf8')))).join('\n');
}

test('desktop first screen exposes project, runtime, connection, and console controls', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');

  for (const marker of [
    'project-path',
    'runtime-state',
    'connection-state',
    'console-link',
    'save-project',
    'runtime-address',
    'start-runtime',
    'stop-runtime'
  ]) {
    assert.match(html, new RegExp(`(?:id|for)="${marker}"`), `missing ${marker}`);
  }

  assert.match(html, /app\.js/, 'page should load the frontend behavior module');
  assert.match(app, /localStorage/, 'project selection should survive a page reload');
  assert.match(app, /start_runtime/);
  assert.match(app, /runtime_status/);
});

test('desktop first screen uses only the registered runtime command surface', async () => {
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  const host = await readDesktopRustSources();
  assert.match(app, /__TAURI__\?\.core\?\.invoke/);
  const frontendCommands = ['choose_workspace', 'runtime_status', 'start_runtime', 'stop_runtime'];
  const hostCommands = [...frontendCommands, 'runtime_request'];
  for (const command of frontendCommands) {
    assert.match(app, new RegExp(command));
  }
  for (const command of hostCommands) {
    assert.match(host, new RegExp(`pub fn ${command}\\b`), `Rust command ${command} is missing`);
  }
  const handler = host.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  for (const command of hostCommands) assert.match(handler, new RegExp(`\\b${command}\\b`), `Rust command ${command} is not registered`);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*token/i);
});

test('workspace folder picker is wired to the least-privilege Tauri dialog capability', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');
  const config = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'tauri.conf.json'), 'utf8'));
  const capabilities = JSON.parse(await readFile(path.join(repoRoot, 'desktop', 'capabilities', 'default.json'), 'utf8'));
  const cargo = await readFile(path.join(repoRoot, 'desktop', 'Cargo.toml'), 'utf8');
  const host = await readFile(path.join(repoRoot, 'desktop', 'src', 'lib.rs'), 'utf8');

  assert.match(html, /id="browse-workspace"/);
  assert.match(app, /__TAURI__\?\.dialog\?\.open/);
  assert.equal(config.app.withGlobalTauri, true);
  assert.match(cargo, /tauri-plugin-dialog/);
  assert.match(host, /tauri_plugin_dialog::init\(\)/);
  assert.ok(capabilities.permissions.includes('dialog:allow-open'));
});

test('console entry never navigates without Bearer authentication or puts a token in the URL', async () => {
  const html = await readFile(path.join(frontendRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(frontendRoot, 'app.js'), 'utf8');

  assert.match(html, /需要桌面认证/);
  assert.doesNotMatch(app, /consoleLink\.href\s*=\s*hasAddress/);
  assert.doesNotMatch(app, /window\.open\s*\(/);
  assert.match(app, /不会把 token 放入 URL/);
});
