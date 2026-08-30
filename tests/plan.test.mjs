import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlanReview, PlanError } from '../runtime/plan.mjs';

test('Plan 模式并行收集多模型分析并标记分歧', async () => {
  const calls = [];
  const result = await runPlanReview({ question: '设计一个只读审计方案', models: ['model-a', 'model-b'], sessionKey: 'session-1', runAgentFn: async (input) => { calls.push(input); return { text: `${input.model} 的方案` }; } });
  assert.equal(result.mode, 'Plan');
  assert.equal(result.analyses.length, 2);
  assert.equal(result.synthesis.agreement, 'partial');
  assert.equal(result.synthesis.requiresHumanReview, true);
  assert.deepEqual(calls.map((call) => call.mode).sort(), ['Plan', 'Plan']);
  assert.ok(calls.every((call) => call.local === true));
});

test('Plan 模式拒绝重复模型并在全部失败时阻断', async () => {
  await assert.rejects(() => runPlanReview({ question: 'x', models: ['a', 'a'], sessionKey: 's', runAgentFn: async () => ({ text: 'x' }) }), (error) => error instanceof PlanError && error.code === 'DUPLICATE_MODELS');
  await assert.rejects(() => runPlanReview({ question: 'x', models: ['a', 'b'], sessionKey: 's', runAgentFn: async () => { throw new Error('down'); } }), (error) => error instanceof PlanError && error.code === 'PLAN_FAILED');
});
