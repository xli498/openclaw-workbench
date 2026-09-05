import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpStdioTransport } from '../runtime/mcp-transport.mjs';

const CHILD_SCRIPT = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.method === 'stderr-flood') process.stderr.write('x'.repeat(200000));
    if (frame.method === 'malformed') { process.stdout.write('not-json\\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { inherited: Boolean(process.env.MCP_RED_TEAM_SECRET), ok: true } }) + '\\n');
  }
});
`;

let fixtureDir;
let fixturePath;

test.before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'openclaw-mcp-red-team-'));
  fixturePath = join(fixtureDir, 'server.mjs');
  await writeFile(fixturePath, CHILD_SCRIPT, 'utf8');
});

test.after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function createRealTransport(options = {}) {
  return createMcpStdioTransport({ command: process.execPath, args: [fixturePath], requestTimeoutMs: 2_000, ...options });
}

test('红队真实攻击：stdio transport 拒绝 shell 元字符命令', () => {
  assert.throws(() => createMcpStdioTransport({ command: `${process.execPath};whoami` }), { code: 'MCP_COMMAND_INVALID' });
});

test('红队真实攻击：MCP Server stderr 洪泛不会阻塞正常响应', async () => {
  const transport = createRealTransport();
  await transport.start();
  try { assert.deepEqual(await transport.request('stderr-flood'), { inherited: false, ok: true }); }
  finally { await transport.close(); }
});

test('红队真实攻击：stdio transport 不继承宿主敏感环境变量', async () => {
  const key = 'MCP_RED_TEAM_SECRET';
  const previous = process.env[key];
  process.env[key] = 'must-not-cross-boundary';
  const transport = createRealTransport();
  try {
    await transport.start();
    assert.deepEqual(await transport.request('env-check'), { inherited: false, ok: true });
  } finally {
    await transport.close();
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('红队真实攻击：恶意无效 JSON 帧会终止 transport 并拒绝请求', async () => {
  const transport = createRealTransport();
  await transport.start();
  try {
    await assert.rejects(transport.request('malformed'), (error) => error.code === 'MCP_FRAME_INVALID');
    assert.equal(transport.getState(), 'failed');
  } finally { await transport.close(); }
});
