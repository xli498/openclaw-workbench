// Contract test for the P2 docs follow-up (Q27-2/Q27-3): README and
// docs/05-next-implementation.md wording must match the implemented MCP
// surface (approval-gated start/stop/call, bridge tools/list + tools/call +
// GET SSE, persistent replay) instead of the stale skeleton-only claims.
// It reads only repo text files and changes no runtime behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const next = readFileSync(path.join(root, 'docs/05-next-implementation.md'), 'utf8');

function bullet(text, heading) {
  // Headings may carry a parenthetical suffix, e.g.
  // "**MCP 管理剩余（第三轮口径…）**"; match the heading prefix only when
  // it is followed by "**" or "（", so "streamable HTTP 剩余语义" is not
  // mistaken for "streamable HTTP 剩余".
  const marker = `- **${heading}`;
  let start = -1;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    const next = text[at + marker.length];
    if (next === '*' || next === '（') { start = at; break; }
  }
  assert.notEqual(start, -1, `missing bullet: ${heading}`);
  const rest = text.slice(start);
  const end = rest.search(/\n- \*\*|\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test('README MCP row no longer claims skeleton-only, never starts or calls', () => {
  assert.equal(readme.includes('已实现受控注册骨架'), false);
  assert.equal(readme.includes('不启动 Server/调用工具'), false);
  const row = readme.split('\n').find((line) => line.startsWith('| MCP 注册、工具 allowlist、健康状态 |'));
  assert.ok(row, 'missing MCP table row in README');
  assert.match(row, /默认禁用/);
  assert.match(row, /受审批约束的注册、启停与工具调用/);
  assert.match(row, /仍有未闭合项/);
});

test('docs/05 third-round MCP bullet no longer claims deny/cancel routes missing', () => {
  const item = bullet(next, 'MCP 管理剩余');
  assert.equal(item.includes('后端无 deny/cancel 路由'), false);
  assert.equal(item.includes('下一步：在管理面 API 上补上述入口'), false);
  assert.match(item, /第四轮/);
  assert.match(item, /deny\/cancel/);
});

test('docs/05 third-round streamable bullet reflects bridge tools routes and persistent replay', () => {
  const item = bullet(next, 'streamable HTTP 剩余');
  assert.equal(item.includes('下一步：如需跨重启续接，设计持久化回放缓冲与快照语义'), false);
  assert.match(item, /tools\/list/);
  assert.match(item, /tools\/call/);
  assert.match(item, /GET SSE/);
  assert.match(item, /replayStorePath/);
  assert.match(item, /第四轮/);
});
