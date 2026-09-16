import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runAgent } from './openclaw-adapter.mjs';
import { runPlanReview, runPlanDebate, PlanError } from './plan.mjs';
import { readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';
import { runAgentLoop } from './agent-loop.mjs';
import { redactText as redactSafeText, redactValue as redactSafeValue } from './redaction.mjs';

export const CHAT_MODES = Object.freeze(['Ask', 'Plan', 'Code']);
const MAX_MESSAGE_LENGTH = 32 * 1024;
const MODEL_ID_MAX_LENGTH = 128;
const SENSITIVE_VALUE = /((?:bearer|token|password|passwd|secret|api[_ -]?key|apikey|accesskey|clientsecret|key)[=: -]+)[^\s,;\]}]+/gi;

export class SessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SessionError'; this.code = code; this.details = details; }
}

function assertMode(mode) {
  if (!CHAT_MODES.includes(mode)) throw new SessionError('INVALID_MODE', `mode must be one of ${CHAT_MODES.join(', ')}`);
}

function publicSession(session) {
  return Object.freeze({ id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messageCount: session.messages.length, planCount: session.planResults.length, ...(session.recoveryReason ? { recoveryReason: session.recoveryReason } : {}) });
}

function snapshotSession(session) {
  return { id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messages: session.messages, planResults: session.planResults, running: session.running };
}

function assertPlanResult(result) {
  if (!result || typeof result.id !== 'string' || typeof result.question !== 'string' || !Array.isArray(result.analyses) || !Array.isArray(result.failures) || !result.synthesis || typeof result.createdAt !== 'string') throw new Error('invalid plan result snapshot');
  if (result.debate === true) {
    const rounds = result.rounds;
    if (typeof result.judgeModel !== 'string' || !rounds || !Array.isArray(rounds.proposals) || !Array.isArray(rounds.critiques) || !Array.isArray(rounds.responses) || !rounds.verdict || Array.isArray(rounds.verdict)) throw new Error('invalid debate result snapshot');
    const expectedDigest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
    const assertItem = (item, role, { target = false } = {}) => {
      if (!item || typeof item.model !== 'string' || typeof item.modelId !== 'string' || item.model !== item.modelId || item.role !== role || typeof item.text !== 'string' || typeof item.digest !== 'string' || item.digest !== expectedDigest(item.text)) throw new Error('invalid debate item snapshot');
      if (target && (typeof item.targetModel !== 'string' || typeof item.targetProposal !== 'string')) throw new Error('invalid debate target snapshot');
    };
    rounds.proposals.forEach((item) => assertItem(item, 'proposer'));
    rounds.critiques.forEach((item) => assertItem(item, 'opposing_reviewer', { target: true }));
    rounds.responses.forEach((item) => assertItem(item, 'respondent', { target: true }));
    assertItem(rounds.verdict, 'judge');
    if (rounds.verdict.model !== result.judgeModel || rounds.verdict.modelId !== result.judgeModel || result.synthesis?.judgeModel !== result.judgeModel) throw new Error('invalid debate judge snapshot');
    const proposalDigests = new Set(rounds.proposals.map((item) => item.digest));
    if (rounds.critiques.some((item) => !proposalDigests.has(item.targetProposal)) || rounds.responses.some((item) => item.targetModel !== item.model || !proposalDigests.has(item.targetProposal))) throw new Error('invalid debate association snapshot');
  }
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function attachPersistenceError(primary, persistenceError) {
  if (!primary || typeof primary !== 'object') return;
  const details = primary.details && typeof primary.details === 'object' ? primary.details : {};
  primary.details = { ...details, persistenceError: { code: persistenceError?.code, message: persistenceError?.message } };
  if (!primary.cause) primary.cause = persistenceError;
}

function redactString(value) {
  return redactSafeText(value);
}

function safeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new SessionError('MODEL_RESPONSE_INVALID', 'model response is invalid');
  const text = typeof response.text === 'string' ? redactString(response.text) : '';
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.slice(0, 64).map((call) => ({
    id: typeof call?.id === 'string' ? redactString(call.id).slice(0, 256) : '',
    name: typeof call?.name === 'string' ? redactString(call.name).slice(0, 256) : '',
    arguments: call?.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? redactValue(call.arguments) : {},
  })) : [];
  const normalized = { text, toolCalls, finishReason: typeof response.finishReason === 'string' ? redactString(response.finishReason).slice(0, 128) : null, model: typeof response.model === 'string' ? redactString(response.model).slice(0, 256) : null, protocol: typeof response.protocol === 'string' ? response.protocol.slice(0, 64) : null };
  if (response.usage && typeof response.usage === 'object' && !Array.isArray(response.usage)) {
    normalized.usage = Object.fromEntries(Object.entries(response.usage).filter(([key, value]) => /^[A-Za-z0-9_.-]{1,64}$/.test(key) && (Number.isFinite(value) || typeof value === 'string')).map(([key, value]) => [key, typeof value === 'string' ? redactString(value).slice(0, 128) : value]));
  }
  return normalized;
}

function redactValue(value, depth = 0) {
  return redactSafeValue(value, { depth, maxStringLength: 4096 });
}

function modelHistoryMessage({ role, content }) {
  if (role === 'assistant' && content && typeof content === 'object' && !Array.isArray(content)) {
    return { role, content: typeof content.text === 'string' ? redactString(content.text) : '' };
  }
  return { role, content: typeof content === 'string' ? redactString(content) : '' };
}

export function createChatSessionManager({ root, runAgentFn = runAgent, gatewayRequestFn, modelRunner, modelResolver, modelFallbackFn, toolRegistry, clock = () => new Date(), storePath = join(root ?? '', '.openclaw-workbench', 'sessions.json') } = {}) {
  if (!root) throw new SessionError('ROOT_REQUIRED', 'root is required');
  const sessions = new Map();
  const controllers = new Map();
  let persistedDigest = null;
  function persist() {
    const payload = JSON.stringify({ version: 1, sessions: [...sessions.values()].map(snapshotSession) });
    persistedDigest = writeSnapshotAtomically({ root, storePath, payload, expectedDigest: persistedDigest, ErrorType: SessionError, code: 'SESSION_STORE_INVALID', message: 'session snapshot is invalid; refusing recovery', busyCode: 'SESSION_STORE_BUSY', busyMessage: 'session snapshot write is already in progress', conflictCode: 'SESSION_STORE_CONFLICT', conflictMessage: 'session snapshot changed outside this manager; refusing overwrite', temporaryName: randomUUID() });
  }
  function restore() {
    try {
      const snapshot = readSnapshot({ root, storePath, ErrorType: SessionError, code: 'SESSION_STORE_INVALID', message: 'session snapshot is invalid; refusing recovery' });
      if (snapshot.content === null) return;
      persistedDigest = snapshot.digest;
      const payload = JSON.parse(snapshot.content);
      if (payload?.version !== 1 || !Array.isArray(payload.sessions)) throw new Error('unsupported snapshot');
      const ids = new Set();
      for (const raw of payload.sessions) {
        if (!raw || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id) || !CHAT_MODES.includes(raw.mode) || (raw.status !== undefined && !['active', 'closed', 'manual_review'].includes(raw.status)) || !Array.isArray(raw.messages) || raw.messages.some((message) => !message || !['user', 'assistant'].includes(message.role) || (typeof message.content !== 'string' && (!message.content || typeof message.content !== 'object' || Array.isArray(message.content))))) throw new Error('invalid session snapshot');
        const planResults = raw.planResults ?? [];
        if (!Array.isArray(planResults)) throw new Error('invalid plan result snapshot');
        planResults.forEach(assertPlanResult);
        ids.add(raw.id);
        const interrupted = raw.running === true;
        const restoredPlanResults = planResults.map((result) => {
          const copy = {
            ...result,
            analyses: result.analyses.map((item) => ({ ...item })),
            failures: result.failures.map((item) => ({ ...item })),
            synthesis: { ...result.synthesis },
          };
          if (result.debate === true) {
            copy.rounds = {
              proposals: result.rounds.proposals.map((item) => ({ ...item })),
              critiques: result.rounds.critiques.map((item) => ({ ...item })),
              responses: (result.rounds.responses ?? []).map((item) => ({ ...item })),
              verdict: { ...result.rounds.verdict },
            };
          }
          return deepFreeze(copy);
        });
        const session = {
          id: raw.id,
          workspaceId: raw.workspaceId || root,
          mode: raw.mode,
          actor: raw.actor || 'user',
          status: interrupted ? 'manual_review' : raw.status === 'closed' ? 'closed' : 'active',
          createdAt: raw.createdAt || clock().toISOString(),
          messages: raw.messages.map((message) => Object.freeze({ ...message })),
          planResults: restoredPlanResults,
          running: false,
          pendingRunners: new Set(),
          ...(interrupted ? { recoveryReason: 'interrupted_turn' } : {}),
        };
        sessions.set(session.id, session);
      }
    } catch (error) {
      throw new SessionError('SESSION_STORE_INVALID', 'session snapshot is invalid; refusing recovery');
    }
  }
  restore();

  function createSession({ mode = 'Ask', actor = 'user', workspaceId = root } = {}) {
    assertMode(mode);
    if (typeof actor !== 'string' || !actor || actor.length > 256) throw new SessionError('INVALID_ACTOR', 'actor is required and must be at most 256 characters');
    const session = { id: randomUUID(), workspaceId, mode, actor, status: 'active', createdAt: clock().toISOString(), messages: [], planResults: [], running: false, pendingRunners: new Set() };
    sessions.set(session.id, session);
    try { persist(); } catch (error) { sessions.delete(session.id); throw error; }
    return publicSession(session);
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new SessionError('SESSION_NOT_FOUND', 'session not found');
    return session;
  }

  async function sendMessage({ sessionId, message, model, thinking, timeoutSeconds, local = true, signal } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LENGTH) throw new SessionError('INVALID_MESSAGE', `message must be non-empty and at most ${MAX_MESSAGE_LENGTH} characters`);
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    let selectedProfile;
    const useModelRunner = Boolean(modelRunner && (model !== undefined && model !== null));
    if (modelRunner && !useModelRunner && !modelFallbackFn) {
      throw new SessionError('MODEL_REQUIRED', 'an enabled model profile is required');
    }
    if (useModelRunner) {
      if (typeof model !== 'string' || !model.trim() || model.length > MODEL_ID_MAX_LENGTH) throw new SessionError('MODEL_REQUIRED', 'an enabled model profile is required');
      const resolver = typeof modelResolver === 'function' ? modelResolver : modelResolver?.get?.bind(modelResolver);
      if (!resolver) throw new SessionError('MODEL_NOT_FOUND', 'model profile not found');
      selectedProfile = await resolver(model);
      if (!selectedProfile) throw new SessionError('MODEL_NOT_FOUND', 'model profile not found');
      if (selectedProfile.enabled !== true) throw new SessionError('MODEL_DISABLED', 'model profile is disabled');
    }
    session.running = true;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    controllers.set(session.id, controller);
    const userMessage = Object.freeze({ role: 'user', content: message, createdAt: clock().toISOString() });
    session.messages.push(userMessage);
    try { persist(); } catch (error) { session.messages.pop(); session.running = false; throw error; }
    let primaryError;
    try {
      const requestFn = useModelRunner ? modelRunner : modelFallbackFn ?? gatewayRequestFn ?? runAgentFn;
      let response;
      const modelMessages = session.messages.map(modelHistoryMessage);
      // A caller that injects only a model runner (without the unified tool
      // registry) is using the pre-tool-loop API. Preserve that boundary: the
      // runner response is still normalized/redacted below, but no assistant
      // supplied tool call is executed or interpreted here. The HTTP product
      // path always supplies the registry and therefore takes the bounded
      // structured tool loop.
      if (useModelRunner && toolRegistry) {
        response = await runAgentLoop({
          mode: session.mode,
          sessionId: session.id,
          profile: selectedProfile,
          messages: modelMessages,
          registry: toolRegistry,
          modelRunner: requestFn,
          model: selectedProfile.model,
          profileId: selectedProfile.id ?? model,
          message,
          sessionKey: session.id,
          thinking,
          timeoutSeconds,
          local,
          signal: controller.signal,
        });
      } else {
        response = await requestFn({ profile: selectedProfile, profileId: selectedProfile?.id ?? model, messages: modelMessages, message, sessionId: session.id, sessionKey: session.id, mode: session.mode, model: selectedProfile?.model ?? model, thinking, timeoutSeconds, local, signal: controller.signal });
        // The legacy direct-runner seam has no tool registry and therefore no
        // authority to interpret assistant tool calls. Do not persist
        // provider-controlled text or arguments from such a batch: dropping
        // the unsupported batch keeps the compatibility API read-only and
        // prevents untrusted tool payloads from entering snapshots.
        if (useModelRunner && Array.isArray(response?.toolCalls) && response.toolCalls.length > 0) {
          response = { ...response, text: '', toolCalls: [] };
        }
      }
      const content = useModelRunner ? safeResponse(response) : response;
      const assistantMessage = Object.freeze({ role: 'assistant', content, createdAt: clock().toISOString() });
      session.messages.push(assistantMessage);
      persist();
      return Object.freeze({ session: publicSession(session), message: assistantMessage });
    } catch (error) {
      primaryError = error;
      session.messages.pop();
      try { persist(); } catch (persistenceError) { attachPersistenceError(error, persistenceError); }
      throw error;
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      controllers.delete(session.id);
      session.running = false;
      try { persist(); } catch (persistenceError) {
        if (primaryError) attachPersistenceError(primaryError, persistenceError);
        else throw persistenceError;
      }
    }
  }

  async function planReview({ sessionId, question, models, judgeModel, debate = false, thinking, timeoutSeconds, signal, onStage } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (session.mode !== 'Plan') throw new SessionError('MODE_INSUFFICIENT', 'plan review requires a Plan session');
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    session.running = true;
    const controller = new AbortController();
    const registerRunner = (runner) => {
      session.pendingRunners.add(runner);
      runner.then(() => session.pendingRunners.delete(runner), () => session.pendingRunners.delete(runner));
    };
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    controllers.set(session.id, controller);
    try { persist(); } catch (error) { session.running = false; throw error; }
    let primaryError;
    try {
      const runner = debate ? runPlanDebate : runPlanReview;
      const result = await runner({ question, models, judgeModel, sessionKey: session.id, thinking, timeoutSeconds, signal: controller.signal, onStage, onRunnerStart: registerRunner, runAgentFn: (input) => runAgentFn({ ...input, signal: controller.signal }) });
      const stored = Object.freeze({ id: randomUUID(), ...result, createdAt: clock().toISOString() });
      session.planResults.push(stored);
      persist();
      return stored;
    }
    catch (error) { primaryError = error; throw error; }
    finally {
      signal?.removeEventListener('abort', relayAbort);
      controllers.delete(session.id);
      if (session.pendingRunners.size === 0) session.running = false;
      try { persist(); } catch (persistenceError) {
        if (primaryError) attachPersistenceError(primaryError, persistenceError);
        else throw persistenceError;
      }
      if (session.pendingRunners.size > 0) {
        void Promise.allSettled([...session.pendingRunners]).then(() => {
          if (session.pendingRunners.size === 0 && session.running) {
            session.running = false;
            try { persist(); } catch { /* best effort; the original turn already returned */ }
          }
        });
      }
    }
  }

  function listMessages(sessionId) {
    const session = getSession(sessionId);
    return Object.freeze(session.messages.map((message) => Object.freeze({ ...message })));
  }

  function cancelTurn(sessionId) {
    const session = getSession(sessionId);
    if (!session.running || !controllers.has(sessionId)) throw new SessionError('NO_RUNNING_TURN', 'session has no running turn');
    controllers.get(sessionId).abort();
    return Object.freeze({ session: publicSession(session), cancelled: true });
  }

  function cancelAllTurns() {
    for (const controller of controllers.values()) controller.abort();
    return controllers.size;
  }

  function listPlanResults(sessionId) {
    const session = getSession(sessionId);
    return Object.freeze(session.planResults.map((result) => Object.freeze({ ...result, analyses: Object.freeze(result.analyses.map((item) => Object.freeze({ ...item }))), failures: Object.freeze(result.failures.map((item) => Object.freeze({ ...item }))), synthesis: Object.freeze({ ...result.synthesis }) })));
  }

  function listSessions({ status } = {}) {
    if (status !== undefined && !['active', 'closed', 'manual_review'].includes(status)) throw new SessionError('INVALID_STATUS', 'status must be active, closed or manual_review');
    return Object.freeze([...sessions.values()]
      .filter((session) => status === undefined || session.status === status)
      .map(publicSession));
  }

  function closeSession(sessionId) {
    const session = getSession(sessionId);
    if (session.running) throw new SessionError('SESSION_BUSY', 'cannot close a running session');
    const previousStatus = session.status;
    session.status = 'closed';
    try { persist(); } catch (error) { session.status = previousStatus; throw error; }
    return publicSession(session);
  }

  function reviewSession(sessionId, { decision, reviewer = 'user' } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'manual_review') throw new SessionError('REVIEW_NOT_REQUIRED', 'session is not awaiting manual review');
    if (!['resume', 'close'].includes(decision)) throw new SessionError('INVALID_REVIEW_DECISION', 'decision must be resume or close');
    if (typeof reviewer !== 'string' || !reviewer || reviewer.length > 256) throw new SessionError('INVALID_REVIEWER', 'reviewer is required and must be at most 256 characters');
    const previous = { status: session.status, recoveryReason: session.recoveryReason, review: session.review };
    session.status = decision === 'resume' ? 'active' : 'closed';
    session.recoveryReason = undefined;
    session.review = Object.freeze({ decision, reviewer, reviewedAt: clock().toISOString(), replayed: false });
    try { persist(); } catch (error) { Object.assign(session, previous); throw error; }
    return publicSession(session);
  }

  function recoverySummary() {
    const values = [...sessions.values()];
    return Object.freeze({ total: values.length, active: values.filter((session) => session.status === 'active').length, closed: values.filter((session) => session.status === 'closed').length, manualReview: values.filter((session) => session.status === 'manual_review').length, interruptedTurns: values.filter((session) => session.recoveryReason === 'interrupted_turn').length });
  }

  return Object.freeze({ createSession, getSession: (id) => publicSession(getSession(id)), listSessions, sendMessage, planReview, cancelTurn, cancelAllTurns, listMessages, listPlanResults, closeSession, reviewSession, recoverySummary, snapshotPath: storePath });
}
