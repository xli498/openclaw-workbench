import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runAgent } from './openclaw-adapter.mjs';
import { runPlanReview, PlanError } from './plan.mjs';
import { readSnapshot, writeSnapshotAtomically } from './snapshot-store.mjs';

export const CHAT_MODES = Object.freeze(['Ask', 'Plan', 'Code']);
const MAX_MESSAGE_LENGTH = 32 * 1024;

export class SessionError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SessionError'; this.code = code; this.details = details; }
}

function assertMode(mode) {
  if (!CHAT_MODES.includes(mode)) throw new SessionError('INVALID_MODE', `mode must be one of ${CHAT_MODES.join(', ')}`);
}

function publicSession(session) {
  return Object.freeze({ id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messageCount: session.messages.length, ...(session.recoveryReason ? { recoveryReason: session.recoveryReason } : {}) });
}

function snapshotSession(session) {
  return { id: session.id, workspaceId: session.workspaceId, mode: session.mode, actor: session.actor, status: session.status, createdAt: session.createdAt, messages: session.messages, running: session.running };
}

function attachPersistenceError(primary, persistenceError) {
  if (!primary || typeof primary !== 'object') return;
  const details = primary.details && typeof primary.details === 'object' ? primary.details : {};
  primary.details = { ...details, persistenceError: { code: persistenceError?.code, message: persistenceError?.message } };
  if (!primary.cause) primary.cause = persistenceError;
}

export function createChatSessionManager({ root, runAgentFn = runAgent, clock = () => new Date(), storePath = join(root ?? '', '.openclaw-workbench', 'sessions.json') } = {}) {
  if (!root) throw new SessionError('ROOT_REQUIRED', 'root is required');
  const sessions = new Map();
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
        ids.add(raw.id);
        const interrupted = raw.running === true;
        const session = { id: raw.id, workspaceId: raw.workspaceId || root, mode: raw.mode, actor: raw.actor || 'user', status: interrupted ? 'manual_review' : raw.status === 'closed' ? 'closed' : 'active', createdAt: raw.createdAt || clock().toISOString(), messages: raw.messages.map((message) => Object.freeze({ ...message })), running: false, ...(interrupted ? { recoveryReason: 'interrupted_turn' } : {}) };
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
    const session = { id: randomUUID(), workspaceId, mode, actor, status: 'active', createdAt: clock().toISOString(), messages: [], running: false };
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
    session.running = true;
    const userMessage = Object.freeze({ role: 'user', content: message, createdAt: clock().toISOString() });
    session.messages.push(userMessage);
    try { persist(); } catch (error) { session.messages.pop(); session.running = false; throw error; }
    let primaryError;
    try {
      const response = await runAgentFn({ message, sessionKey: session.id, mode: session.mode, model, thinking, timeoutSeconds, local, signal });
      const assistantMessage = Object.freeze({ role: 'assistant', content: response, createdAt: clock().toISOString() });
      session.messages.push(assistantMessage);
      persist();
      return Object.freeze({ session: publicSession(session), message: assistantMessage });
    } catch (error) {
      primaryError = error;
      session.messages.pop();
      try { persist(); } catch (persistenceError) { attachPersistenceError(error, persistenceError); }
      throw error;
    } finally {
      session.running = false;
      try { persist(); } catch (persistenceError) {
        if (primaryError) attachPersistenceError(primaryError, persistenceError);
        else throw persistenceError;
      }
    }
  }

  async function planReview({ sessionId, question, models, thinking, timeoutSeconds } = {}) {
    const session = getSession(sessionId);
    if (session.status !== 'active') throw new SessionError('SESSION_NOT_ACTIVE', 'session is not active');
    if (session.mode !== 'Plan') throw new SessionError('MODE_INSUFFICIENT', 'plan review requires a Plan session');
    if (session.running) throw new SessionError('SESSION_BUSY', 'session already has a running turn');
    session.running = true;
    try { persist(); } catch (error) { session.running = false; throw error; }
    let primaryError;
    try { return await runPlanReview({ question, models, sessionKey: session.id, thinking, timeoutSeconds }); }
    catch (error) { primaryError = error; throw error; }
    finally {
      session.running = false;
      try { persist(); } catch (persistenceError) {
        if (primaryError) attachPersistenceError(primaryError, persistenceError);
        else throw persistenceError;
      }
    }
  }

  function listMessages(sessionId) {
    const session = getSession(sessionId);
    return Object.freeze(session.messages.map((message) => Object.freeze({ ...message })));
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

  return Object.freeze({ createSession, getSession: (id) => publicSession(getSession(id)), sendMessage, planReview, listMessages, closeSession, reviewSession, recoverySummary, snapshotPath: storePath });
}
