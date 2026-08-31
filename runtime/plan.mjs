import { createHash } from 'node:crypto';
import { runAgent } from './openclaw-adapter.mjs';

const MAX_MODELS = 4;
const MAX_QUESTION_LENGTH = 32 * 1024;

export class PlanError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'PlanError'; this.code = code; this.details = details; }
}

function digest(value) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }

function validateInput({ question, models }) {
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LENGTH) throw new PlanError('INVALID_QUESTION', `question must be non-empty and at most ${MAX_QUESTION_LENGTH} characters`);
  if (!Array.isArray(models) || models.length < 2 || models.length > MAX_MODELS || models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 256)) throw new PlanError('INVALID_MODELS', `models must contain 2-${MAX_MODELS} model names`);
  if (new Set(models).size !== models.length) throw new PlanError('DUPLICATE_MODELS', 'models must be unique');
}

function textOf(response) {
  const text = response?.text ?? response?.content ?? response?.message;
  if (typeof text !== 'string' || !text.trim()) throw new PlanError('INVALID_ANALYSIS', 'model returned no usable text');
  return text;
}

export async function runPlanReview({ question, models, sessionKey, thinking, timeoutSeconds, signal, runAgentFn = runAgent } = {}) {
  validateInput({ question, models });
  if (!sessionKey) throw new PlanError('SESSION_REQUIRED', 'sessionKey is required');
  const prompt = `You are in Plan mode. Analyze the request below without modifying files, running terminal commands, or executing actions. Return a concise plan with assumptions, risks, and verification steps.\n\nRequest:\n${question}`;
  const settled = await Promise.allSettled(models.map((model) => runAgentFn({ message: prompt, sessionKey: `${sessionKey}:plan:${digest(model)}`, mode: 'Plan', model, thinking, timeoutSeconds, local: true, signal })));
  if (signal?.aborted) throw new PlanError('ABORTED', 'Plan review aborted');
  const analyses = [];
  const failures = [];
  settled.forEach((item, index) => {
    const model = models[index];
    if (item.status === 'fulfilled') {
      try { const text = textOf(item.value); analyses.push(Object.freeze({ model, text, digest: digest(text) })); }
      catch (error) { failures.push(Object.freeze({ model, code: error.code ?? 'INVALID_ANALYSIS', message: error.message })); }
    } else failures.push(Object.freeze({ model, code: item.reason?.code ?? 'MODEL_FAILED', message: item.reason?.message ?? String(item.reason) }));
  });
  if (!analyses.length) throw new PlanError('PLAN_FAILED', 'all planning analyses failed', { failures });
  const digests = new Set(analyses.map((item) => item.digest));
  return Object.freeze({ question, mode: 'Plan', sessionKey, analyses: Object.freeze(analyses), failures: Object.freeze(failures), synthesis: Object.freeze({ agreement: digests.size === 1 ? 'full' : 'partial', analysisCount: analyses.length, failureCount: failures.length, distinctAnswers: digests.size, requiresHumanReview: digests.size > 1 || failures.length > 0 }) });
}
