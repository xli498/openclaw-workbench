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

test('Plan 博弈执行独立提案、交叉质询和裁判综合三轮闭环', async () => {
  const calls = [];
  const result = await runPlanReview({ question: 'x', models: ['a', 'b'], sessionKey: 's', runAgentFn: async (input) => { calls.push(input); return { text: `${input.model}:${input.message.includes('final impartial judge') ? 'verdict' : input.message.includes('opposing reviewer') ? 'critique' : 'proposal'}` }; } });
  assert.equal(result.analyses.length, 2);
  const debate = await (await import('../runtime/plan.mjs')).runPlanDebate({ question: 'x', models: ['a', 'b'], judgeModel: 'judge', sessionKey: 's', runAgentFn: async (input) => { calls.push(input); return { text: `${input.model}:${input.message.includes('final impartial judge') ? 'verdict' : input.message.includes('opposing reviewer') ? 'critique' : 'proposal'}` }; } });
  assert.equal(debate.debate, true);
  assert.equal(debate.rounds.proposals.length, 2);
  assert.equal(debate.rounds.critiques.length, 2);
  assert.equal(debate.rounds.responses.length, 2);
  assert.equal(debate.rounds.verdict.model, 'judge');
  assert.ok(debate.rounds.proposals.every((item) => item.role === 'proposer'));
  assert.ok(debate.rounds.critiques.every((item) => item.role === 'opposing_reviewer'));
  assert.ok(debate.rounds.responses.every((item) => item.role === 'respondent'));
  assert.equal(debate.rounds.verdict.role, 'judge');
  assert.equal(debate.synthesis.evidence.verdictDigest, debate.rounds.verdict.digest);
  assert.equal(debate.synthesis.agreement, 'judged');
  assert.ok(calls.every((call) => call.local === true));
});

test('Plan 博弈保留局部 proposal/critique 失败并进入人工复核', async () => {
  let call = 0;
  const result = await (await import('../runtime/plan.mjs')).runPlanDebate({ question: 'x', models: ['a', 'b'], sessionKey: 's', runAgentFn: async ({ message }) => {
    call += 1;
    if (call === 4) throw new Error('critique down');
    return { text: message.includes('final impartial judge') ? 'verdict' : 'valid' };
  } });
  assert.equal(result.rounds.proposals.length, 2);
  assert.equal(result.rounds.critiques.length, 1);
  assert.equal(result.rounds.responses.length, 2);
  assert.equal(result.synthesis.requiresHumanReview, true);
  assert.ok(result.failures.some((failure) => failure.stage === 'challenge'));

});

test('Plan 博弈超过总输出预算时拒绝裁判综合', async () => {
  let judgeCalled = false;
  await assert.rejects(() => import('../runtime/plan.mjs').then(({ runPlanDebate }) => runPlanDebate({ question: 'x', models: ['a', 'b', 'c', 'd'], sessionKey: 's', runAgentFn: async ({ message }) => {
    if (message.includes('final impartial judge')) { judgeCalled = true; return { text: 'verdict' }; }
    return { text: 'x'.repeat(16 * 1024) };
  } })), (error) => error instanceof PlanError && error.code === 'PLAN_BUDGET_EXCEEDED');
  assert.equal(judgeCalled, false);
});

test('Plan 模式拒绝重复模型并在全部失败时阻断', async () => {
  await assert.rejects(() => runPlanReview({ question: 'x', models: ['a', 'a'], sessionKey: 's', runAgentFn: async () => ({ text: 'x' }) }), (error) => error instanceof PlanError && error.code === 'DUPLICATE_MODELS');
  await assert.rejects(() => runPlanReview({ question: 'x', models: ['a', 'b'], sessionKey: 's', runAgentFn: async () => { throw new Error('down'); } }), (error) => error instanceof PlanError && error.code === 'PLAN_FAILED');
});

test('Plan Debate 在裁判阶段取消时保留 ABORTED 语义且不发布失败阶段', async () => {
  const controller = new AbortController();
  await assert.rejects(() => import('../runtime/plan.mjs').then(({ runPlanDebate }) => runPlanDebate({ question: 'x', models: ['a', 'b'], judgeModel: 'judge', sessionKey: 's', signal: controller.signal, runAgentFn: async ({ message }) => {
    if (message.includes('final impartial judge')) { controller.abort(); throw Object.assign(new Error('aborted'), { code: 'ABORTED' }); }
    return { text: 'valid' };
  } })), (error) => error instanceof PlanError && error.code === 'ABORTED');
});
