import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseArgs, runCli } from '../bin/workbench.mjs';
import { startWorkbench as packageStartWorkbench } from 'openclaw-workbench';

async function fixture() { return mkdtemp(`${tmpdir()}/openclaw-workbench-cli-`); }

test('package self-reference resolves the declared public entrypoint', () => {
  assert.equal(typeof packageStartWorkbench, 'function');
});

test('CLI 参数只接受明确 root、json 和 help', () => {
  assert.deepEqual(parseArgs(['--root', 'demo', '--json']), { root: 'demo', json: true });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['--root']), /requires a path/);
  assert.throws(() => parseArgs(['--shell']), /unknown argument/);
});

test('CLI 以 JSON 输出启动恢复摘要', async () => {
  const chunks = []; const stdout = { write: (value) => chunks.push(value) };
  const result = await runCli(['--json'], { stdout, cwd: await fixture() });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(chunks.join('')).summary.scanned, 0);
});
