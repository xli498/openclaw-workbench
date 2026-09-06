import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('产品契约明确区分核心闭环、受限 Bridge 和未实现的外部服务', async () => {
  const [charter, boundary, readme] = await Promise.all([
    readFile(path.join(root, 'docs/00-product-charter.md'), 'utf8'),
    readFile(path.join(root, 'docs/01-integration-boundary.md'), 'utf8'),
    readFile(path.join(root, 'README.md'), 'utf8'),
  ]);
  const text = `${charter}\n${boundary}\n${readme}`;
  for (const phrase of [
    '模型注册',
    '真实模型请求',
    '规范化 Chat 回合',
    '只读工具',
    '审批提案',
    'Streamable HTTP MCP Bridge',
    '公网隧道未内置',
    'LSP 未实现',
    '持久 PTY 未实现',
  ]) assert.match(text, new RegExp(phrase));
});
