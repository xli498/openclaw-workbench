import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runAgentLoop } from '../runtime/agent-loop.mjs';

function registry(result = {}) {
  return { definitions: () => [], call: async () => result };
}

test('红队攻击：每批工具数、循环轮次和累计输出均有硬上限', async () => {
  const base = { mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [], registry: registry({ data: 'x'.repeat(80) }) };
  await assert.rejects(() => runAgentLoop({ ...base, maxCallsPerBatch: 2, modelRunner: async () => ({ text: '', toolCalls: [1, 2, 3].map((n) => ({ id: `c${n}`, name: 'workspace.read_files', arguments: {} })) }) }), { code: 'TOOL_BATCH_LIMIT' });
  await assert.rejects(() => runAgentLoop({ ...base, maxRounds: 2, modelRunner: async () => ({ text: '', toolCalls: [{ id: crypto.randomUUID(), name: 'workspace.read_files', arguments: {} }] }) }), { code: 'TOOL_LOOP_LIMIT' });
  await assert.rejects(() => runAgentLoop({ ...base, maxToolOutputBytes: 32, modelRunner: async () => ({ text: '', toolCalls: [{ id: 'c1', name: 'workspace.read_files', arguments: {} }] }) }), { code: 'TOOL_OUTPUT_LIMIT' });
});

test('红队攻击：重复 ID、非法结构、工具名替换和已取消请求不能执行', async () => {
  let executions = 0;
  const checked = { definitions: () => [], call: async ({ name }) => { executions += 1; if (name !== 'workspace.read_files') throw Object.assign(new Error('denied'), { code: 'TOOL_NOT_ALLOWED' }); return {}; } };
  const base = { mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [], registry: checked };
  await assert.rejects(() => runAgentLoop({ ...base, modelRunner: async () => ({ toolCalls: [{ id: 'same', name: 'workspace.read_files', arguments: {} }, { id: 'same', name: 'workspace.read_files', arguments: {} }] }) }), { code: 'TOOL_CALL_REPLAY' });
  await assert.rejects(() => runAgentLoop({ ...base, modelRunner: async () => ({ toolCalls: [{ id: 'bad', name: 'workspace.command', arguments: { argv: ['whoami'] } }] }) }), { code: 'TOOL_NOT_ALLOWED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => runAgentLoop({ ...base, signal: controller.signal, modelRunner: async () => ({ toolCalls: [] }) }), { code: 'AGENT_LOOP_ABORTED' });
  assert.equal(executions, 0);
});

test('红队攻击：工具错误被限制为安全结果，不能把异常对象或秘密原文带回模型', async () => {
  const secret = 'TOOL_SECRET_MARKER';
  const seen = [];
  const checked = {
    definitions: () => [{ type: 'function', function: { name: 'workspace.read_files', parameters: { type: 'object' } } }],
    call: async () => { throw Object.assign(new Error(`provider token=${secret}`), { code: 'TOOL_RESULT_LIMIT' }); },
  };
  const result = await runAgentLoop({
    mode: 'Ask', sessionId: 's', profile: { id: 'p', model: 'm', protocol: 'openai-compatible' }, messages: [], registry: checked,
    modelRunner: async (input) => {
      seen.push(input.messages);
      return seen.length === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'workspace.read_files', arguments: {} }] }
        : { text: 'recovered', toolCalls: [] };
    },
  });
  assert.equal(result.text, 'recovered');
  assert.equal(JSON.stringify(seen).includes(secret), false);
  assert.equal(result.toolTrace[0].status, 'failed');
});
